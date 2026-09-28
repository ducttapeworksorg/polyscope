import type { FileLog, FollowedFile, FollowedLog, LanguageId, LogOf, LogSnapshot, OpenedFile, OpenOptions, SourceInfo, SourcePath } from '@shared/core-api'
import { followableSourceTypes } from '@shared/core-api'
import { t } from './i18n'

/**
 * A Log Stream or file whose whole log was asked for but is larger than the Large File threshold: nothing
 * of it is shown until the user says to go ahead anyway, or asks for fewer lines.
 */
export interface LogTooLarge {
  view: 'logTooLarge'
  of: LogOf
  path: SourcePath
  /** The container's or file's name. */
  name: string
  /** Whether it's the container's Previous Log. */
  previous: boolean
}

/** What a tab shows: a file, or a Log Stream or a file's last lines in a log view (followed or not). */
export type TabContent = OpenedFile | LogSnapshot | FollowedLog | FileLog | FollowedFile | LogTooLarge

/** Whether a tab's content is shown in a log view. */
export const isLog = (content: TabContent): content is LogSnapshot | FileLog | LogTooLarge =>
  content.view === 'log' || content.view === 'logTooLarge'

/** Whether a Source's files can be Followed: those of Local and Kubernetes Files Sources grow; S3 objects don't. */
export const followsFiles = (source: SourceInfo) => followableSourceTypes.includes(source.type)

/** Whether a tab offers to Follow its file: text of a Source whose files grow, not followed already. */
export const canFollowFile = ({ source, file, follow }: Pick<OpenTab, 'source' | 'file' | 'follow'>) =>
  followsFiles(source) && !follow && (isLog(file) ? file.of === 'file' : file.view === 'editor' || file.view === 'large')

/** What a tab is called: its file's or container's name, marked for a Previous Log. */
export const tabName = (content: { name: string; previous?: boolean }) =>
  content.previous ? t('logView.previous', { name: content.name }) : content.name

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
  /** A log tab's Follow while it goes on: the one its content came with. */
  follow?: FollowState
  /** Whether a log tab shows its timestamps in UTC rather than local time. */
  utc?: boolean
  /** Whether a log tab, or a file open in the editor, wraps long lines. */
  wrap?: boolean
  /** Set, to the pod's name, when a Kubernetes Files tab's pod turned out to be gone: it shows what was last read from it. */
  podGone?: string
}

/** A Follow under way in a log tab: new lines are added as they come, unless it's paused. */
export interface FollowState {
  followId: string
  paused: boolean
}

/** The open tabs, in order, and which one is shown. */
export interface Workspace {
  tabs: OpenTab[]
  activeKey: string | null
}

export const emptyWorkspace: Workspace = { tabs: [], activeKey: null }

/** The Follow a log was read with, if any, running: its tab shows it and stops it when done with it. */
const followOf = (file: TabContent): FollowState | undefined => ('followId' in file ? { followId: file.followId, paused: false } : undefined)

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
  const added = { ...tab, follow: followOf(tab.file), pinned }
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
export function reopenTab(ws: Workspace, key: string, file: TabContent, openAs: OpenOptions = {}): Workspace {
  const tab = ws.tabs.find((open) => open.key === key)
  if (!tab) return ws
  // Read afresh, so from a pod that's there.
  const { podGone: _, ...reopened } = tab
  return { ...ws, tabs: ws.tabs.map((open) => (open === tab ? { ...reopened, file, openAs, pinned: true } : open)) }
}

/** Marks a tab as showing what was last read from `pod`, which no longer exists; its content stays. */
export const markPodGone = (ws: Workspace, key: string, pod: string): Workspace => updateTab(ws, key, { podGone: pod })

/** Puts a freshly read log in its tab, with the Follow that goes on from it, if any. Pins the tab. */
export const reopenLogTab = (ws: Workspace, key: string, file: TabContent): Workspace =>
  updateTab(ws, key, { file, follow: followOf(file), pinned: true })

/** Changes how a log tab is shown or followed, leaving its content as it is. */
export const setLogView = (ws: Workspace, key: string, change: Partial<Pick<OpenTab, 'follow' | 'utc' | 'wrap'>>): Workspace =>
  updateTab(ws, key, change)

/** Marks a Follow as over in whichever tab it was going on, leaving what it showed. */
export function endFollow(ws: Workspace, followId: string): Workspace {
  const tab = ws.tabs.find((open) => open.follow?.followId === followId)
  return tab ? updateTab(ws, tab.key, { follow: undefined }) : ws
}

/** The Large Files open in the tabs, which the core keeps (and caches) until they're closed. */
export const largeFileIdsOf = (ws: Workspace) => new Set(ws.tabs.flatMap((tab) => (tab.file.view === 'large' ? [tab.file.largeFileId] : [])))

/** The Follows going on in the tabs. */
export const followIdsOf = (ws: Workspace) => new Set(ws.tabs.flatMap((tab) => (tab.follow ? [tab.follow.followId] : [])))

/** Highlights a tab’s file as `language` instead of the detected one, pinning the tab. */
export const setLanguage = (ws: Workspace, key: string, language: LanguageId): Workspace =>
  updateTab(ws, key, { language, pinned: true })
