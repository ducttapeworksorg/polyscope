import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppLog } from './app-log'
import { findNewerRelease, updateMode, type Release, type UpdateEngine } from './updates'

/** Where releases are published; electron-builder.yml publishes to the same repository. */
const repository = 'ducttapeworksorg/polyscope'

/** The Linux package this install came from, which electron-builder records beside the app. */
function packageType(): string | undefined {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return undefined
  }
}

/** electron-updater: downloads a newer release in the background, then restarts into it when asked. */
function installEngine(log: AppLog): UpdateEngine {
  const prefixed = (message: unknown) => `Updater: ${String(message)}`
  autoUpdater.logger = {
    info: (message) => log.info(prefixed(message)),
    warn: (message) => log.warn(prefixed(message)),
    error: (message) => log.error(prefixed(message))
  }
  autoUpdater.autoDownload = true
  // Installing a .deb or .rpm asks for the administrator password, which would be a surprise on quitting.
  autoUpdater.autoInstallOnAppQuit = false
  return {
    check: async (report) => {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable || !result.downloadPromise) return
      const { version } = result.updateInfo
      report({ state: 'downloading', version, percent: 0 })
      const progress = ({ percent }: { percent: number }) => report({ state: 'downloading', version, percent: Math.floor(percent) })
      autoUpdater.on('download-progress', progress)
      try {
        await result.downloadPromise
      } finally {
        autoUpdater.off('download-progress', progress)
      }
      report({ state: 'ready', version })
    },
    apply: () => autoUpdater.quitAndInstall()
  }
}

/** Looks the latest release up on GitHub, and opens its page for the user to download the installer. */
function offerEngine(): UpdateEngine {
  let found: Release | null = null
  return {
    check: async (report) => {
      // Electron's own fetch, which goes through the system's proxy settings.
      const release = await findNewerRelease({ fetch: (url, init) => net.fetch(url, init), repository, currentVersion: app.getVersion() })
      if (!release) return
      found = release
      report({ state: 'available', version: release.version })
    },
    apply: () => {
      if (found) void shell.openExternal(found.url)
    }
  }
}

/** The engine that suits how this copy was installed. */
export function createUpdateEngine(log: AppLog): UpdateEngine {
  const mode = updateMode({ platform: process.platform, appImage: process.env['APPIMAGE'], packageType: packageType() })
  log.info(`Updates: ${mode === 'install' ? 'installed automatically' : 'offered as a download'}`)
  return mode === 'install' ? installEngine(log) : offerEngine()
}
