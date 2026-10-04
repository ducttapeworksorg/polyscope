import { canApply, type UpdateStatus } from '@shared/updates'

/**
 * How an install gets a newer release: `install` downloads and applies it (electron-updater), `offer` only says
 * one is out and opens its download page. macOS won't let electron-updater replace an unsigned app, it can replace
 * only NSIS installs on Windows, so not a Portable Copy, and it knows only the AppImage, .deb and .rpm among Linux
 * packages, so the others are told rather than updated (ADR 0003). On ChromeOS a .deb or .rpm is told too: its
 * Linux has pkexec but no agent to ask for the password, and electron-updater picks pkexec over sudo.
 */
export type UpdateMode = 'install' | 'offer'

interface Install {
  platform: NodeJS.Platform
  /** Whether the NSIS installer's uninstaller is beside the executable, as it is in every Windows Installed Copy. */
  hasNsisUninstaller?: boolean
  /** Where the running AppImage is (`APPIMAGE`), when it is one. */
  appImage?: string
  /** The Linux package it came from, as electron-builder records it in `resources/package-type`. */
  packageType?: string
  /** Whether it runs in ChromeOS's Linux (Crostini). */
  chromeOs?: boolean
}

export function updateMode({ platform, hasNsisUninstaller, appImage, packageType, chromeOs }: Install): UpdateMode {
  if (platform === 'win32') return hasNsisUninstaller ? 'install' : 'offer'
  if (platform !== 'linux') return 'offer'
  // An AppImage replaces itself, needing no password.
  if (appImage) return 'install'
  return !chromeOs && (packageType === 'deb' || packageType === 'rpm') ? 'install' : 'offer'
}

/** `1.2.3` or `v1.2.3-beta.1` as numbers and a pre-release tag, or null for anything else. */
function parseVersion(text: string): { parts: number[]; preRelease: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(text.trim())
  return match ? { parts: [match[1], match[2], match[3]].map(Number), preRelease: match[4] !== undefined } : null
}

/**
 * Whether `candidate` is a later version than `current`. Pre-releases rank below their release, but aren't told
 * apart from each other: only full releases are ever offered.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!
  }
  return !a.preRelease && b.preRelease
}

export interface Release {
  version: string
  /** Its GitHub Releases page, where the installers are. */
  url: string
}

interface ReleaseQuery {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** `owner/name` on GitHub. */
  repository: string
  currentVersion: string
}

/** The latest full release on GitHub (never a draft or a pre-release), when it's newer than this one. */
export async function findNewerRelease({ fetch, repository, currentVersion }: ReleaseQuery): Promise<Release | null> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  // What GitHub answers while a repository has no releases.
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trim())
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
  if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string' || !body.html_url.startsWith('https://')) {
    throw new Error('GitHub’s answer didn’t describe a release')
  }
  const version = body.tag_name.replace(/^v/, '')
  return isNewerVersion(version, currentVersion) ? { version, url: body.html_url } : null
}

/**
 * A failed update check in a line. electron-updater's HTTP errors carry the whole response, headers and cookies
 * included; this keeps the status and address, which is all the log and the Settings need.
 */
export function summarizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = /^(\d{3})\b/.exec(message)
  // The address ends where electron-updater's quoting of the request goes on (`\n`, or the closing quote).
  const url = /\burl: (https?:\/\/[^\s"\\]+)/.exec(message)
  if (status && url) return `GitHub answered ${status[1]} for ${url[1]}`
  return message.split('\n')[0]!.trim()
}

/** One way of finding and applying updates: electron-updater's, or looking the release up and opening its page. */
export interface UpdateEngine {
  /** Looks for a newer release, reporting what it finds; resolves once done, having reported nothing if none. */
  check(report: (status: UpdateStatus) => void): Promise<void>
  /** Restarts into the update, or opens its download page; throws if installing the update failed. */
  apply(): void
}

export interface Updater {
  status(): UpdateStatus
  /** Looks for an update now, unless a check or download is running or one is ready to restart into. */
  check(): Promise<void>
  /** Applies the update found, if any. */
  apply(): void
  /** Subscribes to status changes; returns a function that unsubscribes. */
  onStatus(listener: (status: UpdateStatus) => void): () => void
  /** Checks shortly, then every `checkInterval`; returns a function that stops. */
  start(): () => void
}

interface UpdaterOptions {
  engine: UpdateEngine
  log?: { warn(message: string, error?: unknown): void }
  /** Leaves the app to start up in peace first. */
  firstCheckDelay?: number
  checkInterval?: number
}

const hour = 60 * 60 * 1000

/** Keeps track of the update status, and makes sure only one check runs at a time. */
export function createUpdater({ engine, log, firstCheckDelay = 10_000, checkInterval = 6 * hour }: UpdaterOptions): Updater {
  let current: UpdateStatus = { state: 'idle' }
  const listeners = new Set<(status: UpdateStatus) => void>()
  const set = (status: UpdateStatus) => {
    current = status
    for (const listener of listeners) listener(status)
  }
  const check = async () => {
    if (current.state === 'checking' || current.state === 'downloading' || current.state === 'ready') return
    // A download on offer stays on offer while looking for a later one, which replaces it if found.
    const offered = current.state === 'available'
    if (!offered) set({ state: 'checking' })
    try {
      let found = false
      await engine.check((status) => {
        found = true
        set(status)
      })
      if (!found && !offered) set({ state: 'upToDate' })
    } catch (error) {
      log?.warn('Update check failed', error)
      if (!offered) set({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    status: () => current,
    check,
    apply: () => {
      if (!canApply(current)) return
      try {
        engine.apply()
      } catch (error) {
        log?.warn('Update install failed', error)
        if (current.state === 'ready') set({ ...current, installFailed: error instanceof Error ? error.message : String(error) })
      }
    },
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      let interval: ReturnType<typeof setInterval> | undefined
      const first = setTimeout(() => {
        void check()
        interval = setInterval(() => void check(), checkInterval)
      }, firstCheckDelay)
      return () => {
        clearTimeout(first)
        clearInterval(interval)
      }
    }
  }
}
