import { describe, expect, it } from 'vitest'
import type { SourceInfo, TextFile } from '@shared/core-api'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  emptyWorkspace,
  markPodGone,
  openTab,
  pinTab,
  reopenTab,
  setLanguage,
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
