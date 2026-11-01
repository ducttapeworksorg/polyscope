import { describe, expect, it } from 'vitest'
import type { LogNode, SourceInfo, TextFile, WorkloadKind } from '@shared/core-api'
import {
  addEarlierLines,
  dropEarlier,
  earlierOf,
  activateTab,
  canFollowFile,
  canShowPrevious,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  emptyWorkspace,
  endFollow,
  hiddenLevelsOf,
  markLogStreamGone,
  markPodGone,
  noteRestart,
  noteSlowed,
  offersPrevious,
  openTab,
  pinTab,
  reopenLogTab,
  reopenTab,
  setLanguage,
  setLogView,
  noEventsNote,
  eventsOfRow,
  sinceOffered,
  tabName,
  toggleLevel,
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

/** Each tab as its key, with a '*' when it's the preview tab and brackets around the active one. */
const shape = ({ tabs, activeKey }: Workspace) =>
  tabs.map(({ key, pinned }) => {
    const label = pinned ? key : `${key}*`
    return key === activeKey ? `[${label}]` : label
  })

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
    expect(contentOf(ws.tabs[0]!.file)).toBe('')
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
    expect(contentOf(ws.tabs[1]!.file)).toBe('fresh')
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
    expect(ws.tabs[0]).toMatchObject({ openAs: { encoding: 'latin1' }, file: { content: 'latin' } })
  })

})

describe('choosing a language', () => {
  it('overrides the detected language for that tab only, and pins it', () => {
    const ws = setLanguage(openTab(open('a'), tab('b')), 'b', 'json')

    expect(shape(ws)).toEqual(['a', '[b]'])
    expect(ws.tabs.map((t) => t.language)).toEqual([undefined, 'json'])
  })

  it('keeps the choice across a reload', () => {
    const ws = setLanguage(open('a'), 'a', 'json')

    expect(reopenTab(ws, 'a', file('a', 'fresh'), {}).tabs[0]!.language).toBe('json')
  })

  it('ignores a tab that is not open', () => {
    const ws = open('a')

    expect(setLanguage(ws, 'x', 'json')).toBe(ws)
  })
})

describe('a tab whose pod is gone', () => {
  it('keeps what it showed, marked as from a pod that no longer exists', () => {
    const ws = markPodGone(reopenTab(open('a'), 'a', file('a', 'last read')), 'a', 'web-1')

    expect(ws.tabs[0]).toMatchObject({ podGone: 'web-1', file: { content: 'last read' } })
  })

  it('loses the mark once it is read again', () => {
    const ws = markPodGone(open('a'), 'a', 'web-1')

    expect(reopenTab(ws, 'a', file('a', 'fresh')).tabs[0]).not.toHaveProperty('podGone')
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
    expect(fresh.tabs[0]?.follow).toEqual({ followId: 'f', paused: false })

    const previewed = openTab(openTab(emptyWorkspace, tab('b')), { key: 'a', source, file: { ...log, followId: 'g' } })
    expect(previewed.tabs.map((open) => [open.key, open.follow])).toEqual([['a', { followId: 'g', paused: false }]])
  })

  it('leaves a log that isn’t followed without one', () => {
    expect(openTab(emptyWorkspace, { key: 'a', source, file: log }).tabs[0]?.follow).toBeUndefined()
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

    expect(slowed.tabs.map((tab) => tab.follow?.slowed ?? false)).toEqual([true, false])
    expect(noteSlowed(slowed, 'f', false).tabs.map((tab) => tab.follow?.slowed ?? false)).toEqual([false, false])
  })

  it('stops saying so once its Follow ends', () => {
    expect(endFollow(noteSlowed(followed(), 'f', true), 'f').tabs[0]?.follow).toBeUndefined()
  })
})

describe('a log tab whose Log Stream is gone', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: false, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: 'last read' } as const
  const followed = () => openTab(emptyWorkspace, { key: 'c', source, file: { ...log, followId: 'f' } })

  it('keeps what it showed, marked as gone, when its Follow ends as the Log Stream went away', () => {
    const ws = endFollow(followed(), 'f', 'gone')

    expect(ws.tabs[0]).toMatchObject({ logStreamGone: true, file: { content: 'last read' } })
    expect(ws.tabs[0]?.follow).toBeUndefined()
  })

  it('isn’t marked when its Follow ends otherwise', () => {
    expect(endFollow(followed(), 'f', 'exited').tabs[0]).not.toHaveProperty('logStreamGone')
    expect(endFollow(followed(), 'f', 'disconnected').tabs[0]).not.toHaveProperty('logStreamGone')
  })

  it('is marked when reading it again finds it gone', () => {
    expect(markLogStreamGone(followed(), 'c').tabs[0]).toMatchObject({ logStreamGone: true, file: { content: 'last read' } })
  })

  it('loses the mark once it is read again', () => {
    expect(reopenLogTab(endFollow(followed(), 'f', 'gone'), 'c', log).tabs[0]).not.toHaveProperty('logStreamGone')
  })
})

describe('switching a container’s log view to its Previous Log', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', offersPreviousLog: true, offersSince: false, previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
  const followed = (restarted = false) => openTab(emptyWorkspace, { key: 'c', source, file: { ...log, restarted, followId: 'f' } })
  const onlyTab = (ws: Workspace) => ws.tabs[0]!

  it('offers it once the container has restarted', () => {
    expect(canShowPrevious(onlyTab(followed()))).toBe(false)
    expect(canShowPrevious(onlyTab(followed(true)))).toBe(true)
  })

  it('offers it as soon as the tab’s Follow sees the container restart', () => {
    const ws = noteRestart(openTab(followed(), { key: 'd', source, file: { ...log, followId: 'g' } }, { pinned: true }), 'f')

    expect(ws.tabs.map(canShowPrevious)).toEqual([true, false])
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
  const onlyTab = (ws: Workspace) => ws.tabs[0]!

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
  const onlyTab = (ws: Workspace) => ws.tabs[0]!

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
  const onlyTab = (ws: Workspace) => ws.tabs[0]!

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

    expect(offersPrevious(ws.tabs[0]!)).toBe(false)
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
