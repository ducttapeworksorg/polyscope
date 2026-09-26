import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { createCore } from './core/core'
import { createSecretStore } from './core/secret-store'
import { registerCoreIpc, registerShellIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

// Lets tests (and anyone keeping separate profiles) point the app at another user-data directory.
const userDataDir = app.commandLine.getSwitchValue('user-data-dir')
if (userDataDir) app.setPath('userData', userDataDir)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'Polyscope',
    backgroundColor: '#1b2230',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
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

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const cipher = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted)
  }
  registerCoreIpc(createCore({ dataDir, secrets: createSecretStore({ dataDir, cipher }) }))
  registerShellIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
