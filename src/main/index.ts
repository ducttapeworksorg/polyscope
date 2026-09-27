import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, safeStorage, shell } from 'electron'
import type { Theme } from '@shared/settings'
import { createCore } from './core/core'
import { createSecretStore } from './core/secret-store'
import { forwardCoreEvents, registerCoreIpc, registerShellIpc } from './ipc'
import { loadLoginShellPath } from './login-shell-path'

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

function createWindow(theme: Theme): void {
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.on('closed', () => (mainWindow = null))

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
  await loginShellPathLoaded
  const dataDir = app.getPath('userData')
  const cipher = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted)
  }
  const core = createCore({ dataDir, secrets: createSecretStore({ dataDir, cipher }) })
  registerCoreIpc(core)
  registerShellIpc(() => mainWindow)
  forwardCoreEvents(core, () => mainWindow)
  core.onSettingsChanged(({ theme }) => applyNativeTheme(theme))
  const { theme } = await core.getSettings()
  applyNativeTheme(theme)
  createWindow(theme)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void core.getSettings().then((settings) => createWindow(settings.theme))
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
