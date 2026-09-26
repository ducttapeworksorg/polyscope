import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { coreMethods, type CoreApi, type CoreEvents, type CoreMethod, type CoreResult } from '@shared/core-api'
import { CoreError } from './core/core-error'

const isCoreMethod = (value: unknown): value is CoreMethod => coreMethods.includes(value as CoreMethod)

/** Exposes the core API to the renderer. Errors travel as values so their code survives IPC. */
export function registerCoreIpc(core: CoreApi): void {
  ipcMain.handle('core', async (_event, method: unknown, args: unknown): Promise<CoreResult<unknown>> => {
    if (!isCoreMethod(method) || !Array.isArray(args)) {
      return { ok: false, code: 'UNKNOWN', message: `Unknown core call: ${String(method)}` }
    }
    try {
      const call = core[method] as (...a: unknown[]) => Promise<unknown>
      return { ok: true, value: await call(...args) }
    } catch (error) {
      if (error instanceof CoreError) return { ok: false, code: error.code, message: error.message }
      return { ok: false, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Forwards the core's events to whichever window is open. */
export function forwardCoreEvents(core: CoreEvents, getWindow: () => BrowserWindow | null): void {
  core.onSettingsChanged((settings) => getWindow()?.webContents.send('core:settingsChanged', settings))
}

export function registerShellIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('shell:pickFolder', async () => {
    const window = getWindow()
    const options = { properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
