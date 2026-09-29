import { homedir } from 'node:os'
import { app, clipboard, dialog, ipcMain, type BrowserWindow, type FileFilter, type OpenDialogOptions } from 'electron'
import { coreMethods, type CoreApi, type CoreEvents, type CoreMethod, type CoreResult } from '@shared/core-api'
import type { AppLog } from './app-log'
import { CoreError } from './core/core-error'
import { formatDiagnostics } from './diagnostics'

const isCoreMethod = (value: unknown): value is CoreMethod => coreMethods.includes(value as CoreMethod)

/** Exposes the core API to the renderer. Errors travel as values so their code survives IPC; each is logged. */
export function registerCoreIpc(core: CoreApi, log: AppLog): void {
  ipcMain.handle('core', async (_event, method: unknown, args: unknown): Promise<CoreResult<unknown>> => {
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
  })
}

/** Forwards the core's events to whichever window is open. */
export function forwardCoreEvents(core: CoreEvents, getWindow: () => BrowserWindow | null): void {
  core.onSettingsChanged((settings) => getWindow()?.webContents.send('core:settingsChanged', settings))
  core.onFollowEvent((event) => getWindow()?.webContents.send('core:followEvent', event))
  core.onLargeFileEvent((event) => getWindow()?.webContents.send('core:largeFileEvent', event))
  core.onLargeFileSearchEvent((event) => getWindow()?.webContents.send('core:largeFileSearchEvent', event))
}

const isFileFilter = (value: unknown): value is FileFilter =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as FileFilter).name === 'string' &&
  Array.isArray((value as FileFilter).extensions) &&
  (value as FileFilter).extensions.every((e) => typeof e === 'string')

export function registerShellIpc(getWindow: () => BrowserWindow | null): void {
  const pick = async (options: OpenDialogOptions) => {
    const window = getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  ipcMain.handle('shell:pickFolder', () => pick({ properties: ['openDirectory'] }))
  ipcMain.handle('shell:pickFile', (_event, filters: unknown) =>
    pick({ properties: ['openFile'], filters: Array.isArray(filters) ? filters.filter(isFileFilter) : [] })
  )
}

const osNames: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** "Copy diagnostics": puts the versions, OS and recent app log, redacted, on the clipboard for a GitHub issue. */
export function registerDiagnosticsIpc(log: AppLog): void {
  ipcMain.handle('diagnostics:copy', async () => {
    const report = formatDiagnostics({
      appVersion: app.getVersion(),
      os: `${osNames[process.platform] ?? process.platform} ${process.getSystemVersion()} (${process.arch})`,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      homeDir: homedir(),
      log: await log.recent()
    })
    clipboard.writeText(report)
  })
}
