import { coreMethods, type CoreApi, type CoreMethod, type CoreResult } from '@shared/core-api'
import type { AppLog } from './app-log'
import { CoreError } from './core/core-error'

const isCoreMethod = (value: unknown): value is CoreMethod => coreMethods.includes(value as CoreMethod)

/**
 * Calls the core for a caller across a process boundary (the renderer over IPC, a webview over `postMessage`).
 * Errors travel as values so their code survives the trip; each is logged.
 */
export async function callCore(core: CoreApi, log: Pick<AppLog, 'warn' | 'error'>, method: unknown, args: unknown): Promise<CoreResult<unknown>> {
  if (!isCoreMethod(method) || !Array.isArray(args)) {
    return { ok: false, code: 'UNKNOWN', message: `Unknown core call: ${String(method)}` }
  }
  try {
    const call = core[method] as (...a: unknown[]) => Promise<unknown>
    return { ok: true, value: await call(...args) }
  } catch (error) {
    if (error instanceof CoreError) {
      log.warn(`${method} failed (${error.code})`, error.message)
      return { ok: false, code: error.code, message: error.message }
    }
    log.error(`${method} failed`, error)
    return { ok: false, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
  }
}
