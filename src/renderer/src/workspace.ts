import type { LanguageId, LogSnapshot, OpenedFile, OpenOptions, SourceInfo, SourcePath } from '@shared/core-api'

/**
 * A Log Stream whose whole log was asked for but is larger than the Large File threshold: nothing of
 * it is shown until the user says to go ahead anyway, or asks for fewer lines.
 */
export interface LogTooLarge {
  view: 'logTooLarge'
  path: SourcePath
  /** The container's name. */
  name: string
}

/** What a tab shows: a file, or a Log Stream. */
export type TabContent = OpenedFile | LogSnapshot | LogTooLarge

export const isLog = (content: TabContent): content is LogSnapshot | LogTooLarge =>
  content.view === 'log' || content.view === 'logTooLarge'

/** A file or Log Stream open in the viewer. Tabs live only in the renderer and are never persisted. */
export interface OpenTab {
  key: string
  source: SourceInfo
  file: TabContent
  /** A tab that isn't pinned is the preview tab: the next file opened replaces it. */
  pinned: boolean
  /** How the file was last asked to be opened, e.g. in another encoding; reloads open it the same way. */
  openAs?: OpenOptions
  /** The language the user picked, highlighting the file instead of the detected one. */
  language?: LanguageId
}

/** The open tabs, in order, and which one is shown. */
export interface Workspace {
  tabs: OpenTab[]
  activeKey: string | null
}

export const emptyWorkspace: Workspace = { tabs: [], activeKey: null }

/**
 * Shows a file: activating its tab if it's open already, otherwise putting it in place of the
 * preview tab or, with none, right after the active tab. Opening as pinned pins it for good.
 */
export function openTab(ws: Workspace, tab: Pick<OpenTab, 'key' | 'source' | 'file'>, { pinned = false } = {}): Workspace {
  const { key } = tab
  if (ws.tabs.some((open) => open.key === key)) {
    const shown = activateTab(ws, key)
    return pinned ? pinTab(shown, key) : shown
  }
  const added = { ...tab, pinned }
  const preview = pinned ? -1 : ws.tabs.findIndex((open) => !open.pinned)
  if (preview >= 0) return { tabs: ws.tabs.with(preview, added), activeKey: key }
  const active = ws.tabs.findIndex((open) => open.key === ws.activeKey)
  const at = active >= 0 ? active + 1 : ws.tabs.length
  return { tabs: ws.tabs.toSpliced(at, 0, added), activeKey: key }
}

export const activateTab = (ws: Workspace, key: string): Workspace => ({ ...ws, activeKey: key })

export const pinTab = (ws: Workspace, key: string): Workspace => ({
  ...ws,
  tabs: ws.tabs.map((open) => (open.key === key && !open.pinned ? { ...open, pinned: true } : open))
})

/** Closes a tab; if it was active, the tab taking its place (or, at the end, the one before) becomes active. */
export function closeTab(ws: Workspace, key: string): Workspace {
  const index = ws.tabs.findIndex((open) => open.key === key)
  if (index < 0) return ws
  const tabs = ws.tabs.toSpliced(index, 1)
  if (key !== ws.activeKey) return { ...ws, tabs }
  return { tabs, activeKey: tabs[Math.min(index, tabs.length - 1)]?.key ?? null }
}

export function closeOtherTabs(ws: Workspace, key: string): Workspace {
  const kept = ws.tabs.filter((open) => open.key === key)
  return kept.length ? { tabs: kept, activeKey: key } : ws
}

export const closeAllTabs = (_ws: Workspace): Workspace => emptyWorkspace

/** Changes one tab; a tab closed meanwhile (say, while its file was being read) stays closed. */
function updateTab(ws: Workspace, key: string, change: Partial<OpenTab>): Workspace {
  if (!ws.tabs.some((open) => open.key === key)) return ws
  return { ...ws, tabs: ws.tabs.map((open) => (open.key === key ? { ...open, ...change } : open)) }
}

/**
 * Puts a freshly read file in its tab, remembering how it was read (e.g. in an encoding picked for
 * it) so reloads read it the same way. Like any change to a tab, it pins it.
 */
export const reopenTab = (ws: Workspace, key: string, file: TabContent, openAs: OpenOptions = {}): Workspace =>
  updateTab(ws, key, { file, openAs, pinned: true })

/** Highlights a tab’s file as `language` instead of the detected one, pinning the tab. */
export const setLanguage = (ws: Workspace, key: string, language: LanguageId): Workspace =>
  updateTab(ws, key, { language, pinned: true })
