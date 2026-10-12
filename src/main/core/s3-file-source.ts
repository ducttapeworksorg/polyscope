import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException
} from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { getCACertificates } from 'node:tls'
import type { CoreErrorCode } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { certificateCodes, networkCodes } from './network-errors'
import { createObjectStoreFileSource, type ObjectStore } from './object-store-file-source'

/** Where an S3 Source points and how it signs in, normalised and with its secret filled in. */
export interface S3Target {
  /** A URL with its scheme, or blank for AWS itself. */
  host: string
  bucket: string
  /** No leading or trailing '/'; blank for the whole bucket. */
  prefix: string
  region: string
  pathStyle: boolean
  /** Typed keys, or the name of an AWS profile to sign in with: blank for the default credential chain. */
  credentials: { accessKeyId: string; secretAccessKey: string } | { profile: string }
  verifyTls: boolean
  /** PEM CA certificates to trust as well as Node's own and the OS trust store. */
  caBundle?: string
  /** A proxy for every request; blank to follow HTTPS_PROXY / NO_PROXY. */
  proxyUrl: string
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

// What the SDK throws when it can't come by credentials at all: a missing profile, an expired SSO session…
const credentialErrors = new Set(['CredentialsProviderError', 'TokenProviderError'])

const nameOf = (error: unknown) => (error instanceof Error ? error.name : '')

function toCoreError(error: unknown, what: string): CoreError {
  if (error instanceof CoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = s3Codes[nameOf(error)]
  if (code) return new CoreError(code, `${what}: ${message || nameOf(error)}`)
  if (credentialErrors.has(nameOf(error))) return new CoreError('CREDENTIALS_UNAVAILABLE', message)
  const errno = (error as NodeJS.ErrnoException).code ?? ''
  if (networkCodes.has(errno)) return new CoreError('UNREACHABLE', `${what}: ${message}`)
  if (certificateCodes.has(errno)) return new CoreError('CERTIFICATE_UNTRUSTED', `${what}: ${message}`)
  return new CoreError('UNKNOWN', `${what}: ${message}`)
}

/** Reads a CA bundle, which must hold at least one PEM certificate. */
export async function readCaBundle(path: string) {
  let bundle: string
  try {
    bundle = await readFile(path, 'utf8')
  } catch (error) {
    throw new CoreError('CA_BUNDLE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  if (!bundle.includes('-----BEGIN CERTIFICATE-----')) throw new CoreError('CA_BUNDLE_UNREADABLE', `No PEM certificates in ${path}`)
  return bundle
}

/** The agents requests go out through: trusting Node's CAs, the OS's and the target's own, and via its proxy. */
function agentsFor({ verifyTls, caBundle, proxyUrl }: S3Target) {
  // A proxy of the Source's own takes every request; otherwise the environment's settings, as they are now, decide.
  const proxyEnv = proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : { ...process.env }
  const ca = [...new Set([...getCACertificates('default'), ...getCACertificates('system')]), ...(caBundle ? [caBundle] : [])]
  return {
    httpAgent: new HttpAgent({ keepAlive: true, proxyEnv }),
    httpsAgent: new HttpsAgent({ keepAlive: true, proxyEnv, ca, rejectUnauthorized: verifyTls })
  }
}

/** A File Source over the keys under a bucket's prefix, with key prefixes (up to a '/') shown as folders. */
export function createS3FileSource(target: S3Target, { pageSize = s3PageSize } = {}): FileSource {
  const { bucket, credentials } = target
  const client = new S3Client({
    ...(target.host && { endpoint: target.host }),
    region: target.region,
    forcePathStyle: target.pathStyle,
    // Without keys or a profile the SDK goes down its default credential chain.
    ...('profile' in credentials ? credentials.profile && { profile: credentials.profile } : { credentials }),
    requestHandler: agentsFor(target),
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
