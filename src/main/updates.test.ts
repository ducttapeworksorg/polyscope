import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@shared/updates'
import { createUpdater, findNewerRelease, isNewerVersion, updateMode } from './updates'

describe('updateMode', () => {
  it('installs updates itself from an AppImage, a .deb or an .rpm', () => {
    expect(updateMode({ platform: 'linux', appImage: '/home/alice/Polyscope.AppImage' })).toBe('install')
    expect(updateMode({ platform: 'linux', packageType: 'deb' })).toBe('install')
    expect(updateMode({ platform: 'linux', packageType: 'rpm' })).toBe('install')
  })

  it('only offers the download where it cannot install: MSI installs, unsigned macOS apps, and other Linux packages', () => {
    expect(updateMode({ platform: 'win32' })).toBe('offer')
    expect(updateMode({ platform: 'darwin' })).toBe('offer')
    expect(updateMode({ platform: 'linux' })).toBe('offer')
    expect(updateMode({ platform: 'linux', packageType: 'pacman' })).toBe('offer')
  })
})

describe('isNewerVersion', () => {
  it('compares release versions part by part, not as text', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
  })

  it('ranks a release above its own pre-releases', () => {
    expect(isNewerVersion('0.2.0', '0.2.0-beta.1')).toBe(true)
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false)
  })

  it('ignores a leading v and anything it cannot read', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false)
  })
})

describe('findNewerRelease', () => {
  const release = { tag_name: 'v0.2.0', html_url: 'https://github.com/ducttapeworksorg/polyscope/releases/tag/v0.2.0' }
  const respond = (body: unknown, status = 200) => vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }))

  it('asks GitHub for the latest release and returns it when it is newer', async () => {
    const fetch = respond(release)
    await expect(findNewerRelease({ fetch, repository: 'ducttapeworksorg/polyscope', currentVersion: '0.1.0' })).resolves.toEqual({
      version: '0.2.0',
      url: release.html_url
    })
    expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/ducttapeworksorg/polyscope/releases/latest', expect.anything())
  })

  it('returns null when this version is the latest, or later', async () => {
    const fetch = respond(release)
    await expect(findNewerRelease({ fetch, repository: 'o/r', currentVersion: '0.2.0' })).resolves.toBeNull()
    await expect(findNewerRelease({ fetch, repository: 'o/r', currentVersion: '0.3.0' })).resolves.toBeNull()
  })

  it('returns null when nothing has been released yet', async () => {
    await expect(findNewerRelease({ fetch: respond({ message: 'Not Found' }, 404), repository: 'o/r', currentVersion: '0.1.0' })).resolves.toBeNull()
  })

  it('fails on any other answer', async () => {
    await expect(findNewerRelease({ fetch: respond({}, 503), repository: 'o/r', currentVersion: '0.1.0' })).rejects.toThrow('503')
    await expect(findNewerRelease({ fetch: respond({ tag_name: 7 }), repository: 'o/r', currentVersion: '0.1.0' })).rejects.toThrow()
  })

  it('only follows a release page on https', async () => {
    const fetch = respond({ ...release, html_url: 'javascript:alert(1)' })
    await expect(findNewerRelease({ fetch, repository: 'o/r', currentVersion: '0.1.0' })).rejects.toThrow()
  })
})

/** An engine whose checks resolve when told to, reporting what the test says. */
function fakeEngine() {
  const checks: { report: (status: UpdateStatus) => void; resolve: () => void; reject: (error: Error) => void }[] = []
  const engine = {
    check: (report: (status: UpdateStatus) => void) => new Promise<void>((resolve, reject) => checks.push({ report, resolve, reject })),
    apply: vi.fn<() => void>()
  }
  return { engine, checks }
}

describe('createUpdater', () => {
  it('starts idle, then reports each step of a check to its listeners', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const seen: UpdateStatus[] = []
    updater.onStatus((status) => seen.push(status))
    expect(updater.status()).toEqual({ state: 'idle' })

    const checked = updater.check()
    checks[0]!.report({ state: 'downloading', version: '0.2.0', percent: 0 })
    checks[0]!.report({ state: 'downloading', version: '0.2.0', percent: 50 })
    checks[0]!.report({ state: 'ready', version: '0.2.0' })
    checks[0]!.resolve()
    await checked

    expect(seen).toEqual([
      { state: 'checking' },
      { state: 'downloading', version: '0.2.0', percent: 0 },
      { state: 'downloading', version: '0.2.0', percent: 50 },
      { state: 'ready', version: '0.2.0' }
    ])
    expect(updater.status()).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('says it is up to date when a check finds nothing newer', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const checked = updater.check()
    checks[0]!.resolve()
    await checked
    expect(updater.status()).toEqual({ state: 'upToDate' })
  })

  it('reports a failed check, and logs it', async () => {
    const { engine, checks } = fakeEngine()
    const log = { warn: vi.fn() }
    const updater = createUpdater({ engine, log })
    const checked = updater.check()
    checks[0]!.reject(new Error('getaddrinfo ENOTFOUND api.github.com'))
    await checked
    expect(updater.status()).toEqual({ state: 'error', message: 'getaddrinfo ENOTFOUND api.github.com' })
    expect(log.warn).toHaveBeenCalledWith('Update check failed', expect.any(Error))
  })

  it('does not start a second check while one is running or a download is under way', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const first = updater.check()
    await updater.check()
    expect(checks).toHaveLength(1)

    checks[0]!.report({ state: 'downloading', version: '0.2.0', percent: 10 })
    await updater.check()
    expect(checks).toHaveLength(1)
    checks[0]!.resolve()
    await first
  })

  it('stops checking once an update is downloaded, ready to restart into', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const first = updater.check()
    checks[0]!.report({ state: 'ready', version: '0.2.0' })
    checks[0]!.resolve()
    await first
    await updater.check()
    expect(checks).toHaveLength(1)
    expect(updater.status()).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('keeps offering a download while looking for a later one, and offers that instead when found', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const seen: UpdateStatus[] = []
    const first = updater.check()
    checks[0]!.report({ state: 'available', version: '0.2.0' })
    checks[0]!.resolve()
    await first
    updater.onStatus((status) => seen.push(status))

    // Nothing later, or no answer: the offer stands.
    const second = updater.check()
    checks[1]!.resolve()
    await second
    const third = updater.check()
    checks[2]!.reject(new Error('offline'))
    await third
    expect(seen).toEqual([])
    expect(updater.status()).toEqual({ state: 'available', version: '0.2.0' })

    const fourth = updater.check()
    checks[3]!.report({ state: 'available', version: '0.3.0' })
    checks[3]!.resolve()
    await fourth
    expect(seen).toEqual([{ state: 'available', version: '0.3.0' }])
  })

  it('applies an update only once one has been found', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    updater.apply()
    expect(engine.apply).not.toHaveBeenCalled()

    const checked = updater.check()
    checks[0]!.report({ state: 'ready', version: '0.2.0' })
    checks[0]!.resolve()
    await checked
    updater.apply()
    expect(engine.apply).toHaveBeenCalledOnce()
  })

  it('checks soon after starting, then every few hours, until stopped', async () => {
    vi.useFakeTimers()
    try {
      const { engine, checks } = fakeEngine()
      const updater = createUpdater({ engine, firstCheckDelay: 10_000, checkInterval: 60_000 })
      const stop = updater.start()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(checks).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(checks).toHaveLength(1)
      checks[0]!.resolve()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(checks).toHaveLength(2)
      checks[1]!.resolve()
      stop()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(checks).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops telling a listener once it unsubscribes', async () => {
    const { engine, checks } = fakeEngine()
    const updater = createUpdater({ engine })
    const listener = vi.fn()
    updater.onStatus(listener)()
    const checked = updater.check()
    checks[0]!.resolve()
    await checked
    expect(listener).not.toHaveBeenCalled()
  })
})
