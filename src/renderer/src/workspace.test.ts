import { describe, expect, it } from 'vitest'
import type { LargeFile, LogNode, SourceInfo, TextFile, WorkloadKind } from '@shared/core-api'
import {
  addEarlierLines,
  dropEarlier,
  earlierOf,
  activateTab,
  activatePane,
  canFollowFile,
  canShowPrevious,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  emptyWorkspace,
  endFollow,
  followIdsOf,
  largeFileIdsOf,
  reviseTabs,
  hiddenLevelsOf,
  markLogStreamGone,
  markPodGone,
  noteRestart,
  noteSlowed,
  offersPrevious,
  openTab,
  openToSide,
  pinTab,
  reopenLogTab,
  reopenTab,
  setLanguage,
  setLogView,
  noEventsNote,
  eventsOfRow,
  offersPodEvents,
  logToShow,
  logShownBy,
  sinceOffered,
  tabName,
  toggleLevel,
  type Pane,
  type TabContent,
  type Workspace
} from './workspace'

const source: SourceInfo = { id: 's', type: 'local', name: 'Logs', rootPath: '/logs', showHidden: true }
const file = (path: string, content = ''): TextFile => ({
  view: 'editor',
  path,
  name: path,
  content,
  encoding: 'utf-8',
  language: 'plaintext',
  size: content.length,
  modifiedTime: 0
})
const contentOf = (opened: TabContent) => ('content' in opened ? opened.content : null)
const tab = (key: string) => ({ key, source, file: file(key) })

/** Each tab of a Pane as its key, with a '*' when it's the preview tab and brackets around the active one. */
const paneShape = ({ tabs, activeKey }: Pane) =>
  tabs.map(({ key, pinned }) => {
    const label = pinned ? key : `${key}*`
    return key === activeKey ? `[${label}]` : label
  })

/** The only Pane's tabs, as `paneShape` shows them. */
const shape = (ws: Workspace) => {
  expect(ws.panes).toHaveLength(1)
  return paneShape(ws.panes[0]!)
}

/** The tabs of the only Pane. */
const tabsOf = (ws: Workspace) => {
  expect(ws.panes).toHaveLength(1)
  return ws.panes[0]!.tabs
}

const open = (...keys: string[]) => keys.reduce((ws, key) => pinTab(openTab(ws, tab(key)), key), emptyWorkspace)

describe('preview tabs', () => {
  it('opens a file as the active preview tab', () => {
    expect(shape(openTab(emptyWorkspace, tab('a')))).toEqual(['[a*]'])
  })

  it('replaces the preview tab, in place, with the next file opened', () => {
    const ws = openTab(openTab(open('a', 'b'), tab('p')), tab('q'))

    expect(shape(openTab(activateTab(ws, 'a'), tab('r')))).toEqual(['a', 'b', '[r*]'])
  })

  it('opens a pinned file as a pinned tab', () => {
    expect(shape(openTab(emptyWorkspace, tab('a'), { pinned: true }))).toEqual(['[a]'])
  })

  it('keeps the preview tab when a pinned file opens beside it', () => {
    const ws = openTab(openTab(emptyWorkspace, tab('p')), tab('a'), { pinned: true })

    expect(shape(ws)).toEqual(['p*', '[a]'])
  })

  it('pins a preview tab, so the next file opens in a new tab', () => {
    const ws = pinTab(openTab(emptyWorkspace, tab('a')), 'a')

    expect(shape(openTab(ws, tab('b')))).toEqual(['a', '[b*]'])
  })

  it('opens a new tab right after the active one', () => {
    expect(shape(openTab(activateTab(open('a', 'b'), 'a'), tab('c')))).toEqual(['a', '[c*]', 'b'])
  })

  it('just activates a file that is already open, keeping its contents', () => {
    const ws = openTab(open('a', 'b'), { ...tab('a'), file: file('a', 'newer') })

    expect(shape(ws)).toEqual(['[a]', 'b'])
    expect(contentOf(tabsOf(ws)[0]!.file)).toBe('')
  })

  it('pins a preview tab that is opened again as pinned, and never unpins one', () => {
    const preview = openTab(emptyWorkspace, tab('a'))

    expect(shape(openTab(preview, tab('a'), { pinned: true }))).toEqual(['[a]'])
    expect(shape(openTab(open('a'), tab('a')))).toEqual(['[a]'])
  })
})

describe('closing tabs', () => {
  it('activates the tab that takes the closed one’s place, or the one before it at the end', () => {
    const ws = activateTab(open('a', 'b', 'c'), 'b')

    expect(shape(closeTab(ws, 'b'))).toEqual(['a', '[c]'])
    expect(shape(closeTab(closeTab(ws, 'b'), 'c'))).toEqual(['[a]'])
    expect(shape(closeTab(open('a'), 'a'))).toEqual([])
  })

  it('keeps the active tab when another one closes', () => {
    expect(shape(closeTab(activateTab(open('a', 'b', 'c'), 'c'), 'a'))).toEqual(['b', '[c]'])
  })

  it('closes every other tab, leaving that one active', () => {
    expect(shape(closeOtherTabs(open('a', 'b', 'c'), 'b'))).toEqual(['[b]'])
  })

  it('closes all tabs', () => {
    expect(closeAllTabs(open('a', 'b'))).toEqual(emptyWorkspace)
  })

  it('ignores a tab that is not open', () => {
    const ws = open('a', 'b')

    expect(closeTab(ws, 'x')).toBe(ws)
    expect(closeOtherTabs(ws, 'x')).toBe(ws)
  })
})

describe('reloading tabs', () => {
  it('replaces a tab’s file, keeping its place, pin and focus', () => {
    const ws = reopenTab(activateTab(open('a', 'b'), 'a'), 'b', file('b', 'fresh'), {})

    expect(shape(ws)).toEqual(['[a]', 'b'])
    expect(contentOf(tabsOf(ws)[1]!.file)).toBe('fresh')
  })

  it('ignores a file for a tab closed while it was being read', () => {
    const ws = open('a')

    expect(reopenTab(ws, 'x', file('x'), {})).toBe(ws)
  })
})

describe('reopening a tab another way', () => {
  it('replaces its file and remembers how it was opened, so a reload opens it the same way', () => {
    const preview = openTab(emptyWorkspace, tab('a'))

    const ws = reopenTab(preview, 'a', { ...file('a', 'latin'), encoding: 'latin1' }, { encoding: 'latin1' })

    expect(shape(ws)).toEqual(['[a]'])
    expect(tabsOf(ws)[0]).toMatchObject({ openAs: { encoding: 'latin1' }, file: { content: 'latin' } })
  })

})

describe('choosing a language', () => {
  it('overrides the detected language for that tab only, and pins it', () => {
    const ws = setLanguage(openTab(open('a'), tab('b')), 'b', 'json')

    expect(shape(ws)).toEqual(['a', '[b]'])
    expect(tabsOf(ws).map((t) => t.language)).toEqual([undefined, 'json'])
  })

  it('keeps the choice across a reload', () => {
    const ws = setLanguage(open('a'), 'a', 'json')

    expect(tabsOf(reopenTab(ws, 'a', file('a', 'fresh'), {}))[0]!.language).toBe('json')
  })

  it('ignores a tab that is not open', () => {
    const ws = open('a')

    expect(setLanguage(ws, 'x', 'json')).toBe(ws)
  })
})

describe('a tab whose pod is gone', () => {
  it('keeps what it showed, marked as from a pod that no longer exists', () => {
    const ws = markPodGone(reopenTab(open('a'), 'a', file('a', 'last read')), 'a', 'web-1')

    expect(tabsOf(ws)[0]).toMatchObject({ podGone: 'web-1', file: { content: 'last read' } })
  })

  it('loses the mark once it is read again', () => {
    const ws = markPodGone(open('a'), 'a', 'web-1')

    expect(tabsOf(reopenTab(ws, 'a', file('a', 'fresh')))[0]).not.toHaveProperty('podGone')
  })

  it('ignores a tab that is not open', () => {
    const ws = open('a')

    expect(markPodGone(ws, 'x', 'web-1')).toBe(ws)
  })
})

describe('opening a followed log', () => {
  const log = { view: 'log', of: 'file', path: 'a', name: 'a', previous: false, lastNLines: 10, timestamps: false, content: '' } as const

  it('shows its Follow on, in a new tab or in place of the preview', () => {
    const fresh = openTab(emptyWorkspace, { key: 'a', source, file: { ...log, followId: 'f' } })
    expect(tabsOf(fresh)[0]?.follow).toEqual({ followId: 'f', paused: false })

    const previewed = openTab(openTab(emptyWorkspace, tab('b')), { key: 'a', source, file: { ...log, followId: 'g' } })
    expect(tabsOf(previewed).map((open) => [open.key, open.follow])).toEqual([['a', { followId: 'g', paused: false }]])
  })

  it('leaves a log that isn’t followed without one', () => {
    expect(tabsOf(openTab(emptyWorkspace, { key: 'a', source, file: log }))[0]?.follow).toBeUndefined()
  })
})

describe('offering to Follow a tab’s file', () => {
  const s3: SourceInfo = {
    id: 'b',
    type: 's3',
    name: 'Bucket',
    host: '',
    bucket: 'logs',
    prefix: '',
    region: 'us-east-1',
    pathStyle: false,
    auth: 'keys',
    accessKeyId: 'key',
    secretKeySet: true,
    profile: '',
    verifyTls: true,
    caBundlePath: '',
    proxyUrl: ''
  }
  const fileLog = { view: 'log', of: 'file', path: 'a', name: 'a', previous: false, lastNLines: 10, timestamps: false, content: '' } as const
  const followed = { followId: 'f', paused: false }

  it('offers it for a file open in the editor or in a log view, on a Source whose files grow', () => {
    expect(canFollowFile({ source, file: file('a') })).toBe(true)
    expect(canFollowFile({ source, file: fileLog })).toBe(true)
  })

  it('doesn’t while the file is followed already', () => {
    expect(canFollowFile({ source, file: { ...fileLog, followId: 'f' }, follow: followed })).toBe(false)
  })

  it('doesn’t for a file shown as binary or hex, which has no lines', () => {
    const binary = { ...file('a'), view: 'binary', contentLength: 0 } as const
    expect(canFollowFile({ source, file: binary })).toBe(false)
  })

  it('doesn’t for S3 objects, which don’t grow', () => {
    expect(canFollowFile({ source: s3, file: file('a') })).toBe(false)
  })

  it('doesn’t for a Log Stream, which has its own Follow', () => {
    const log = { view: 'log', of: 'logStream', path: 'p', name: 'c', offersPreviousLog: true, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
    expect(canFollowFile({ source, file: log })).toBe(false)
  })
})

describe('a log tab whose Follow is slowed', () => {
  const log = { view: 'log', of: 'logStream', path: 'g', name: 'g', offersPreviousLog: false, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
  const followed = () => openTab(openTab(emptyWorkspace, { key: 'g', source, file: { ...log, followId: 'f' } }), { key: 'h', source, file: { ...log, followId: 'g' } }, { pinned: true })

  it('says so until it no longer is', () => {
    const slowed = noteSlowed(followed(), 'f', true)

    expect(tabsOf(slowed).map((tab) => tab.follow?.slowed ?? false)).toEqual([true, false])
    expect(tabsOf(noteSlowed(slowed, 'f', false)).map((tab) => tab.follow?.slowed ?? false)).toEqual([false, false])
  })

  it('stops saying so once its Follow ends', () => {
    expect(tabsOf(endFollow(noteSlowed(followed(), 'f', true), 'f'))[0]?.follow).toBeUndefined()
  })
})

describe('a log tab whose Log Stream is gone', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: false, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: 'last read' } as const
  const followed = () => openTab(emptyWorkspace, { key: 'c', source, file: { ...log, followId: 'f' } })

  it('keeps what it showed, marked as gone, when its Follow ends as the Log Stream went away', () => {
    const ws = endFollow(followed(), 'f', 'gone')

    expect(tabsOf(ws)[0]).toMatchObject({ logStreamGone: true, file: { content: 'last read' } })
    expect(tabsOf(ws)[0]?.follow).toBeUndefined()
  })

  it('isn’t marked when its Follow ends otherwise', () => {
    expect(tabsOf(endFollow(followed(), 'f', 'exited'))[0]).not.toHaveProperty('logStreamGone')
    expect(tabsOf(endFollow(followed(), 'f', 'disconnected'))[0]).not.toHaveProperty('logStreamGone')
  })

  it('is marked when reading it again finds it gone', () => {
    expect(tabsOf(markLogStreamGone(followed(), 'c'))[0]).toMatchObject({ logStreamGone: true, file: { content: 'last read' } })
  })

  it('loses the mark once it is read again', () => {
    expect(tabsOf(reopenLogTab(endFollow(followed(), 'f', 'gone'), 'c', log))[0]).not.toHaveProperty('logStreamGone')
  })
})

describe('switching a container’s log view to its Previous Log', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: true, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
  const followed = (restarted = false) => openTab(emptyWorkspace, { key: 'c', source, file: { ...log, restarted, followId: 'f' } })
  const onlyTab = (ws: Workspace) => tabsOf(ws)[0]!

  it('offers it once the container has restarted', () => {
    expect(canShowPrevious(onlyTab(followed()))).toBe(false)
    expect(canShowPrevious(onlyTab(followed(true)))).toBe(true)
  })

  it('offers it as soon as the tab’s Follow sees the container restart', () => {
    const ws = noteRestart(openTab(followed(), { key: 'd', source, file: { ...log, followId: 'g' } }, { pinned: true }), 'f')

    expect(tabsOf(ws).map(canShowPrevious)).toEqual([true, false])
  })

  it('goes by what a log read afresh says', () => {
    expect(canShowPrevious(onlyTab(reopenLogTab(noteRestart(followed(), 'f'), 'c', log)))).toBe(false)
    expect(canShowPrevious(onlyTab(reopenLogTab(followed(), 'c', { ...log, restarted: true })))).toBe(true)
  })

  it('doesn’t for a file’s log view, which has no Previous Log', () => {
    const fileLog = { view: 'log', of: 'file', path: 'a', name: 'a', previous: false, lastNLines: 10, timestamps: false, content: '' } as const
    const tab = onlyTab(openTab(emptyWorkspace, { key: 'a', source, file: fileLog }))

    expect(offersPrevious(tab)).toBe(false)
    expect(canShowPrevious(tab)).toBe(false)
  })

  it('offers it for a Log Stream whose Source Type has Previous Logs, before it has restarted too', () => {
    expect(offersPrevious(onlyTab(followed()))).toBe(true)
  })

  it('doesn’t for a Log Stream whose Source Type has no Previous Logs, even once it has restarted', () => {
    const tab = onlyTab(noteRestart(openTab(emptyWorkspace, { key: 'c', source, file: { ...log, offersPreviousLog: false, followId: 'f' } }), 'f'))

    expect(offersPrevious(tab)).toBe(false)
    expect(canShowPrevious(tab)).toBe(false)
  })

  it('still doesn’t once its log fails to read again', () => {
    const opened = openTab(emptyWorkspace, { key: 'c', source, file: { ...log, offersPreviousLog: false } })
    const failed = { view: 'logFailed', of: 'logStream', path: 'p/c', name: 'c', previous: false, lastNLines: 10, timestamps: false, message: 'gone' } as const

    expect(offersPrevious(onlyTab(reopenLogTab(opened, 'c', failed)))).toBe(false)
  })

  it('stops the Follow and keeps how the lines are shown when the Previous Log can’t be read', () => {
    const failed = { view: 'logFailed', of: 'logStream', path: 'p/c', name: 'c', previous: true, lastNLines: 10, timestamps: true, message: 'gone' } as const
    const tab = onlyTab(reopenLogTab(followed(true), 'c', failed))

    expect(tab.follow).toBeUndefined()
    expect(tab.file).toEqual(failed)
    expect(tabName(tab)).toBe('c (previous)')
    // To switch back to the current log, failing or not.
    expect(canShowPrevious(tab)).toBe(true)
    expect(canShowPrevious(onlyTab(reopenLogTab(followed(true), 'c', { ...failed, previous: false })))).toBe(true)
  })
})

describe('switching a container’s log view to its pod’s Events', () => {
  const cluster: SourceInfo = { id: 'k', type: 'kubernetesLogs', name: 'Cluster', context: 'dev', namespace: 'shop' }
  const log = (path: string, offersPreviousLog = true) =>
    ({ view: 'log', of: 'logStream', path, name: path.split('/').at(-1)!, offersPreviousLog, offersSince: true, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' }) as const
  const container = log('deployments/api/api-7d9f-x2k/web')
  const opened = (file: TabContent, from: SourceInfo = cluster) => tabsOf(openTab(emptyWorkspace, { key: 'c', source: from, file }))[0]!

  it('is offered by every container’s log view in a Kubernetes Logs Source, with a Previous Log or not', () => {
    expect(offersPodEvents(opened(container))).toBe(true)
    expect(offersPodEvents(opened({ ...container, restarted: true }))).toBe(true)
    expect(offersPodEvents(opened({ ...container, previous: true }))).toBe(true)
    expect(offersPodEvents(opened({ view: 'logFailed', of: 'logStream', path: container.path, name: 'web', previous: true, lastNLines: 10, timestamps: false, message: 'gone' }))).toBe(true)
  })

  it('isn’t offered by Events’ log views, nor by other Source Types’', () => {
    expect(offersPodEvents(opened(log('events', false)))).toBe(false)
    expect(offersPodEvents(opened(log('events/deployments/api/api-7d9f-x2k', false)))).toBe(false)
    expect(offersPodEvents(opened(log('shop/web/web-1'), source))).toBe(false)
    expect(offersPodEvents(opened({ view: 'log', of: 'file', path: 'a', name: 'a', previous: false, lastNLines: 10, timestamps: false, content: '' }, source))).toBe(false)
  })

  it('reads the container’s pod’s Events, the same pod’s whichever container it is, from its log or Previous Log', () => {
    const podEvents = { path: 'events/deployments/api/api-7d9f-x2k', name: 'api-7d9f-x2k', previous: false }

    expect(logToShow(opened(container), 'podEvents')).toEqual({ ...podEvents, podEventsOf: { path: container.path, name: 'web' } })
    expect(logToShow(opened({ ...container, previous: true }), 'podEvents')).toEqual({ ...podEvents, podEventsOf: { path: container.path, name: 'web' } })
    const sidecar = log('deployments/api/api-7d9f-x2k/istio-proxy')
    expect(logToShow(opened(sidecar), 'podEvents')).toEqual({ ...podEvents, podEventsOf: { path: sidecar.path, name: 'istio-proxy' } })
    expect(logToShow(opened(log('pods/counter/counter')), 'podEvents')).toMatchObject({ path: 'events/pods/counter', name: 'counter' })
    expect(logToShow(opened(log('cronjobs/nightly/nightly-1/nightly-1-abcde/main')), 'podEvents')).toMatchObject({
      path: 'events/cronjobs/nightly/nightly-1/nightly-1-abcde',
      name: 'nightly-1-abcde'
    })
  })

  describe('once switched', () => {
    const podEvents = { ...log('events/deployments/api/api-7d9f-x2k', false), name: 'api-7d9f-x2k', content: '[Warning] Failed pod/api-7d9f-x2k: Failed to pull image', followId: 'e' }
    const switched = (restarted = false) => {
      const ws = openTab(emptyWorkspace, { key: 'c', source: cluster, file: { ...container, restarted, followId: 'f' } })
      return reopenLogTab(ws, 'c', podEvents, { path: container.path, name: 'web' })
    }

    it('shows the pod’s Events in the same tab, Followed, titled for them', () => {
      const tab = tabsOf(switched())[0]!

      expect(tabsOf(switched()).map((open) => open.key)).toEqual(['c'])
      expect(logShownBy(tab)).toBe('podEvents')
      expect(tab.file).toEqual(podEvents)
      expect(tab.follow).toEqual({ followId: 'e', paused: false })
      expect(tabName(tab)).toBe('api-7d9f-x2k · Events')
      expect(offersPodEvents(tab)).toBe(true)
    })

    it('still offers the container’s Previous Log, once it has restarted', () => {
      expect(offersPrevious(tabsOf(switched())[0]!)).toBe(true)
      expect(canShowPrevious(tabsOf(switched())[0]!)).toBe(false)
      expect(canShowPrevious(tabsOf(switched(true))[0]!)).toBe(true)
    })

    it('keeps showing them as they’re read again, with Since or Last N lines', () => {
      const tab = tabsOf(reopenLogTab(switched(), 'c', { ...podEvents, lastNLines: 100 }, { path: container.path, name: 'web' }))[0]!

      expect(logShownBy(tab)).toBe('podEvents')
      expect(tab.file).toMatchObject({ lastNLines: 100 })
    })

    it('switches back to the container’s log or Previous Log', () => {
      const tab = tabsOf(switched())[0]!

      expect(logToShow(tab, 'log')).toEqual({ path: container.path, name: 'web', previous: false })
      expect(logToShow(tab, 'previous')).toEqual({ path: container.path, name: 'web', previous: true })
      const back = tabsOf(reopenLogTab(switched(), 'c', { ...container, followId: 'g' }))[0]!
      expect(logShownBy(back)).toBe('log')
      expect(tabName(back)).toBe('web')
      expect(back).not.toHaveProperty('podEventsOf')
    })

    it('says why when they can’t be read, and can switch back', () => {
      const failed = { view: 'logFailed', of: 'logStream', path: podEvents.path, name: podEvents.name, previous: false, lastNLines: 10, timestamps: false, message: 'missing permission' } as const
      const tab = tabsOf(reopenLogTab(switched(true), 'c', failed, { path: container.path, name: 'web' }))[0]!

      expect(logShownBy(tab)).toBe('podEvents')
      expect(tab.follow).toBeUndefined()
      expect(tabName(tab)).toBe('api-7d9f-x2k · Events')
      expect(logToShow(tab, 'log')).toEqual({ path: container.path, name: 'web', previous: false })
      expect(canShowPrevious(tab)).toBe(true)
    })
  })

  it('reads a container’s log or Previous Log as its log view switches between them', () => {
    expect(logToShow(opened(container), 'previous')).toEqual({ path: container.path, name: 'web', previous: true })
    expect(logToShow(opened({ ...container, previous: true }), 'log')).toEqual({ path: container.path, name: 'web', previous: false })
  })
})

describe('cycling through tabs', () => {
  it('activates the next tab, or the previous one', () => {
    const ws = activateTab(open('a', 'b', 'c'), 'b')

    expect(shape(cycleTab(ws, 1))).toEqual(['a', 'b', '[c]'])
    expect(shape(cycleTab(ws, -1))).toEqual(['[a]', 'b', 'c'])
  })

  it('wraps around from either end', () => {
    expect(shape(cycleTab(open('a', 'b', 'c'), 1))).toEqual(['[a]', 'b', 'c'])
    expect(shape(cycleTab(activateTab(open('a', 'b', 'c'), 'a'), -1))).toEqual(['a', 'b', '[c]'])
  })

  it('leaves a workspace without tabs as it is', () => {
    expect(cycleTab(emptyWorkspace, 1)).toBe(emptyWorkspace)
  })
})

describe('reading further back in a log view', () => {
  const log = { view: 'log', of: 'logStream', path: 'g', name: 'g', offersPreviousLog: false, offersSince: false, previous: false, restarted: false, lastNLines: 2, timestamps: false, content: 'c\nd', earlier: 'e1' } as const
  const opened = () => openTab(emptyWorkspace, { key: 'g', source, file: { ...log, followId: 'f' } })
  const onlyTab = (ws: Workspace) => tabsOf(ws)[0]!

  it('adds the lines read before those shown, going on from where they end', () => {
    const once = addEarlierLines(opened(), 'g', 'e1', { content: 'b', earlier: 'e2' })
    const twice = addEarlierLines(once, 'g', 'e2', { content: 'a' })

    expect(onlyTab(once).loadedEarlier).toEqual({ content: 'b', earlier: 'e2' })
    expect(onlyTab(twice).loadedEarlier).toEqual({ content: 'a\nb' })
    expect(earlierOf(onlyTab(twice))).toBeUndefined()
  })

  it('adds nothing read from where the tab no longer ends, say read twice at once', () => {
    const once = addEarlierLines(opened(), 'g', 'e1', { content: 'b', earlier: 'e2' })

    expect(addEarlierLines(once, 'g', 'e1', { content: 'b', earlier: 'e2' })).toBe(once)
  })

  it('reads no further back once its Follow has dropped its first lines', () => {
    expect(earlierOf(onlyTab(dropEarlier(opened(), 'g')))).toBeUndefined()
  })

  it('forgets the lines read further back once read again', () => {
    const reopened = reopenLogTab(dropEarlier(addEarlierLines(opened(), 'g', 'e1', { content: 'b' }), 'g'), 'g', log)

    expect(onlyTab(reopened)).not.toHaveProperty('loadedEarlier')
    expect(earlierOf(onlyTab(reopened))).toBe('e1')
  })
})

describe('a log view’s Since', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: true, offersSince: true, previous: false, restarted: true, lastNLines: 10, timestamps: false, content: '' } as const
  const opened = (offersSince = true) => openTab(emptyWorkspace, { key: 'c', source, file: { ...log, offersSince } })
  const onlyTab = (ws: Workspace) => tabsOf(ws)[0]!

  it('is offered only for a Log Stream whose Source Type offers it, as its log said when read', () => {
    expect(sinceOffered(onlyTab(opened()))).toBe(true)
    expect(sinceOffered(onlyTab(opened(false)))).toBe(false)
    const fileLog = { view: 'log', of: 'file', path: 'a', name: 'a', previous: false, lastNLines: 10, timestamps: false, content: '' } as const
    expect(sinceOffered(onlyTab(openTab(emptyWorkspace, { key: 'a', source, file: fileLog })))).toBe(false)
  })

  it('starts at any time', () => {
    expect(onlyTab(opened()).since).toBeUndefined()
  })

  it('is kept as the log is read again, switching to its Previous Log and back, or failing to', () => {
    const since = { minutesAgo: 15 }
    const ws = setLogView(opened(), 'c', { since })
    const failed = { view: 'logFailed', of: 'logStream', path: 'p/c', name: 'c', previous: true, lastNLines: 10, timestamps: false, message: 'gone' } as const

    const previous = reopenLogTab(ws, 'c', { ...log, previous: true })
    expect(onlyTab(previous)).toMatchObject({ since, offersSince: true })
    expect(onlyTab(reopenLogTab(previous, 'c', log))).toMatchObject({ since, offersSince: true })
    expect(onlyTab(reopenLogTab(ws, 'c', failed))).toMatchObject({ since, offersSince: true })
  })
})

describe('a log view’s Level Filter', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: true, offersSince: true, previous: false, restarted: true, lastNLines: 10, timestamps: false, content: '' } as const
  const opened = () => openTab(emptyWorkspace, { key: 'c', source, file: log })
  const onlyTab = (ws: Workspace) => tabsOf(ws)[0]!

  it('starts showing every Log Level', () => {
    expect(hiddenLevelsOf(onlyTab(opened()))).toEqual([])
  })

  it('hides a Log Level, and shows it again', () => {
    const ws = toggleLevel(toggleLevel(opened(), 'c', 'debug'), 'c', 'info')
    expect(hiddenLevelsOf(onlyTab(ws))).toEqual(['debug', 'info'])
    expect(hiddenLevelsOf(onlyTab(toggleLevel(ws, 'c', 'debug')))).toEqual(['info'])
  })

  it('is kept as the log is read again, switching to its Previous Log and back, or failing to', () => {
    const ws = toggleLevel(opened(), 'c', 'debug')
    const failed = { view: 'logFailed', of: 'logStream', path: 'p/c', name: 'c', previous: true, lastNLines: 10, timestamps: false, message: 'gone' } as const

    const previous = reopenLogTab(ws, 'c', { ...log, previous: true })
    expect(hiddenLevelsOf(onlyTab(previous))).toEqual(['debug'])
    expect(hiddenLevelsOf(onlyTab(reopenLogTab(previous, 'c', log)))).toEqual(['debug'])
    expect(hiddenLevelsOf(onlyTab(reopenLogTab(ws, 'c', failed)))).toEqual(['debug'])
  })
})

describe('a Kubernetes Logs Source’s Events', () => {
  const cluster: SourceInfo = { id: 'k', type: 'kubernetesLogs', name: 'Cluster', context: 'dev', namespace: 'shop' }
  const events = (content: string, path = 'events', name = 'events'): TabContent => ({
    view: 'log',
    of: 'logStream',
    path,
    name,
    offersPreviousLog: false,
    offersSince: true,
    previous: false,
    restarted: false,
    lastNLines: 'all',
    timestamps: false,
    content
  })
  const ofPod = (content: string) => events(content, 'events/deployments/api/api-7d9f-x2k', 'api-7d9f-x2k')

  it('are titled Events, or by the pod’s or Workload’s name and Events', () => {
    expect(tabName({ source: cluster, file: events('') })).toBe('Events')
    expect(tabName({ source: cluster, file: ofPod('') })).toBe('api-7d9f-x2k · Events')
    expect(tabName({ source, file: events('') })).toBe('events')
    expect(tabName({ source, file: ofPod('') })).toBe('api-7d9f-x2k')
  })

  it('say there are none only when none were read, and of what', () => {
    expect(noEventsNote({ source: cluster, file: events('') })).toMatch(/^No Events in this namespace\. Kubernetes keeps Events for about an hour/)
    expect(noEventsNote({ source: cluster, file: ofPod('') })).toMatch(/^No Events for api-7d9f-x2k\. Kubernetes keeps Events for about an hour/)
    expect(noEventsNote({ source: cluster, file: events('[Normal] Scheduled pod/x: assigned') })).toBeUndefined()
    expect(noEventsNote({ source: cluster, file: ofPod('[Normal] Scheduled pod/x: assigned') })).toBeUndefined()
    expect(noEventsNote({ source, file: events('') })).toBeUndefined()
  })

  it('offer no Previous Log', () => {
    const ws = openTab(emptyWorkspace, { key: 'k:events/pods/x', source: cluster, file: ofPod('') })

    expect(offersPrevious(tabsOf(ws)[0]!)).toBe(false)
  })

  describe('shown from a row', () => {
    const pod = (path: string, folded?: LogNode): LogNode => ({
      kind: 'group',
      name: path.split('/').at(-1)!,
      path,
      ...(folded && { folded }),
      kubernetes: { kind: 'pod', containerCount: 1 }
    })
    const workload = (path: string, workloadKind: WorkloadKind = 'Deployment', folded?: LogNode): LogNode => ({
      kind: 'group',
      name: path.split('/').at(-1)!,
      path,
      ...(folded && { folded }),
      kubernetes: { kind: 'workload', workloadKind: workloadKind as Exclude<WorkloadKind, 'Pod'> }
    })
    const container = (path: string): LogNode => ({ kind: 'logStream', name: path.split('/').at(-1)!, path, kubernetes: { kind: 'container' } })
    const shown = (node: LogNode) => eventsOfRow(node) && { path: eventsOfRow(node)!.path, name: eventsOfRow(node)!.name }

    it('are a pod’s, its only container folded in or not, under any Workload', () => {
      expect(shown(pod('pods/counter'))).toEqual({ path: 'events/pods/counter', name: 'counter' })
      expect(shown(pod('pods/counter', container('pods/counter/counter')))).toEqual({ path: 'events/pods/counter', name: 'counter' })
      expect(shown(pod('cronjobs/nightly/nightly-1/nightly-1-abcde'))).toEqual({
        path: 'events/cronjobs/nightly/nightly-1/nightly-1-abcde',
        name: 'nightly-1-abcde'
      })
    })

    it('are a Workload’s, whatever is folded into its row', () => {
      expect(shown(workload('deployments/api'))).toEqual({ path: 'events/deployments/api', name: 'api' })
      expect(shown(workload('deployments/api', 'Deployment', pod('deployments/api/api-7d9f-x2k')))).toEqual({ path: 'events/deployments/api', name: 'api' })
      expect(shown(workload('cronjobs/nightly', 'CronJob', workload('cronjobs/nightly/nightly-1', 'Job')))).toEqual({
        path: 'events/cronjobs/nightly',
        name: 'nightly'
      })
      expect(shown(workload('cronjobs/nightly/nightly-1', 'Job'))).toEqual({ path: 'events/cronjobs/nightly/nightly-1', name: 'nightly-1' })
    })

    it('are no other row’s', () => {
      const workloads: LogNode = { kind: 'group', name: 'deployments', path: 'deployments', kubernetes: { kind: 'workloads', workloadKind: 'Deployment' } }
      const namespaceEvents: LogNode = { kind: 'logStream', name: 'events', path: 'events', kubernetes: { kind: 'events' } }
      const dockerService: LogNode = { kind: 'group', name: 'web', path: 'shop/web', docker: { kind: 'service' } }

      for (const node of [workloads, namespaceEvents, container('pods/counter/counter'), dockerService]) expect(eventsOfRow(node)).toBeUndefined()
    })

    it('are a Log Stream with no Previous Log, not listed in the tree', () => {
      expect(eventsOfRow(pod('pods/counter'))).toEqual({
        kind: 'logStream',
        name: 'counter',
        path: 'events/pods/counter',
        capabilities: { previousLog: false, restarts: false },
        kubernetes: { kind: 'events' }
      })
    })
  })
})

describe('Panes', () => {
  const sideBySide = { kind: 'sideBySide', ratio: 0.5 } as const
  /** A Workspace of a Pane per list of keys, each opened (and pinned) in turn, the one at `active` active. */
  const panesOf = (active: number, ...keysOf: string[][]): Workspace => ({
    panes: keysOf.map((keys) => open(...keys).panes[0]!),
    activePane: active,
    layout: sideBySide
  })
  /** Each Pane as `paneShape` shows its tabs, the active one marked with '>'. */
  const panesShape = (ws: Workspace) => ws.panes.map((pane, index) => `${index === ws.activePane ? '>' : ' '} ${paneShape(pane).join(' ')}`)
  const tabIn = (ws: Workspace, key: string) => ws.panes.flatMap((pane) => pane.tabs).find((open) => open.key === key)

  describe('opening', () => {
    it('activates a file’s tab, and its Pane, when it’s open in another Pane', () => {
      expect(panesShape(openTab(panesOf(0, ['a', 'b'], ['c', 'd']), tab('c')))).toEqual(['  a [b]', '> [c] d'])
    })

    it('opens a new file in the active Pane, in place of that Pane’s own preview tab', () => {
      const ws = openTab(panesOf(1, ['a'], ['b']), tab('p'))
      const previewing = { ...ws, panes: ws.panes.with(0, openTab(open('a'), tab('x')).panes[0]!) }

      expect(panesShape(openTab(previewing, tab('q')))).toEqual(['  a [x*]', '> b [q*]'])
    })

    it('activates a tab in another Pane, and that Pane', () => {
      expect(panesShape(activateTab(panesOf(0, ['a', 'b'], ['c', 'd']), 'c'))).toEqual(['  a [b]', '> [c] d'])
    })
  })

  describe('opening to the side', () => {
    it('opens a file in a new Pane after the active one, side by side, which becomes active', () => {
      const ws = openToSide(open('a', 'b'), tab('c'))

      expect(panesShape(ws)).toEqual(['  a [b]', '> [c*]'])
      expect(ws.layout).toEqual(sideBySide)
    })

    it('opens a file in the other Pane when there are two, in place of that Pane’s own preview tab', () => {
      const ws = openTab(openToSide(open('a'), tab('p')), tab('q'))

      expect(panesShape(openToSide(ws, tab('r')))).toEqual(['> a [r*]', '  [q*]'])
      expect(panesShape(openToSide(activateTab(ws, 'a'), tab('r')))).toEqual(['  [a]', '> [r*]'])
    })

    it('activates a file’s tab, and its Pane, when it’s open already, pinning it if asked', () => {
      const ws = openToSide(open('a', 'b'), tab('c'))

      expect(panesShape(openToSide(ws, tab('a')))).toEqual(['> [a] b', '  [c*]'])
      expect(panesShape(openToSide(ws, tab('c'), { pinned: true }))).toEqual(['  a [b]', '> [c]'])
      expect(panesShape(openToSide(open('a'), tab('a')))).toEqual(['> [a]'])
    })

    it('opens a file in the only Pane while it has no tabs, rather than beside an empty one', () => {
      const ws = openToSide(emptyWorkspace, tab('a'))

      expect(panesShape(ws)).toEqual(['> [a*]'])
      expect(ws.layout).toEqual({ kind: 'single' })
    })

    it('gives the new Pane an id none of the others has, even after Panes closed', () => {
      const reopened = openToSide(closeTab(openToSide(open('a'), tab('b')), 'a'), tab('c'))

      expect(new Set(reopened.panes.map((pane) => pane.id)).size).toBe(2)
    })
  })

  describe('closing', () => {
    it('closes a Pane left with no tabs, its neighbour becoming active and the layout shrinking', () => {
      const ws = closeTab(panesOf(0, ['a'], ['b', 'c']), 'a')

      expect(panesShape(ws)).toEqual(['> b [c]'])
      expect(ws.layout).toEqual({ kind: 'single' })
    })

    it('keeps the active Pane active when another Pane closes', () => {
      expect(panesShape(closeTab(panesOf(1, ['a'], ['b', 'c']), 'a'))).toEqual(['> b [c]'])
    })

    it('passes an active Pane closed at the end to the one before', () => {
      expect(panesShape(closeTab(panesOf(1, ['a'], ['b']), 'b'))).toEqual(['> [a]'])
    })

    it('closes the other tabs of a tab’s own Pane only', () => {
      expect(panesShape(closeOtherTabs(panesOf(0, ['a', 'b'], ['c', 'd']), 'c'))).toEqual(['  a [b]', '> [c]'])
    })

    it('closes all the tabs of the active Pane only, and so that Pane', () => {
      expect(panesShape(closeAllTabs(panesOf(1, ['a', 'b'], ['c', 'd'])))).toEqual(['> a [b]'])
    })

    it('closes all the tabs of a given Pane, and so that Pane', () => {
      expect(panesShape(closeAllTabs(panesOf(1, ['a', 'b'], ['c', 'd']), 0))).toEqual(['> c [d]'])
      expect(panesShape(closeAllTabs(panesOf(0, ['a', 'b'], ['c', 'd']), 1))).toEqual(['> a [b]'])
    })

    it('closes a Source’s tabs in every Pane, each Pane’s first left taking over from its active one', () => {
      const ws = reviseTabs(panesOf(1, ['a', 'x1'], ['b', 'x2']), (open) => (open.key.startsWith('x') ? undefined : open))

      expect(panesShape(ws)).toEqual(['  [a]', '> [b]'])
    })

    it('closes a Pane whose tabs all close along with their Source', () => {
      const ws = reviseTabs(panesOf(1, ['a'], ['b', 'c']), (open) => (open.key === 'a' ? open : undefined))

      expect(panesShape(ws)).toEqual(['> [a]'])
    })
  })

  it('activates a Pane, focused, keeping its active tab', () => {
    expect(panesShape(activatePane(panesOf(1, ['a', 'b'], ['c', 'd']), 0))).toEqual(['> a [b]', '  c [d]'])
  })

  it('cycles through the active Pane’s tabs only', () => {
    expect(panesShape(cycleTab(panesOf(1, ['a', 'b'], ['c', 'd']), 1))).toEqual(['  a [b]', '> [c] d'])
  })

  describe('changing a tab by its key, in whichever Pane holds it', () => {
    const ws = () => openTab(panesOf(1, ['a'], ['c']), tab('p'))

    it('pins it', () => {
      expect(panesShape(pinTab(ws(), 'p'))).toEqual(['  [a]', '> c [p]'])
    })

    it('reloads it, chooses its language and filters its Log Levels, leaving the active Pane as it is', () => {
      const changed = toggleLevel(setLanguage(reopenTab(panesOf(1, ['a'], ['c']), 'a', file('a', 'fresh')), 'a', 'json'), 'a', 'debug')

      expect(tabIn(changed, 'a')).toMatchObject({ language: 'json', hiddenLevels: ['debug'], file: { content: 'fresh' } })
      expect(changed.activePane).toBe(1)
    })

    it('changes how its log is shown, reads further back in it, and switches it to its Previous Log', () => {
      const log = { view: 'log', of: 'logStream', path: 'g', name: 'g', offersPreviousLog: true, offersSince: false, previous: false, restarted: true, lastNLines: 2, timestamps: false, content: 'c', earlier: 'e1' } as const
      const ws: Workspace = { ...panesOf(1, ['b']), panes: [openTab(emptyWorkspace, { key: 'g', source, file: log }).panes[0]!, open('b').panes[0]!] }

      expect(tabIn(setLogView(ws, 'g', { wrap: true, since: { minutesAgo: 60 } }), 'g')).toMatchObject({ wrap: true, since: { minutesAgo: 60 } })
      expect(tabIn(addEarlierLines(ws, 'g', 'e1', { content: 'a\nb' }), 'g')?.loadedEarlier).toEqual({ content: 'a\nb' })
      expect(tabIn(dropEarlier(ws, 'g'), 'g')?.earlierDropped).toBe(true)
      expect(tabIn(reopenLogTab(ws, 'g', { ...log, previous: true }), 'g')?.file).toMatchObject({ previous: true })
    })

    it('marks its pod or Log Stream gone', () => {
      expect(tabIn(markPodGone(panesOf(1, ['a'], ['c']), 'a', 'web-1'), 'a')).toMatchObject({ podGone: 'web-1' })
      expect(tabIn(markLogStreamGone(panesOf(1, ['a'], ['c']), 'a'), 'a')).toMatchObject({ logStreamGone: true })
    })
  })

  describe('Follows and Large Files', () => {
    const log = { view: 'log', of: 'logStream', path: 'g', name: 'g', offersPreviousLog: true, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
    const large: LargeFile = { view: 'large', path: 'l', name: 'l', size: 1, modifiedTime: 0, largeFileId: 'L', encoding: 'utf-8', lastLines: [] }
    const ws = () => {
      const left = openTab(openTab(emptyWorkspace, { key: 'g', source, file: { ...log, followId: 'f' } }), { key: 'l', source, file: large }, { pinned: true })
      const right = openTab(emptyWorkspace, { key: 'h', source, file: { ...log, path: 'h', followId: 'f2' } })
      return { panes: [left.panes[0]!, right.panes[0]!], activePane: 1, layout: sideBySide } satisfies Workspace
    }

    it('gathers the live Follows and Large Files of every Pane', () => {
      expect(followIdsOf(ws())).toEqual(new Set(['f', 'f2']))
      expect(largeFileIdsOf(ws())).toEqual(new Set(['L']))
    })

    it('notes a restart, a slowed Follow and a Follow ending in whichever Pane it goes on', () => {
      expect(tabIn(noteRestart(ws(), 'f'), 'g')?.restarted).toBe(true)
      expect(tabIn(noteSlowed(ws(), 'f', true), 'g')?.follow?.slowed).toBe(true)
      expect(tabIn(endFollow(ws(), 'f', 'gone'), 'g')).toMatchObject({ follow: undefined, logStreamGone: true })
    })
  })
})
