import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreResult, FollowEvent, LargeFile, LargeFileEvent, LargeFileSearchEvent, SourceInfo } from '@shared/core-api'
import { MB, type Settings } from '@shared/settings'
import { createCore, type Core } from '../../main/core/core'
import { serveBridge, type HostShell } from './host'
import type { ExtensionBridge, OpenRequest, ToWebview } from './protocol'
import { createWebviewBridge } from './webview'

let dir: string
/** The Local Source's root, apart from the core's data. */
let root: string
let core: Core
let bridge: ExtensionBridge
let host: ReturnType<typeof serveBridge>
let shell: HostShell
/** Tells the host's subscribers that `polyscope.ownViewer` changed, as VS Code's configuration does. */
let ownViewerChanged: (on: boolean) => void

const quietLog = { warn: () => {}, error: () => {} }

/** What a message is after `postMessage`, which carries it as JSON. */
const overTheWire = <T>(message: T): T => JSON.parse(JSON.stringify(message)) as T

/** A host and a webview bridge joined by an in-memory channel that, like `postMessage`, delivers later and as JSON. */
function connect() {
  const webviewListeners = new Set<(message: ToWebview) => void>()
  host = serveBridge({
    core,
    log: quietLog,
    shell,
    post: (message) => {
      const sent = overTheWire(message)
      setTimeout(() => webviewListeners.forEach((listener) => listener(sent)))
    }
  })
  bridge = createWebviewBridge({
    post: (message) => {
      const sent = overTheWire(message)
      setTimeout(() => host.receive(sent))
    },
    listen: (listener) => webviewListeners.add(listener)
  })
}

const invoke = <T>(method: Parameters<ExtensionBridge['invokeCore']>[0], ...args: unknown[]) =>
  bridge.invokeCore(method, args) as Promise<CoreResult<T>>

/** Adds a Local Source over the bridge, rooted at the test's folder. */
async function addLocalSource() {
  const result = await invoke<SourceInfo>('addSource', { type: 'local', name: 'Logs', rootPath: root })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-bridge-'))
  root = join(dir, 'files')
  await mkdir(root)
  core = createCore({ dataDir: join(dir, 'user-data'), cacheDir: join(dir, 'cache') })
  shell = {
    pickFolder: async () => '/picked/folder',
    pickFile: async (filters) => `/picked/${filters[0]?.extensions[0] ?? 'nothing'}`,
    copyDiagnostics: async () => {},
    copyText: async () => {},
    appVersion: async () => '1.2.3',
    openExtensionSettings: async () => {},
    open: async () => {},
    retitle: async () => {},
    sourcesChanged: () => {},
    ownViewer: async () => true,
    onOwnViewerChanged: (listener) => {
      ownViewerChanged = listener
      return () => (ownViewerChanged = () => {})
    }
  }
  connect()
})

afterEach(async () => {
  host.dispose()
  for (const source of await core.listSources()) await core.disconnect(source.id)
  await rm(dir, { recursive: true, force: true })
})

describe('core calls over the bridge', () => {
  it('return the core’s results', async () => {
    const source = await addLocalSource()
    await writeFile(join(root, 'app.log'), 'hello\n')

    expect(await invoke('listSources')).toEqual({ ok: true, value: [source] })
    expect(await invoke('connect', source.id)).toMatchObject({ ok: true, value: [{ kind: 'file', name: 'app.log' }] })
    expect(await invoke('openFile', source.id, 'app.log')).toMatchObject({ ok: true, value: { view: 'editor', content: 'hello\n' } })
  })

  it('carry the core’s error codes back', async () => {
    const source = await addLocalSource()
    await rm(root, { recursive: true, force: true })

    expect(await invoke('connect', source.id)).toEqual({ ok: false, code: 'ROOT_NOT_FOUND', message: expect.any(String) })
    expect(await invoke('expand', 'no-such-source', '')).toEqual({ ok: false, code: 'SOURCE_NOT_FOUND', message: expect.any(String) })
  })

  it('refuse what isn’t a core call', async () => {
    expect(await bridge.invokeCore('readFile' as never, [])).toEqual({ ok: false, code: 'UNKNOWN', message: 'Unknown core call: readFile' })
  })

  it('answer calls made at once each with its own result', async () => {
    const results = await Promise.all([invoke('listSources'), invoke('getSettings'), invoke('listEnvironments')])

    expect(results.map((result) => result.ok && Array.isArray(result.value))).toEqual([true, false, true])
  })
})

describe('the host’s own calls over the bridge', () => {
  it('pick folders and files with the host’s dialogs', async () => {
    expect(await bridge.pickFolder()).toBe('/picked/folder')
    expect(await bridge.pickFile([{ name: 'PEM', extensions: ['pem'] }])).toBe('/picked/pem')
  })

  it('copy text with the host’s clipboard', async () => {
    const copied: string[] = []
    shell.copyText = async (text) => void copied.push(text)

    await bridge.copyText('web-7d9f8c6b5-2xkqp')

    expect(copied).toEqual(['web-7d9f8c6b5-2xkqp'])
  })

  it('pass open requests to the host', async () => {
    const opened: OpenRequest[] = []
    shell.open = async (request) => void opened.push(request)
    const request: OpenRequest = { kind: 'file', sourceId: 'abc', path: 'logs/app.log', name: 'app.log', pinned: true }

    await bridge.open(request)

    expect(opened).toEqual([request])
  })

  it('say whether the host opens what needs it in Polyscope’s own viewer', async () => {
    expect(await bridge.ownViewer()).toBe(true)
  })

  it('reject with the host’s message when the host fails', async () => {
    shell.pickFolder = async () => {
      throw new Error('No dialog today')
    }

    await expect(bridge.pickFolder()).rejects.toThrow('No dialog today')
  })

  it('open the extension’s VS Code settings with the host', async () => {
    const opened = vi.fn(async () => {})
    shell.openExtensionSettings = opened

    await bridge.openExtensionSettings()

    expect(opened).toHaveBeenCalledOnce()
  })

  it('say what the extension is: an Extension Copy, its version, secrets never weak, and no updates of its own', async () => {
    expect(bridge.copy).toBe('extension')
    expect(await bridge.appVersion()).toBe('1.2.3')
    expect(await bridge.secretStorageIsWeak()).toBe(false)
    expect(await bridge.getUpdateStatus()).toEqual({ state: 'off' })
  })
})

describe('changes to what labels tabs', () => {
  it('reach the host once a Source or an Environment is added, edited or deleted, not when they’re only read', async () => {
    const changed = vi.fn()
    shell.sourcesChanged = changed

    await invoke('listSources')
    await invoke('listEnvironments')
    expect(changed).not.toHaveBeenCalled()

    const source = await addLocalSource()
    const environment = await invoke<{ id: string }>('addEnvironment', { name: 'live', color: '#e5484d', protected: true })
    if (!environment.ok) throw new Error(environment.message)
    await invoke('editSource', source.id, { type: 'local', name: 'Logs', rootPath: root, environmentId: environment.value.id })
    await invoke('editEnvironment', environment.value.id, { name: 'live', color: '#0090ff', protected: true })
    await invoke('deleteEnvironment', environment.value.id)
    await invoke('deleteSource', source.id)

    expect(changed).toHaveBeenCalledTimes(6)
  })

  it('don’t reach the host when they fail', async () => {
    const changed = vi.fn()
    shell.sourcesChanged = changed

    await invoke('deleteSource', 'no-such-source')

    expect(changed).not.toHaveBeenCalled()
  })
})

describe('core events over the bridge', () => {
  it('include settings changes', async () => {
    const received: Settings[] = []
    bridge.onSettingsChanged((settings) => received.push(settings))

    await invoke('updateSettings', { showMinimap: false })

    await eventually(() => expect(received).toMatchObject([{ showMinimap: false }]))
  })

  it('include a Follow’s updates', async () => {
    const received: FollowEvent[] = []
    bridge.onFollowEvent((event) => received.push(event))
    const source = await addLocalSource()
    await writeFile(join(root, 'app.log'), 'line 1\n')
    await invoke('connect', source.id)
    const followed = await invoke<{ followId: string }>('followFile', source.id, 'app.log')
    if (!followed.ok) throw new Error(followed.message)

    await appendFile(join(root, 'app.log'), 'line 2\n')

    await eventually(() => expect(received).toContainEqual({ followId: followed.value.followId, kind: 'lines', lines: ['line 2'] }))
  })

  it('include a Large File’s progress and its searches’ results', async () => {
    const largeFileEvents: LargeFileEvent[] = []
    const searchEvents: LargeFileSearchEvent[] = []
    bridge.onLargeFileEvent((event) => largeFileEvents.push(event))
    bridge.onLargeFileSearchEvent((event) => searchEvents.push(event))
    await invoke('updateSettings', { largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap: 4 * MB })
    await writeFile(join(root, 'big.log'), 'a needle in a haystack\n'.repeat(60_000))
    const source = await addLocalSource()
    await invoke('connect', source.id)
    const opened = await invoke<LargeFile>('openFile', source.id, 'big.log')
    if (!opened.ok) throw new Error(opened.message)
    const { largeFileId } = opened.value

    await eventually(() => expect(largeFileEvents).toContainEqual(expect.objectContaining({ largeFileId, state: 'ready' })))
    const searched = await invoke<{ searchId: string }>('searchLargeFile', largeFileId, { pattern: 'needle' })
    if (!searched.ok) throw new Error(searched.message)

    await eventually(() => expect(searchEvents).toContainEqual(expect.objectContaining({ searchId: searched.value.searchId, kind: 'done' })))
    await invoke('closeLargeFile', largeFileId)
  })

  it('include the host’s ownViewer setting changing', async () => {
    const received: boolean[] = []
    bridge.onOwnViewerChanged((on) => received.push(on))

    ownViewerChanged(false)

    await eventually(() => expect(received).toEqual([false]))
  })

  it('stop arriving once unsubscribed, while other subscribers still get them', async () => {
    const unsubscribed: Settings[] = []
    const subscribed: Settings[] = []
    const unsubscribe = bridge.onSettingsChanged((settings) => unsubscribed.push(settings))
    bridge.onSettingsChanged((settings) => subscribed.push(settings))

    unsubscribe()
    await invoke('updateSettings', { showMinimap: false })

    await eventually(() => expect(subscribed).toHaveLength(1))
    expect(unsubscribed).toEqual([])
  })

  it('stop being sent once the host lets the webview go', async () => {
    const received: Settings[] = []
    bridge.onSettingsChanged((settings) => received.push(settings))

    const ownViewer: boolean[] = []
    bridge.onOwnViewerChanged((on) => ownViewer.push(on))

    host.dispose()
    await core.updateSettings({ showMinimap: false })
    ownViewerChanged(false)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received).toEqual([])
    expect(ownViewer).toEqual([])
  })
})

describe('a webview the host lets go of', () => {
  it('has its Follows stopped and its Large Files closed, leaving other webviews’ alone', async () => {
    await invoke('updateSettings', { largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap: 4 * MB })
    await writeFile(join(root, 'app.log'), 'line 1\n')
    await writeFile(join(root, 'big.log'), 'a haystack\n'.repeat(200_000))
    const source = await addLocalSource()
    await invoke('connect', source.id)
    const followed = await invoke<{ followId: string }>('followFile', source.id, 'app.log')
    const opened = await invoke<LargeFile>('openFile', source.id, 'big.log')
    if (!followed.ok || !opened.ok) throw new Error('Not opened')
    const kept = await core.followFile(source.id, 'app.log')
    const lines: FollowEvent[] = []
    core.onFollowEvent((event) => event.kind === 'lines' && lines.push(event))

    host.dispose()
    await appendFile(join(root, 'app.log'), 'line 2\n')

    await eventually(() => expect(lines.map(({ followId }) => followId)).toContain(kept.followId))
    expect(lines.map(({ followId }) => followId)).not.toContain(followed.value.followId)
    await expect(core.largeFileStatus(opened.value.largeFileId)).rejects.toMatchObject({ code: 'LARGE_FILE_NOT_OPEN' })
    await core.stopFollow(kept.followId)
  })

  it('has a Follow it started stopped even when the Follow begins after it’s gone', async () => {
    await writeFile(join(root, 'app.log'), 'line 1\n')
    const source = await addLocalSource()
    await invoke('connect', source.id)
    const lines: FollowEvent[] = []
    core.onFollowEvent((event) => event.kind === 'lines' && lines.push(event))

    // Asked for, and let go of before the answer comes back.
    const followed = invoke<{ followId: string }>('followFile', source.id, 'app.log')
    await new Promise((resolve) => setTimeout(resolve))
    host.dispose()
    const kept = await core.followFile(source.id, 'app.log')
    await appendFile(join(root, 'app.log'), 'line 2\n')

    await eventually(() => expect(lines.map(({ followId }) => followId)).toContain(kept.followId))
    expect(lines).toHaveLength(1)
    await followed
    await core.stopFollow(kept.followId)
  })
})
