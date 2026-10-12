import {
  BlobServiceClient,
  RestError,
  type ContainerClient,
  type ContainerListBlobFlatSegmentResponse,
  type ContainerListBlobHierarchySegmentResponse
} from '@azure/storage-blob'
import type { CoreErrorCode } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { certificateCodes, networkCodes } from './network-errors'
import { createObjectStoreFileSource, type ObjectStore } from './object-store-file-source'

/** Where an Azure Blob Storage Source points and how it signs in, normalised and with its secret filled in. */
export interface AzureBlobTarget {
  account: string
  container: string
  /** No leading or trailing '/'; blank for the whole container. */
  prefix: string
  /** Says where the account's blob endpoint is, and holds its key. */
  connectionString: string
}

/** The blobs listed in one page of the tree: as many as S3 lists, though Azure would list up to 5,000. */
export const azureBlobPageSize = 1000

// Azure Storage error codes and what they mean to the user.
const azureCodes: Record<string, CoreErrorCode> = {
  BlobNotFound: 'NOT_FOUND',
  ContainerNotFound: 'CONTAINER_NOT_FOUND',
  AuthenticationFailed: 'AUTH_FAILED',
  AuthorizationFailure: 'PERMISSION_DENIED',
  AuthorizationPermissionMismatch: 'PERMISSION_DENIED',
  AuthorizationSourceIPMismatch: 'PERMISSION_DENIED',
  AuthorizationProtocolMismatch: 'PERMISSION_DENIED',
  InsufficientAccountPermissions: 'PERMISSION_DENIED'
}

// How Azure starts the message of a request whose signature it couldn't check: a wrong key, whatever code comes with
// it (Azurite sends AuthorizationFailure).
const unauthenticated = 'Server failed to authenticate the request'

/** A RestError's message without the request id and time Azure adds on lines of their own. */
const firstLine = (message: string) => message.split('\n')[0]?.trim() ?? ''

function toCoreError(error: unknown, what: string): CoreError {
  if (error instanceof CoreError) return error
  const message = firstLine(error instanceof Error ? error.message : String(error))
  if (error instanceof RestError) {
    const code = message.startsWith(unauthenticated) ? 'AUTH_FAILED' : azureCodes[error.code ?? '']
    if (code) return new CoreError(code, `${what}: ${message || error.code}`)
    // A HEAD request's 404 has no body, so no code to say what's missing.
    if (error.statusCode === 404) return new CoreError('NOT_FOUND', `${what}: not found`)
    if (networkCodes.has(error.code ?? '')) return new CoreError('UNREACHABLE', `${what}: ${message}`)
    if (certificateCodes.has(error.code ?? '')) return new CoreError('CERTIFICATE_UNTRUSTED', `${what}: ${message}`)
  }
  return new CoreError('UNKNOWN', `${what}: ${message}`)
}

/**
 * The storage account a connection string reaches, without connecting yet: INVALID_CONNECTION_STRING if it can't be
 * made sense of, or names an account other than `account` (one reaching the account by its endpoint alone names none).
 */
export function serviceClientOf(connectionString: string, account: string): BlobServiceClient {
  let service: BlobServiceClient
  try {
    // A few quick retries: an address that doesn't answer shouldn't take half a minute to report.
    service = BlobServiceClient.fromConnectionString(connectionString, { retryOptions: { maxTries: 3, retryDelayInMs: 200, maxRetryDelayInMs: 1000 } })
  } catch (error) {
    throw new CoreError('INVALID_CONNECTION_STRING', `Not a storage account connection string: ${firstLine(error instanceof Error ? error.message : String(error))}`)
  }
  const named = /(?:^|;)\s*AccountName=([^;]*)/i.exec(connectionString)?.[1]?.trim()
  if (named && named.toLowerCase() !== account.toLowerCase()) {
    throw new CoreError('INVALID_CONNECTION_STRING', `The connection string is for the storage account ${named}, not ${account}`)
  }
  return service
}

/** A blob marked as a directory, as an account with a hierarchical namespace (Data Lake Gen2) lists its directories. */
const isDirectory = (metadata: Record<string, string> | undefined) => metadata?.['hdi_isfolder'] === 'true'

/**
 * A File Source over the blobs under a container's prefix, with name prefixes (up to a '/') shown as folders. A Data
 * Lake account's directories are read through the same Blob endpoint, as the folders they are.
 */
export function createAzureBlobFileSource(target: AzureBlobTarget, { pageSize = azureBlobPageSize } = {}): FileSource {
  const client: ContainerClient = serviceClientOf(target.connectionString, target.account).getContainerClient(target.container)
  const where = (key: string) => `${target.account}/${target.container}/${key}`

  const send = async <T>(key: string, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      throw toCoreError(error, where(key))
    }
  }

  const store: ObjectStore = {
    async listPage(prefix, limit, cursor) {
      const { value: page }: { value: ContainerListBlobHierarchySegmentResponse } = await send(prefix, () =>
        client
          .listBlobsByHierarchy('/', { prefix, includeMetadata: true })
          .byPage({ maxPageSize: limit, ...(cursor && { continuationToken: cursor }) })
          .next()
      )
      const { blobPrefixes, blobItems } = page.segment
      const prefixes = new Set((blobPrefixes ?? []).map(({ name }) => name))
      const objects = []
      for (const { name, metadata, properties } of blobItems) {
        // A directory is a folder, whether or not anything's in it: listed once, alongside its name prefix if it has one.
        if (isDirectory(metadata)) prefixes.add(`${name}/`)
        else objects.push({ key: name, size: properties.contentLength ?? 0, modifiedTime: properties.lastModified })
      }
      return { prefixes: [...prefixes], objects, ...(page.continuationToken && { cursor: page.continuationToken }) }
    },

    async head(key) {
      try {
        const properties = await client.getBlobClient(key).getProperties()
        if (isDirectory(properties.metadata)) return { kind: 'folder' }
        return { kind: 'file', size: properties.contentLength ?? 0, modifiedTime: properties.lastModified?.getTime() ?? 0 }
      } catch (error) {
        if (toCoreError(error, '').code === 'NOT_FOUND') return undefined
        throw toCoreError(error, where(key))
      }
    },

    async hasKeysUnder(prefix) {
      const { value: page }: { value: ContainerListBlobFlatSegmentResponse } = await send(prefix, () => client.listBlobsFlat({ prefix }).byPage({ maxPageSize: 1 }).next())
      return page.segment.blobItems.length > 0
    },

    async read(key, offset, length) {
      try {
        const download = await client.getBlobClient(key).download(offset, length)
        const chunks: Buffer[] = []
        for await (const chunk of download.readableStreamBody ?? []) chunks.push(chunk as Buffer)
        return new Uint8Array(Buffer.concat(chunks))
      } catch (error) {
        // A range starting at the end or beyond (including any range of an empty blob) holds nothing.
        if (error instanceof RestError && error.statusCode === 416) return new Uint8Array()
        throw toCoreError(error, where(key))
      }
    },

    where
  }
  return createObjectStoreFileSource(store, { prefix: target.prefix, pageSize })
}
