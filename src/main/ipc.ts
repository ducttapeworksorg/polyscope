import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, dialog, ipcMain, type BrowserWindow, type FileFilter, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import type { CoreApi, CoreEvents, CoreResult, SaveCopyStarted } from '@shared/core-api'
import type { UpdateStatus } from '@shared/updates'
import type { AppLog } from './app-log'
import { callCore, resultOf } from './core-call'
import type { CoreSaves } from './core/core'
import { formatDiagnostics, osDescription } from './diagnostics'
import type { Updater } from './updates'

/** Exposes the core API to the renderer. */
export function registerCoreIpc(core: CoreApi, log: AppLog): void {
  ipcMain.handle('core', (_event, method: unknown, args: unknown) => callCore(core, log, method, args))
}

/** Forwards the core's events to whichever window is open. */
export function forwardCoreEvents(core: CoreEvents, getWindow: () => BrowserWindow | null): void {
  core.onSettingsChanged((settings) => getWindow()?.webContents.send('core:settingsChanged', settings))
  core.onConnectionEvent((event) => getWindow()?.webContents.send('core:connectionEvent', event))
  core.onFollowEvent((event) => getWindow()?.webContents.send('core:followEvent', event))
  core.onLargeFileEvent((event) => getWindow()?.webContents.send('core:largeFileEvent', event))
  core.onLargeFileSearchEvent((event) => getWindow()?.webContents.send('core:largeFileSearchEvent', event))
  core.onSaveCopyEvent((event) => getWindow()?.webContents.send('core:saveCopyEvent', event))
}

/**
 * "Save a copy…": asks where to save a Source's file, suggesting its name in the Downloads folder, then has the core
 * save it there. The renderer names the file to save, never where it goes: only the dialog the user answers does.
 */
export function registerSaveCopyIpc(core: CoreSaves, log: AppLog, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('shell:saveCopy', async (_event, sourceId: unknown, path: unknown): Promise<CoreResult<SaveCopyStarted | null>> => {
    if (typeof sourceId !== 'string' || typeof path !== 'string') return { ok: false, code: 'UNKNOWN', message: 'Not a file to save' }
    // Only its name, with nothing in it read as a folder here: the Source mustn't pick where it's suggested.
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/[\\/]/g, '_')
    const downloads = app.getPath('downloads')
    const window = getWindow()
    const options: SaveDialogOptions = { defaultPath: name && name !== '.' && name !== '..' ? join(downloads, name) : downloads }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: true, value: null }
    const target = result.filePath
    return resultOf(log, 'saveCopy', () => core.saveCopy(sourceId, path, target))
  })
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
  ipcMain.handle('shell:copyText', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
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
