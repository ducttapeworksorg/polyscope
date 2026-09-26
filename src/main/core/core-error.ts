import type { CoreErrorCode } from '@shared/core-api'

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CoreError'
  }
}
