import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, safeStorage, shell } from 'electron'
import type { Theme } from '@shared/settings'
import { createAppLog, type AppLog } from './app-log'
import { createCore } from './core/core'
import { createSecretStore } from './core/secret-store'
import { forwardCoreEvents, registerCoreIpc, registerDiagnosticsIpc, registerShellIpc, registerUpdateIpc } from './ipc'
import { loadLoginShellPath } from './login-shell-path'
import { createUpdateEngine } from './update-engines'
import { createUpdater } from './updates'

let mainWindow: BrowserWindow | null = null

// Started straight away, so the shell runs while Electron gets ready; Sources only connect once it's done.
const loginShellPathLoaded = loadLoginShellPath()

// Lets tests (and anyone keeping separate profiles) point the app at another user-data directory.
const userDataDir = app.commandLine.getSwitchValue('user-data-dir')
if (userDataDir) app.setPath('userData', userDataDir)

// The window's colour before the renderer paints, matching the editor well of each theme in app.css.
const backgroundColor: Record<Theme, string> = { dark: '#1b2230', light: '#fbfcfd' }

/** Makes native chrome (title bar, OS dialogs) and the window background follow the app's theme. */
function applyNativeTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  mainWindow?.setBackgroundColor(backgroundColor[theme])
}

/**
 * Starts the app log in the user-data directory, noting the start and anything that goes wrong beyond a core
 * call (which the IPC layer logs itself). Only ever read back by "Copy diagnostics": nothing is sent anywhere.
 */
function startAppLog(): AppLog {
  const log = createAppLog({ dir: join(app.getPath('userData'), 'logs') })
  log.info(`Polyscope ${app.getVersion()} started (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`)
  // The monitor only observes, so uncaught exceptions still end the app as they would otherwise.
  process.on('uncaughtExceptionMonitor', (error) => log.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))
  app.on('render-process-gone', (_event, _contents, details) => log.error(`Renderer gone: ${details.reason} (exit code ${details.exitCode})`))
  app.on('child-process-gone', (_event, details) => log.error(`${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`))
  return log
}

function createWindow(theme: Theme, log: AppLog): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'Polyscope',
    backgroundColor: backgroundColor[theme],
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Shown once it has painted; ready-to-show sometimes never comes, leaving the window hidden for good, so
  // the page finishing loading shows it too. The background colour matches the theme, so there's no flash.
  let shown = false
  const show = () => {
    if (shown || !mainWindow) return
    shown = true
    mainWindow.show()
    mainWindow.maximize()
  }
  mainWindow.once('ready-to-show', show)
  mainWindow.webContents.once('did-finish-load', show)
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') log.warn(`Renderer: ${message}`)
  })

  // The renderer never navigates; anything that tries to is sent to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(async () => {
  const log = startAppLog()
  await loginShellPathLoaded
  const dataDir = app.getPath('userData')
  const cipher = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted)
  }
  const core = createCore({ dataDir, secrets: createSecretStore({ dataDir, cipher }) })
  registerCoreIpc(core, log)
  registerShellIpc(() => mainWindow)
  registerDiagnosticsIpc(log)
  // Only an installed build updates itself; one run from source is whatever was checked out.
  const updater = app.isPackaged ? createUpdater({ engine: createUpdateEngine(log), log }) : null
  registerUpdateIpc(updater, () => mainWindow)
  forwardCoreEvents(core, () => mainWindow)
  core.onSettingsChanged(({ theme }) => applyNativeTheme(theme))
  const { theme } = await core.getSettings()
  applyNativeTheme(theme)
  createWindow(theme, log)
  updater?.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void core.getSettings().then((settings) => createWindow(settings.theme, log))
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
