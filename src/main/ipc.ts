import { homedir } from 'node:os'
import { app, clipboard, dialog, ipcMain, type BrowserWindow, type FileFilter, type OpenDialogOptions } from 'electron'
import type { CoreApi, CoreEvents } from '@shared/core-api'
import type { UpdateStatus } from '@shared/updates'
import type { AppLog } from './app-log'
import { callCore } from './core-call'
import { formatDiagnostics, osDescription } from './diagnostics'
import type { Updater } from './updates'

/** Exposes the core API to the renderer. */
export function registerCoreIpc(core: CoreApi, log: AppLog): void {
  ipcMain.handle('core', (_event, method: unknown, args: unknown) => callCore(core, log, method, args))
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

export function registerShellIpc(getWindow: () => BrowserWindow | null, { secretStorageIsWeak }: { secretStorageIsWeak: boolean }): void {
  const pick = async (options: OpenDialogOptions) => {
    const window = getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  ipcMain.handle('shell:pickFolder', () => pick({ properties: ['openDirectory'] }))
  ipcMain.handle('shell:pickFile', (_event, filters: unknown) =>
    pick({ properties: ['openFile'], filters: Array.isArray(filters) ? filters.filter(isFileFilter) : [] })
  )
  ipcMain.handle('shell:secretStorageIsWeak', () => secretStorageIsWeak)
}

/** "Copy diagnostics": puts the versions, OS and recent app log, redacted, on the clipboard for a GitHub issue. */
export function registerDiagnosticsIpc(log: AppLog): void {
  ipcMain.handle('diagnostics:copy', async () => {
    const report = formatDiagnostics({
      appVersion: app.getVersion(),
      os: osDescription(process.getSystemVersion()),
      versions: { Electron: process.versions.electron, Chromium: process.versions.chrome, 'Node.js': process.versions.node },
      homeDir: homedir(),
      log: await log.recent()
    })
    clipboard.writeText(report)
  })
}

/** Lets the renderer show and act on updates; a development build (no updater) says updates are off. */
export function registerUpdateIpc(updater: Updater | null, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updates:appVersion', () => app.getVersion())
  ipcMain.handle('updates:status', (): UpdateStatus => updater?.status() ?? { state: 'off' })
  ipcMain.handle('updates:check', () => updater?.check())
  ipcMain.handle('updates:apply', () => updater?.apply())
  updater?.onStatus((status) => getWindow()?.webContents.send('updates:status', status))
}
