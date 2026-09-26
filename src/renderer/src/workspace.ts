import type { OpenedFile, SourceInfo } from '@shared/core-api'

/** A file open in the viewer. Tabs live only in the renderer and are never persisted. */
export interface OpenTab {
  key: string
  source: SourceInfo
  file: OpenedFile
  /** A tab that isn't pinned is the preview tab: the next file opened replaces it. */
  pinned: boolean
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
export function openTab(ws: Workspace, tab: Omit<OpenTab, 'pinned'>, { pinned = false } = {}): Workspace {
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

/** Puts a freshly read file in its tab, leaving everything else as it was; a tab closed meanwhile stays closed. */
export function replaceFile(ws: Workspace, key: string, file: OpenedFile): Workspace {
  if (!ws.tabs.some((open) => open.key === key)) return ws
  return { ...ws, tabs: ws.tabs.map((open) => (open.key === key ? { ...open, file } : open)) }
}
