import type {
  EarlierLog,
  FileLog,
  FollowEndReason,
  FollowedFile,
  FollowedLog,
  LanguageId,
  LastNLines,
  LogOf,
  LogSnapshot,
  OpenedFile,
  OpenOptions,
  SourceInfo,
  SourcePath
} from '@shared/core-api'
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

/**
 * A container's log that couldn't be read when its log view switched to it, or back from it: say a Previous Log
 * Kubernetes no longer keeps. The view says why, and keeps how it shows lines for switching again.
 */
export interface LogFailed {
  view: 'logFailed'
  of: 'logStream'
  path: SourcePath
  /** The container's name. */
  name: string
  /** Whether it's the container's Previous Log that couldn't be read. */
  previous: boolean
  /** The lines it was asked for with, asked for again when it's read again. */
  lastNLines: LastNLines
  /** Whether it was asked for with timestamps, likewise. */
  timestamps: boolean
  /** Why, as the user is told. */
  message: string
}

/** What a tab shows: a file, or a Log Stream or a file's last lines in a log view (followed or not). */
export type TabContent = OpenedFile | LogSnapshot | FollowedLog | FileLog | FollowedFile | LogTooLarge | LogFailed

/** Whether a tab's content is shown in a log view. */
export const isLog = (content: TabContent): content is LogSnapshot | FileLog | LogTooLarge | LogFailed =>
  content.view === 'log' || content.view === 'logTooLarge' || content.view === 'logFailed'

/**
 * Whether a log tab offers to switch to its Log Stream's Previous Log at all: unless its Source Type has none, as
 * its log said when last read. A file has none.
 */
export const offersPrevious = ({ file, offersPreviousLog }: Pick<OpenTab, 'file' | 'offersPreviousLog'>) =>
  isLog(file) && file.of === 'logStream' && offersPreviousLog !== false

/**
 * Whether a log tab can switch between its Log Stream's current log and its Previous Log, if it offers to: once the
 * Log Stream has restarted, and always back from the Previous Log.
 */
export const canShowPrevious = (tab: Pick<OpenTab, 'file' | 'restarted' | 'offersPreviousLog'>) =>
  offersPrevious(tab) && isLog(tab.file) && (tab.file.previous || tab.restarted === true)

/** Whether a Source's files can be Followed: those of Local, Kubernetes Files and SSH Files Sources grow; S3 objects don't. */
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
  /** Set when a log tab's Log Stream (a container, say) turned out to be gone: it shows what was last read from it. */
  logStreamGone?: true
  /** Whether a log tab's container has restarted, as last read or since seen by its Follow, so has a Previous Log. */
  restarted?: boolean
  /** Whether a log tab's Log Stream's Source Type has Previous Logs, as last read; left out until a read has said. */
  offersPreviousLog?: boolean
  /** A log tab's lines read further back, before its content's, as they came, and where the lines before those end. */
  loadedEarlier?: EarlierLog
  /** Set once a log tab's Follow dropped its first lines: lines read further back would leave a gap, so none are. */
  earlierDropped?: true
}

/** A Follow under way in a log tab: new lines are added as they come, unless it's paused. */
export interface FollowState {
  followId: string
  paused: boolean
  /** Set while it's slowed down: AWS throttling a CloudWatch Logs Source's polling. */
  slowed?: true
}

/** The open tabs, in order, and which one is shown. */
export interface Workspace {
  tabs: OpenTab[]
  activeKey: string | null
}

export const emptyWorkspace: Workspace = { tabs: [], activeKey: null }

/** The Follow a log was read with, if any, running: its tab shows it and stops it when done with it. */
const followOf = (file: TabContent): FollowState | undefined => ('followId' in file ? { followId: file.followId, paused: false } : undefined)

/** Whether a Log Stream, as read, says it has restarted and whether it has Previous Logs at all; nothing for what doesn't say. */
const restartedOf = (file: TabContent): Pick<OpenTab, 'restarted' | 'offersPreviousLog'> =>
  file.view === 'log' && file.of === 'logStream' ? { restarted: file.restarted, offersPreviousLog: file.offersPreviousLog } : {}

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
  const added = { ...tab, follow: followOf(tab.file), ...restartedOf(tab.file), pinned }
  const preview = pinned ? -1 : ws.tabs.findIndex((open) => !open.pinned)
  if (preview >= 0) return { tabs: ws.tabs.with(preview, added), activeKey: key }
  const active = ws.tabs.findIndex((open) => open.key === ws.activeKey)
  const at = active >= 0 ? active + 1 : ws.tabs.length
  return { tabs: ws.tabs.toSpliced(at, 0, added), activeKey: key }
}

export const activateTab = (ws: Workspace, key: string): Workspace => ({ ...ws, activeKey: key })

/** Activates the tab `delta` places on from the active one (back, if negative), wrapping around at either end. */
export function cycleTab(ws: Workspace, delta: number): Workspace {
  const { tabs } = ws
  if (!tabs.length) return ws
  const active = tabs.findIndex((open) => open.key === ws.activeKey)
  const next = (((active + delta) % tabs.length) + tabs.length) % tabs.length
  return activateTab(ws, tabs[next]!.key)
}

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

/** Marks a log tab as showing what was last read from its Log Stream, which no longer exists; its content stays. */
export const markLogStreamGone = (ws: Workspace, key: string): Workspace => updateTab(ws, key, { logStreamGone: true })

/** Two pieces of a log, one after the other, either of which may have no lines. */
export const joinLines = (first: string, second: string) => (first && second ? `${first}\n${second}` : first || second)

/** Where the lines before a log tab's first end, if it can read them: from a Source Type that can read further back. */
export function earlierOf({ file, loadedEarlier, earlierDropped }: Pick<OpenTab, 'file' | 'loadedEarlier' | 'earlierDropped'>): string | undefined {
  if (earlierDropped || file.view !== 'log' || file.of !== 'logStream') return undefined
  return loadedEarlier ? loadedEarlier.earlier : file.earlier
}

/**
 * Adds lines read further back, from `earlier`, before the first a log tab shows; nothing if it has since been read
 * again, or has had them added already.
 */
export function addEarlierLines(ws: Workspace, key: string, earlier: string, read: EarlierLog): Workspace {
  const tab = ws.tabs.find((open) => open.key === key)
  if (!tab || earlierOf(tab) !== earlier) return ws
  const content = joinLines(read.content, tab.loadedEarlier?.content ?? '')
  return updateTab(ws, key, { loadedEarlier: { content, ...(read.earlier !== undefined && { earlier: read.earlier }) } })
}

/** Notes that a log tab's Follow dropped its first lines, so it no longer reads further back. */
export const dropEarlier = (ws: Workspace, key: string): Workspace => updateTab(ws, key, { earlierDropped: true })

/** Puts a freshly read log in its tab, with the Follow that goes on from it, if any. Pins the tab. */
export function reopenLogTab(ws: Workspace, key: string, file: TabContent): Workspace {
  const tab = ws.tabs.find((open) => open.key === key)
  if (!tab) return ws
  // Read afresh, so from a Log Stream that's there, and with only the lines just read.
  const { logStreamGone: _, loadedEarlier: __, earlierDropped: ___, ...reopened } = tab
  const fresh = { ...reopened, file, follow: followOf(file), ...restartedOf(file), pinned: true }
  return { ...ws, tabs: ws.tabs.map((open) => (open === tab ? fresh : open)) }
}

/** Changes how a log tab is shown or followed, leaving its content as it is. */
export const setLogView = (ws: Workspace, key: string, change: Partial<Pick<OpenTab, 'follow' | 'utc' | 'wrap'>>): Workspace =>
  updateTab(ws, key, change)

/** Notes that a Follow's container restarted, so its tab can switch to the Previous Log. */
export function noteRestart(ws: Workspace, followId: string): Workspace {
  const tab = ws.tabs.find((open) => open.follow?.followId === followId)
  return tab ? updateTab(ws, tab.key, { restarted: true }) : ws
}

/** Notes whether a Follow is slowed down, so its tab can say so. */
export function noteSlowed(ws: Workspace, followId: string, slowed: boolean): Workspace {
  const tab = ws.tabs.find((open) => open.follow?.followId === followId)
  if (!tab?.follow) return ws
  const { slowed: _, ...follow } = tab.follow
  return updateTab(ws, tab.key, { follow: { ...follow, ...(slowed && { slowed }) } })
}

/** Marks a Follow as over in whichever tab it was going on, leaving what it showed; and its Log Stream as gone if that's why. */
export function endFollow(ws: Workspace, followId: string, reason?: FollowEndReason): Workspace {
  const tab = ws.tabs.find((open) => open.follow?.followId === followId)
  if (!tab) return ws
  const gone = reason === 'gone' && tab.file.view === 'log' && tab.file.of === 'logStream'
  return updateTab(ws, tab.key, { follow: undefined, ...(gone && { logStreamGone: true }) })
}

/** The Large Files open in the tabs, which the core keeps (and caches) until they're closed. */
export const largeFileIdsOf = (ws: Workspace) => new Set(ws.tabs.flatMap((tab) => (tab.file.view === 'large' ? [tab.file.largeFileId] : [])))

/** The Follows going on in the tabs. */
export const followIdsOf = (ws: Workspace) => new Set(ws.tabs.flatMap((tab) => (tab.follow ? [tab.follow.followId] : [])))

/** Highlights a tab’s file as `language` instead of the detected one, pinning the tab. */
export const setLanguage = (ws: Workspace, key: string, language: LanguageId): Workspace =>
  updateTab(ws, key, { language, pinned: true })
