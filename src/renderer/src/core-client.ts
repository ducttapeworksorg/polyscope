import type { CoreApi, CoreErrorCode, CoreMethod } from '@shared/core-api'
import { t } from './i18n'

export class CoreCallError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string
  ) {
    super(message)
  }
}

function call<M extends CoreMethod>(method: M) {
  return async (...args: Parameters<CoreApi[M]>): Promise<Awaited<ReturnType<CoreApi[M]>>> => {
    const result = await window.polyscope.invokeCore(method, args)
    if (!result.ok) throw new CoreCallError(result.code, result.message)
    return result.value as Awaited<ReturnType<CoreApi[M]>>
  }
}

/** The core API as seen from the renderer: every call crosses IPC to the main process. */
export const core: CoreApi = {
  listSources: call('listSources'),
  addSource: call('addSource'),
  editSource: call('editSource'),
  duplicateSource: call('duplicateSource'),
  deleteSource: call('deleteSource'),
  moveSource: call('moveSource'),
  moveSourceGroup: call('moveSourceGroup'),
  connectionState: call('connectionState'),
  connect: call('connect'),
  testConnection: call('testConnection'),
  disconnect: call('disconnect'),
  expand: call('expand'),
  openFile: call('openFile')
}

/** A user-facing message for a failure the core reported, thrown or not. */
export const describeFailure = ({ code, message }: { code: CoreErrorCode; message: string }) =>
  t(`error.${code}`, { message })

/** A user-facing message for anything a core call threw. */
export function describeError(error: unknown): string {
  if (error instanceof CoreCallError) return describeFailure(error)
  return describeFailure({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) })
}
