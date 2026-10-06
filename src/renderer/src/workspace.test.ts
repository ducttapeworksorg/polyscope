import { describe, expect, it } from 'vitest'
import type { SourceInfo, TextFile } from '@shared/core-api'
import {
  activateTab,
  canFollowFile,
  canShowPrevious,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  emptyWorkspace,
  markPodGone,
  noteRestart,
  openTab,
  pinTab,
  reopenLogTab,
  reopenTab,
  setLanguage,
  tabName,
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
    const log = { view: 'log', of: 'logStream', path: 'p', name: 'c', pod: 'p', previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
    expect(canFollowFile({ source, file: log })).toBe(false)
  })
})

describe('switching a container’s log view to its Previous Log', () => {
  const log = { view: 'log', of: 'logStream', path: 'p/c', name: 'c', pod: 'p', previous: false, restarted: false, lastNLines: 10, timestamps: false, content: '' } as const
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

    expect(canShowPrevious(onlyTab(openTab(emptyWorkspace, { key: 'a', source, file: fileLog })))).toBe(false)
  })

  it('stops the Follow and keeps how the lines are shown when the Previous Log can’t be read', () => {
    const failed = { view: 'logFailed', of: 'logStream', path: 'p/c', name: 'c', previous: true, lastNLines: 10, timestamps: true, message: 'gone' } as const
    const tab = onlyTab(reopenLogTab(followed(true), 'c', failed))

    expect(tab.follow).toBeUndefined()
    expect(tab.file).toEqual(failed)
    expect(tabName(tab.file)).toBe('c (previous)')
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
