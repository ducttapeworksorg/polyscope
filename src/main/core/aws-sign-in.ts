// How the Source Types on AWS (S3, CloudWatch Logs) sign in and reach it: typed keys or an AWS profile, SSO ones
// included, through the network settings they're given; and what the SDK's failures mean to the user.

import type { CoreErrorCode } from '@shared/core-api'
import { CoreError } from './core-error'
import { networkAgents, type NetworkSettings } from './network-agents'
import { certificateCodes, networkCodes } from './network-errors'

/** Typed keys, or the name of an AWS profile to sign in with: blank for the default credential chain. */
export type AwsCredentials = { accessKeyId: string; secretAccessKey: string } | { profile: string }

/** What an SDK client is given to sign in as `credentials` and go out through the agents `network` asks for. */
export const awsClientSettings = (credentials: AwsCredentials, network: NetworkSettings) => ({
  // Without keys or a profile the SDK goes down its default credential chain.
  ...('profile' in credentials ? credentials.profile && { profile: credentials.profile } : { credentials }),
  requestHandler: networkAgents(network)
})

// What every AWS service answers when it won't let the user in.
const signInCodes: Record<string, CoreErrorCode> = {
  AccessDenied: 'PERMISSION_DENIED',
  AccessDeniedException: 'PERMISSION_DENIED',
  InvalidAccessKeyId: 'AUTH_FAILED',
  SignatureDoesNotMatch: 'AUTH_FAILED',
  InvalidSignatureException: 'AUTH_FAILED',
  UnrecognizedClientException: 'AUTH_FAILED',
  InvalidToken: 'AUTH_FAILED',
  ExpiredToken: 'AUTH_FAILED',
  ExpiredTokenException: 'AUTH_FAILED'
}

// What the SDK throws when it can't come by credentials at all: a missing profile, an expired SSO session…
const credentialErrors = new Set(['CredentialsProviderError', 'TokenProviderError'])

const errorNameOf = (error: unknown) => (error instanceof Error ? error.name : '')

/** An AWS SDK failure about `what` as a CoreError, by the service's own `codes` for its errors, then those of signing in. */
export function awsErrorOf(error: unknown, what: string, codes: Record<string, CoreErrorCode> = {}): CoreError {
  if (error instanceof CoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = codes[errorNameOf(error)] ?? signInCodes[errorNameOf(error)]
  if (code) return new CoreError(code, `${what}: ${message || errorNameOf(error)}`)
  if (credentialErrors.has(errorNameOf(error))) return new CoreError('CREDENTIALS_UNAVAILABLE', message)
  const errno = (error as NodeJS.ErrnoException).code ?? ''
  if (networkCodes.has(errno)) return new CoreError('UNREACHABLE', `${what}: ${message}`)
  if (certificateCodes.has(errno)) return new CoreError('CERTIFICATE_UNTRUSTED', `${what}: ${message}`)
  return new CoreError('UNKNOWN', `${what}: ${message}`)
}
