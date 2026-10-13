import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException
} from '@aws-sdk/client-s3'
import type { CoreErrorCode } from '@shared/core-api'
import { awsClientSettings, awsErrorOf, type AwsCredentials } from './aws-sign-in'
import type { FileSource } from './file-source'
import type { NetworkSettings } from './network-agents'
import { createObjectStoreFileSource, type ObjectStore } from './object-store-file-source'

/** Where an S3 Source points and how it signs in, normalised and with its secret filled in. */
export interface S3Target extends NetworkSettings {
  /** A URL with its scheme, or blank for AWS itself. */
  host: string
  bucket: string
  /** No leading or trailing '/'; blank for the whole bucket. */
  prefix: string
  region: string
  pathStyle: boolean
  credentials: AwsCredentials
}

/** The most entries S3 lists in one request, and so in one page of the tree. */
export const s3PageSize = 1000

// S3 error codes (or, for bodiless HEAD responses, HTTP statuses) and what they mean to the user, beyond those of signing in.
const s3Codes: Record<string, CoreErrorCode> = {
  NoSuchKey: 'NOT_FOUND',
  NotFound: 'NOT_FOUND',
  NoSuchBucket: 'BUCKET_NOT_FOUND',
  Forbidden: 'PERMISSION_DENIED'
}

const toCoreError = (error: unknown, what: string) => awsErrorOf(error, what, s3Codes)

/** A File Source over the keys under a bucket's prefix, with key prefixes (up to a '/') shown as folders. */
export function createS3FileSource(target: S3Target, { pageSize = s3PageSize } = {}): FileSource {
  const { bucket, credentials } = target
  const client = new S3Client({
    ...(target.host && { endpoint: target.host }),
    region: target.region,
    forcePathStyle: target.pathStyle,
    ...awsClientSettings(credentials, target),
    // Checksums only where S3 insists: many S3-compatible stores don't support the newer ones.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
  const where = (key: string) => `s3://${bucket}/${key}`

  const send = async <T>(key: string, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      throw toCoreError(error, where(key))
    }
  }

  const store: ObjectStore = {
    async listPage(prefix, limit, cursor) {
      const page = await send(prefix, () =>
        client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: limit, ContinuationToken: cursor }))
      )
      return {
        prefixes: (page.CommonPrefixes ?? []).map(({ Prefix = '' }) => Prefix),
        objects: (page.Contents ?? []).map(({ Key = '', Size, LastModified }) => ({
          key: Key,
          ...(Size !== undefined && { size: Size }),
          ...(LastModified && { modifiedTime: LastModified })
        })),
        ...(page.IsTruncated && page.NextContinuationToken && { cursor: page.NextContinuationToken })
      }
    },

    async head(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return { kind: 'file', size: head.ContentLength ?? 0, modifiedTime: head.LastModified?.getTime() ?? 0 }
      } catch (error) {
        if (toCoreError(error, '').code === 'NOT_FOUND') return undefined
        throw toCoreError(error, where(key))
      }
    },

    async hasKeysUnder(prefix) {
      const listing = await send(prefix, () => client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })))
      return (listing.KeyCount ?? 0) > 0
    },

    async read(key, offset, length) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }))
        const bytes = (await object.Body?.transformToByteArray()) ?? new Uint8Array()
        // A store that ignores the range sends the whole object.
        return object.ContentRange ? bytes : bytes.subarray(offset, offset + length)
      } catch (error) {
        // A range starting at the end or beyond (including any range of an empty object) holds nothing.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 416) return new Uint8Array()
        throw toCoreError(error, where(key))
      }
    },

    where
  }
  return createObjectStoreFileSource(store, { prefix: target.prefix, pageSize })
}
