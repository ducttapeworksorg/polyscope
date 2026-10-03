import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppLog } from './app-log'
import { findNewerRelease, summarizeUpdateError, updateMode, type Release, type UpdateEngine } from './updates'

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

/**
 * Whether the NSIS installer put this copy here: it leaves its uninstaller beside the executable, which a Portable
 * Copy (the portable .exe, or the .zip) doesn't have. It's named after productName in electron-builder.yml.
 */
function hasNsisUninstaller(): boolean {
  return existsSync(join(dirname(process.execPath), 'Uninstall Polyscope.exe'))
}

/** electron-updater: downloads a newer release in the background, then restarts into it when asked. */
function installEngine(log: AppLog): UpdateEngine {
  const prefixed = (message: unknown) => `Updater: ${summarizeUpdateError(message)}`
  autoUpdater.logger = {
    info: (message) => log.info(prefixed(message)),
    warn: (message) => log.warn(prefixed(message)),
    // A failed check is logged once, by the updater it fails.
    error: () => {}
  }
  autoUpdater.autoDownload = true
  // Installing a .deb or .rpm asks for the administrator password, which would be a surprise on quitting.
  autoUpdater.autoInstallOnAppQuit = false
  return {
    check: async (report) => {
      const result = await autoUpdater.checkForUpdates().catch((error: unknown) => {
        throw new Error(summarizeUpdateError(error))
      })
      if (!result?.isUpdateAvailable || !result.downloadPromise) return
      const { version } = result.updateInfo
      report({ state: 'downloading', version, percent: 0 })
      const progress = ({ percent }: { percent: number }) => report({ state: 'downloading', version, percent: Math.floor(percent) })
      autoUpdater.on('download-progress', progress)
      try {
        await result.downloadPromise.catch((error: unknown) => {
          throw new Error(summarizeUpdateError(error))
        })
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

/** The engine that suits this copy: an Installed Copy updates itself where it can, a Portable Copy is offered a download. */
export function createUpdateEngine(log: AppLog): UpdateEngine {
  const mode = updateMode({
    platform: process.platform,
    hasNsisUninstaller: process.platform === 'win32' && hasNsisUninstaller(),
    appImage: process.env['APPIMAGE'],
    packageType: packageType()
  })
  log.info(`Updates: ${mode === 'install' ? 'installed automatically' : 'offered as a download'}`)
  return mode === 'install' ? installEngine(log) : offerEngine()
}
