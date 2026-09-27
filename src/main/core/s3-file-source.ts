import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException
} from '@aws-sdk/client-s3'
import type { CoreErrorCode, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileEntry, FileSource, FileStat } from './file-source'

/** Where an S3 Source points and how it signs in, normalised and with its secret filled in. */
export interface S3Target {
  /** A URL with its scheme, or blank for AWS itself. */
  host: string
  bucket: string
  /** No leading or trailing '/'; blank for the whole bucket. */
  prefix: string
  region: string
  pathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
}

/** The most entries S3 lists in one request, and so in one page of the tree. */
export const s3PageSize = 1000

// S3 error codes (or, for bodiless HEAD responses, HTTP statuses) and what they mean to the user.
const s3Codes: Record<string, CoreErrorCode> = {
  NoSuchKey: 'NOT_FOUND',
  NotFound: 'NOT_FOUND',
  NoSuchBucket: 'BUCKET_NOT_FOUND',
  AccessDenied: 'PERMISSION_DENIED',
  Forbidden: 'PERMISSION_DENIED',
  InvalidAccessKeyId: 'AUTH_FAILED',
  SignatureDoesNotMatch: 'AUTH_FAILED',
  InvalidToken: 'AUTH_FAILED',
  ExpiredToken: 'AUTH_FAILED'
}

// Failures to reach the store at all, as Node reports them.
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

const isWholeNumber = (n: number) => Number.isSafeInteger(n) && n >= 0

/**
 * A modified time to the second: listings give milliseconds but HEAD's Last-Modified header only
 * seconds, and a file's time shouldn't change between the tree and the opened file.
 */
const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000) * 1000

const nameOf = (error: unknown) => (error instanceof Error ? error.name : '')

function toCoreError(error: unknown, what: string): CoreError {
  if (error instanceof CoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = s3Codes[nameOf(error)]
  if (code) return new CoreError(code, `${what}: ${message || nameOf(error)}`)
  if (networkCodes.has((error as NodeJS.ErrnoException).code ?? '')) return new CoreError('UNREACHABLE', `${what}: ${message}`)
  return new CoreError('UNKNOWN', `${what}: ${message}`)
}

/** A File Source over the keys under a bucket's prefix, with key prefixes (up to a '/') shown as folders. */
export function createS3FileSource(target: S3Target, { pageSize = s3PageSize } = {}): FileSource {
  const { bucket } = target
  const client = new S3Client({
    ...(target.host && { endpoint: target.host }),
    region: target.region,
    forcePathStyle: target.pathStyle,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    // Checksums only where S3 insists: many S3-compatible stores don't support the newer ones.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
  const root = target.prefix ? `${target.prefix}/` : ''
  const keyOf = (path: SourcePath) => root + path
  const folderKeyOf = (path: SourcePath) => (path ? `${root}${path}/` : root)
  const where = (path: SourcePath) => `s3://${bucket}/${keyOf(path)}`

  const send = async <T>(path: SourcePath, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      throw toCoreError(error, where(path))
    }
  }

  /** Whether any key lies under the folder `path` (a zero-byte `path/` marker counts). */
  const isFolder = async (path: SourcePath) => {
    if (!path) return true
    const listing = await send(path, () =>
      client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: folderKeyOf(path), MaxKeys: 1 }))
    )
    return (listing.KeyCount ?? 0) > 0
  }

  /** The error for `path` not being a file: it's a folder, or nothing at all. */
  const notAFile = async (path: SourcePath) =>
    (await isFolder(path))
      ? new CoreError('NOT_A_FILE', `Not a file: ${where(path)}`)
      : new CoreError('NOT_FOUND', `No such object: ${where(path)}`)

  const stat = async (path: SourcePath): Promise<FileStat> => {
    if (!path) return { kind: 'folder' }
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyOf(path) }))
      return { kind: 'file', size: head.ContentLength ?? 0, modifiedTime: head.LastModified ? toSeconds(head.LastModified) : 0 }
    } catch (error) {
      if (toCoreError(error, '').code !== 'NOT_FOUND') throw toCoreError(error, where(path))
    }
    if (await isFolder(path)) return { kind: 'folder' }
    throw new CoreError('NOT_FOUND', `No such object: ${where(path)}`)
  }

  return {
    async listChildren(path, cursor) {
      const folderKey = folderKeyOf(path)
      const page = await send(path, () =>
        client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: folderKey, Delimiter: '/', MaxKeys: pageSize, ContinuationToken: cursor })
        )
      )
      const nameIn = (key: string) => key.slice(folderKey.length).replace(/\/$/, '')
      const folders = (page.CommonPrefixes ?? []).map(({ Prefix = '' }): FileEntry => ({ kind: 'folder', name: nameIn(Prefix) }))
      // The folder's own marker, if it has one, isn't one of its entries.
      const objects = (page.Contents ?? []).filter(({ Key }) => Key !== folderKey)
      const files = objects.map(
        ({ Key = '', Size, LastModified }): FileEntry => ({
          kind: 'file',
          name: nameIn(Key),
          ...(Size !== undefined && { size: Size }),
          ...(LastModified && { modifiedTime: toSeconds(LastModified) })
        })
      )
      // Keys like `a//b` would make a folder with no name, which no path could reach.
      const entries = [...folders, ...files].filter((e) => e.name)
      if (path && !cursor && (page.KeyCount ?? 0) === 0) {
        throw (await stat(path)).kind === 'file'
          ? new CoreError('NOT_A_FOLDER', `Not a folder: ${where(path)}`)
          : new CoreError('NOT_FOUND', `No such folder: ${where(path)}`)
      }
      return page.IsTruncated && page.NextContinuationToken ? { entries, cursor: page.NextContinuationToken } : { entries }
    },

    stat,

    async read(path, { offset, length }) {
      if (!isWholeNumber(offset) || !isWholeNumber(length)) {
        throw new CoreError('INVALID_RANGE', `Not a valid byte range: offset ${offset}, length ${length}`)
      }
      if (length === 0) {
        if ((await stat(path)).kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${where(path)}`)
        return new Uint8Array()
      }
      try {
        const object = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: keyOf(path), Range: `bytes=${offset}-${offset + length - 1}` })
        )
        const bytes = (await object.Body?.transformToByteArray()) ?? new Uint8Array()
        // A store that ignores the range sends the whole object.
        return object.ContentRange ? bytes : bytes.subarray(offset, offset + length)
      } catch (error) {
        // A range starting at the end or beyond (including any range of an empty object) holds nothing.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 416) return new Uint8Array()
        if (toCoreError(error, '').code === 'NOT_FOUND') throw await notAFile(path)
        throw toCoreError(error, where(path))
      }
    }
  }
}
