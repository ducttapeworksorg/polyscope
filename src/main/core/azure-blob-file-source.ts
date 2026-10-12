import { DefaultAzureCredential } from '@azure/identity'
import {
  BlobServiceClient,
  RestError,
  type ContainerClient,
  type ContainerListBlobFlatSegmentResponse,
  type ContainerListBlobHierarchySegmentResponse,
  type StoragePipelineOptions
} from '@azure/storage-blob'
import { parseSas, type Sas } from '@shared/azure-sas'
import type { CoreErrorCode } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { certificateCodes, networkCodes } from './network-errors'
import { createObjectStoreFileSource, type ObjectStore } from './object-store-file-source'

/**
 * How an Azure Blob Storage Source signs in, with its secret filled in: a connection string, a SAS URL or token, or
 * as the user, through Azure's default credential chain (`az login`, `AZURE_*` variables, a managed identity).
 */
export type AzureBlobSignIn = { connectionString: string } | { sas: string } | { azureCli: true }

/** Where an Azure Blob Storage Source points and how it signs in, normalised and with its secret filled in. */
export interface AzureBlobTarget {
  account: string
  container: string
  /** No leading or trailing '/'; blank for the whole container. */
  prefix: string
  /** The account's blob endpoint, when signing in with a SAS token or as the user; blank for Azure's own. */
  endpoint?: string
  signIn: AzureBlobSignIn
}

/** The blobs listed in one page of the tree: as many as S3 lists, though Azure would list up to 5,000. */
export const azureBlobPageSize = 1000

/** The role a user signing in as themselves needs to list and read blobs, as Azure names it. */
export const readerRole = 'Storage Blob Data Reader'

// Azure Storage error codes and what they mean to the user.
const azureCodes: Record<string, CoreErrorCode> = {
  BlobNotFound: 'NOT_FOUND',
  ContainerNotFound: 'CONTAINER_NOT_FOUND',
  AuthenticationFailed: 'AUTH_FAILED',
  InvalidAuthenticationInfo: 'AUTH_FAILED',
  NoAuthenticationInformation: 'AUTH_FAILED',
  AuthorizationFailure: 'PERMISSION_DENIED',
  AuthorizationPermissionMismatch: 'PERMISSION_DENIED',
  AuthorizationSourceIPMismatch: 'PERMISSION_DENIED',
  AuthorizationProtocolMismatch: 'PERMISSION_DENIED',
  InsufficientAccountPermissions: 'PERMISSION_DENIED'
}

// How Azure starts the message of a request whose signature it couldn't check: a wrong key, whatever code comes with
// it (Azurite sends AuthorizationFailure).
const unauthenticated = 'Server failed to authenticate the request'

// What Azure Identity throws when no credential in the chain gives a token.
const credentialErrors = new Set(['CredentialUnavailableError', 'AggregateAuthenticationError', 'AuthenticationError'])

/** A RestError's message without the request id and time Azure adds on lines of their own. */
const firstLine = (message: string) => message.split('\n')[0]?.trim() ?? ''

/** How a Source signs in and where it reaches, as far as making sense of an error goes. */
interface ErrorContext {
  signIn: AzureBlobSignIn
  /** Whether the endpoint is named after the account, as Azure's are: then nothing answering to the name means no such account. */
  namedAfterAccount: boolean
}

function toCoreError(error: unknown, what: string, { signIn, namedAfterAccount }: ErrorContext): CoreError {
  if (error instanceof CoreError) return error
  const full = error instanceof Error ? error.message : String(error)
  const message = firstLine(full)
  if (error instanceof Error && credentialErrors.has(error.name)) {
    // Azure CLI says to run az login when there's no sign-in, or it has expired; and when it isn't installed at all.
    if (/az login/.test(full) && !/could not be found/.test(full)) {
      return new CoreError('AZURE_LOGIN_REQUIRED', 'Your Azure CLI sign-in has expired, or there isn’t one: run az login again')
    }
    return new CoreError('CREDENTIALS_UNAVAILABLE', full.replace(/\s+/g, ' ').trim())
  }
  if (error instanceof RestError) {
    const code = message.startsWith(unauthenticated) ? 'AUTH_FAILED' : azureCodes[error.code ?? '']
    // A SAS past its expiry, or its stored access policy's, as Azure tells it.
    if (code === 'AUTH_FAILED' && 'sas' in signIn && /time frame|expired/i.test(full)) {
      return new CoreError('SAS_EXPIRED', `${what}: ${message}`)
    }
    // Signed in as the user, a request lacking permission (not one from the wrong network, say) lacks the user's role.
    if ((error.code === 'AuthorizationPermissionMismatch' || error.code === 'InsufficientAccountPermissions') && 'azureCli' in signIn) {
      return new CoreError('ROLE_REQUIRED', `${what}: your Azure identity needs the ${readerRole} role on the account or container (${message})`)
    }
    if (code) return new CoreError(code, `${what}: ${message || error.code}`)
    // A HEAD request's 404 has no body, so no code to say what's missing.
    if (error.statusCode === 404) return new CoreError('NOT_FOUND', `${what}: not found`)
    // Every account has a name of its own on Azure, so one that isn't there has no address.
    if (error.code === 'ENOTFOUND' && namedAfterAccount) return new CoreError('ACCOUNT_NOT_FOUND', `${what}: no storage account answers there (${message})`)
    if (networkCodes.has(error.code ?? '')) return new CoreError('UNREACHABLE', `${what}: ${message}`)
    if (certificateCodes.has(error.code ?? '')) return new CoreError('CERTIFICATE_UNTRUSTED', `${what}: ${message}`)
  }
  return new CoreError('UNKNOWN', `${what}: ${message}`)
}

// A few quick retries: an address that doesn't answer shouldn't take half a minute to report.
const pipelineOptions: StoragePipelineOptions = { retryOptions: { maxTries: 3, retryDelayInMs: 200, maxRetryDelayInMs: 1000 } }

/**
 * Checks a connection string without connecting: INVALID_CONNECTION_STRING if it can't be made sense of, or names an
 * account other than `account` (one reaching the account by its endpoint alone names none).
 */
export function checkConnectionString(connectionString: string, account: string): BlobServiceClient {
  let service: BlobServiceClient
  try {
    service = BlobServiceClient.fromConnectionString(connectionString, pipelineOptions)
  } catch (error) {
    throw new CoreError('INVALID_CONNECTION_STRING', `Not a storage account connection string: ${firstLine(error instanceof Error ? error.message : String(error))}`)
  }
  const named = /(?:^|;)\s*AccountName=([^;]*)/i.exec(connectionString)?.[1]?.trim()
  if (named && named.toLowerCase() !== account.toLowerCase()) {
    throw new CoreError('INVALID_CONNECTION_STRING', `The connection string is for the storage account ${named}, not ${account}`)
  }
  return service
}

/**
 * Checks a SAS URL or token without connecting: INVALID_SAS if it isn't one, or a URL for another account or
 * container than the Source's.
 */
export function checkSas(input: string, account: string, container: string): Sas {
  const sas = parseSas(input)
  if (!sas) throw new CoreError('INVALID_SAS', 'Not a SAS URL or token: it has no signature (sig=)')
  if (sas.account && sas.account.toLowerCase() !== account.toLowerCase()) {
    throw new CoreError('INVALID_SAS', `The SAS URL is for the storage account ${sas.account}, not ${account}`)
  }
  if (sas.container && sas.container !== container) {
    throw new CoreError('INVALID_SAS', `The SAS URL is for the container ${sas.container}, not ${container}`)
  }
  return sas
}

/** The storage account a Source reaches, signed in the way it says, without connecting yet. */
function serviceClientOf({ account, container, endpoint, signIn }: AzureBlobTarget): BlobServiceClient {
  const azure = endpoint || `https://${account}.blob.core.windows.net`
  if ('connectionString' in signIn) return checkConnectionString(signIn.connectionString, account)
  if ('azureCli' in signIn) return new BlobServiceClient(azure, new DefaultAzureCredential(), pipelineOptions)
  const sas = checkSas(signIn.sas, account, container)
  // Only now, connecting: a Source whose SAS has expired can still be saved, renamed or given a new one.
  if (sas.expiresOn && sas.expiresOn.getTime() <= Date.now()) {
    throw new CoreError('SAS_EXPIRED', `The SAS expired on ${sas.expiresOn.toISOString()}`)
  }
  return new BlobServiceClient(`${sas.endpoint ?? azure}?${sas.token}`, undefined, pipelineOptions)
}

/** A blob marked as a directory, as an account with a hierarchical namespace (Data Lake Gen2) lists its directories. */
const isDirectory = (metadata: Record<string, string> | undefined) => metadata?.['hdi_isfolder'] === 'true'

/**
 * A File Source over the blobs under a container's prefix, with name prefixes (up to a '/') shown as folders. A Data
 * Lake account's directories are read through the same Blob endpoint, as the folders they are.
 */
export function createAzureBlobFileSource(target: AzureBlobTarget, { pageSize = azureBlobPageSize } = {}): FileSource {
  const service = serviceClientOf(target)
  const client: ContainerClient = service.getContainerClient(target.container)
  const context: ErrorContext = { signIn: target.signIn, namedAfterAccount: /^[^.]+\.(?:blob|dfs)\./i.test(new URL(service.url).hostname) }
  const where = (key: string) => `${target.account}/${target.container}/${key}`

  const send = async <T>(key: string, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      throw toCoreError(error, where(key), context)
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
        if (toCoreError(error, '', context).code === 'NOT_FOUND') return undefined
        throw toCoreError(error, where(key), context)
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
        throw toCoreError(error, where(key), context)
      }
    },

    where
  }
  return createObjectStoreFileSource(store, { prefix: target.prefix, pageSize })
}
