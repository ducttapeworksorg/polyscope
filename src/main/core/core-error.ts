import type { CoreErrorCode, HostKey } from '@shared/core-api'

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
    /** The host key a HOST_KEY_UNKNOWN failure offers the user to trust. */
    readonly hostKey?: HostKey
  ) {
    super(message)
    this.name = 'CoreError'
  }
}
