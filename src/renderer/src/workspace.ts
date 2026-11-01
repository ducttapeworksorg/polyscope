import type {
  EarlierLog,
  FileLog,
  FollowEndReason,
  FollowedFile,
  FollowedLog,
  LanguageId,
  LastNLines,
  LogNode,
  LogOf,
  LogSnapshot,
  OpenedFile,
  OpenOptions,
  LogStreamNode,
  SourceInfo,
  SourcePath
} from '@shared/core-api'
import { followableSourceTypes, kubernetesEventsCapabilities, kubernetesEventsOf, kubernetesEventsPath, kubernetesEventsRowOf, kubernetesPodEventsOf } from '@shared/core-api'
import { t } from './i18n'
import type { LogLevel } from './log-level'
import type { SinceChoice } from './since'

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

/** Whether a log tab offers Since: for a Log Stream whose Source Type offers it, as its log said when last read. */
export const sinceOffered = ({ file, offersSince }: Pick<OpenTab, 'file' | 'offersSince'>) => isLog(file) && file.of === 'logStream' && offersSince === true

/** Whether a Source's files can be Followed: those of Local, Kubernetes Files and SSH Files Sources grow; S3 objects don't. */
export const followsFiles = (source: SourceInfo) => followableSourceTypes.includes(source.type)

/** Whether a tab offers to Follow its file: text of a Source whose files grow, not followed already. */
export const canFollowFile = ({ source, file, follow }: Pick<OpenTab, 'source' | 'file' | 'follow'>) =>
  followsFiles(source) && !follow && (isLog(file) ? file.of === 'file' : file.view === 'editor' || file.view === 'large')

/**
 * What Events a Kubernetes Logs Source's Log Stream is: the namespace's, or those of a pod or Workload (reached from its
 * row); undefined if it's no Events.
 */
const eventsKind = (source: Pick<SourceInfo, 'type'>, path: SourcePath) =>
  source.type !== 'kubernetesLogs' ? undefined
  : path === kubernetesEventsPath ? 'namespace'
  : kubernetesEventsRowOf(path) !== undefined ? 'object'
  : undefined

/**
 * What a log tab of Events says when none were read, the namespace's or a pod's or Workload's: that Kubernetes keeps
 * them only a while. Undefined when some were, or it's no Events.
 */
export const noEventsNote = ({ source, file }: Pick<OpenTab, 'source' | 'file'>) => {
  const kind = file.view === 'log' && file.of === 'logStream' && file.content === '' ? eventsKind(source, file.path) : undefined
  return kind && (kind === 'namespace' ? t('viewer.noEvents') : t('viewer.noEventsOf', { name: file.name }))
}

/** What a tab is called: its file's or container's name, Events or a pod's or Workload's Events, marked for a Previous Log. */
export const tabName = ({ source, file }: { source: Pick<SourceInfo, 'type'>; file: { path: SourcePath; name: string; previous?: boolean } }) => {
  const events = eventsKind(source, file.path)
  const name =
    events === 'namespace' ? t('logView.events')
    : events === 'object' ? t('logView.eventsOf', { name: file.name })
    : file.name
  return file.previous ? t('logView.previous', { name }) : name
}

/**
 * Whether a log tab offers to switch to its container's pod's Events and back: a Kubernetes Logs Source's container's
 * log view does, showing its log, its Previous Log or the Events already; Events' own log views don't.
 */
export const offersPodEvents = ({ source, file, podEventsOf }: Pick<OpenTab, 'source' | 'file' | 'podEventsOf'>) =>
  source.type === 'kubernetesLogs' && isLog(file) && file.of === 'logStream' && (podEventsOf !== undefined || eventsKind(source, file.path) === undefined)

/** Which of its Log Stream's log, its Previous Log or (a container's) its pod's Events a log view shows. */
export type LogShown = 'log' | 'previous' | 'podEvents'

/** What a log tab shows of its Log Stream. */
export const logShownBy = ({ file, podEventsOf }: Pick<OpenTab, 'file' | 'podEventsOf'>): LogShown =>
  podEventsOf ? 'podEvents' : isLog(file) && file.previous ? 'previous' : 'log'

/**
 * What a log tab reads to show `shown`: its Log Stream's log or Previous Log, a container's even while the tab shows
 * its pod's Events; or those Events, named for the pod, with the container to switch back to.
 */
export function logToShow(
  { file, podEventsOf }: Pick<OpenTab, 'file' | 'podEventsOf'>,
  shown: LogShown
): { path: SourcePath; name: string; previous: boolean; podEventsOf?: ContainerLog } {
  const container = podEventsOf ?? { path: file.path, name: file.name }
  if (shown !== 'podEvents') return { ...container, previous: shown === 'previous' }
  const path = kubernetesPodEventsOf(container.path)
  return { path, name: path.split('/').at(-1)!, previous: false, podEventsOf: container }
}

/**
 * What a Kubernetes Logs Source's row offers Show Events for: the Events of its pod or Workload (its own and those of
 * everything it owns), whatever is folded into the row; nothing for any other row. They aren't listed in the tree.
 */
export function eventsOfRow(node: LogNode): LogStreamNode | undefined {
  if (node.kind !== 'group' || (node.kubernetes?.kind !== 'pod' && node.kubernetes?.kind !== 'workload')) return undefined
  const path = kubernetesEventsOf(node.path)
  return { kind: 'logStream', name: node.name, path, capabilities: kubernetesEventsCapabilities, kubernetes: { kind: 'events' } }
}

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
  /** The Log Levels a log view's Level Filter hides; none when left out, as a new tab starts. */
  hiddenLevels?: LogLevel[]
  /** Set, to the pod's name, when a Kubernetes Files tab's pod turned out to be gone: it shows what was last read from it. */
  podGone?: string
  /** Set when a log tab's Log Stream (a container, say) turned out to be gone: it shows what was last read from it. */
  logStreamGone?: true
  /**
   * Set while a container's log tab shows its pod's Events instead of its log: the container, to switch back to. The
   * tab keeps the container's Previous Log meanwhile.
   */
  podEventsOf?: ContainerLog
  /** Whether a log tab's container has restarted, as last read or since seen by its Follow, so has a Previous Log. */
  restarted?: boolean
  /** Whether a log tab's Log Stream's Source Type has Previous Logs, as last read; left out until a read has said. */
  offersPreviousLog?: boolean
  /** Whether a log tab's Log Stream's Source Type offers Since, as last read; left out until a read has said. */
  offersSince?: boolean
  /** How far back a log tab's lines go, kept as it's read again; any time when left out, as a new tab starts. */
  since?: SinceChoice
  /** A log tab's lines read further back, before its content's, as they came, and where the lines before those end. */
  loadedEarlier?: EarlierLog
  /** Set once a log tab's Follow dropped its first lines: lines read further back would leave a gap, so none are. */
  earlierDropped?: true
}

/** A container's Log Stream, which a log tab showing its pod's Events switches back to. */
export interface ContainerLog {
  path: SourcePath
  name: string
}

/** A Follow under way in a log tab: new lines are added as they come, unless it's paused. */
export interface FollowState {
  followId: string
  paused: boolean
  /** Set while it's slowed down: AWS throttling a CloudWatch Logs Source's polling. */
  slowed?: true
}

/** One of the areas the viewer is split into: its open tabs, in order, and which one is shown. */
export interface Pane {
  /** Tells it from the other Panes, whichever place it moves to as Panes before it close. */
  id: number
  tabs: OpenTab[]
  activeKey: string | null
}

/**
 * How the Panes are arranged: one alone, or two side by side or one above the other, `ratio` being the first's share
 * of the room. Each layout holds a fixed number of Panes.
 */
export type Layout = { kind: 'single' } | { kind: 'sideBySide' | 'stacked'; ratio: number }

/**
 * The open tabs, in Panes: a file or Log Stream is open in at most one tab across them all. The active Pane is the one
 * last focused; there's always at least one, which is empty only while no tab is open.
 */
export interface Workspace {
  panes: Pane[]
  activePane: number
  layout: Layout
}

const emptyPane: Pane = { id: 0, tabs: [], activeKey: null }

/** The most Panes a layout holds. */
const maxPanes = 2

export const emptyWorkspace: Workspace = { panes: [emptyPane], activePane: 0, layout: { kind: 'single' } }

/** The Pane last focused, where what's opened goes. */
export const activePaneOf = (ws: Workspace): Pane => ws.panes[ws.activePane] ?? emptyPane

/** The tab a Pane shows. */
export const activeTabIn = ({ tabs, activeKey }: Pane): OpenTab | null => tabs.find((tab) => tab.key === activeKey) ?? null

/** The active Pane's active tab, which the status bar describes. */
export const activeTabOf = (ws: Workspace): OpenTab | null => activeTabIn(activePaneOf(ws))

/** Every open tab, in whichever Pane. */
export const allTabsOf = (ws: Workspace): OpenTab[] => ws.panes.flatMap((pane) => pane.tabs)

/** The open tab with `key`, in whichever Pane holds it. */
export const findTab = (ws: Workspace, key: string): OpenTab | undefined => allTabsOf(ws).find((tab) => tab.key === key)

const paneIndexOf = (ws: Workspace, key: string) => ws.panes.findIndex((pane) => pane.tabs.some((tab) => tab.key === key))

/** Changes the Pane at `index`. */
const withPane = (ws: Workspace, index: number, pane: Pane): Workspace => ({ ...ws, panes: ws.panes.with(index, pane) })

/** The layout shrunk to fit `count` Panes. */
const layoutFor = (layout: Layout, count: number): Layout => (count <= 1 ? { kind: 'single' } : layout)

/**
 * Drops the Panes left with no tabs, unless it's the only one, shrinking the layout to fit; an active Pane dropped
 * passes to its neighbour (the one after, or at the end the one before).
 */
function withoutEmptyPanes(ws: Workspace): Workspace {
  if (ws.panes.every((pane) => pane.tabs.length) || ws.panes.length === 1) return ws
  const kept = ws.panes.filter((pane) => pane.tabs.length)
  if (!kept.length) return emptyWorkspace
  const emptiedBefore = ws.panes.slice(0, ws.activePane).filter((pane) => !pane.tabs.length).length
  const activePane = Math.min(ws.activePane - emptiedBefore, kept.length - 1)
  return { panes: kept, activePane, layout: layoutFor(ws.layout, kept.length) }
}

/** Changes every tab, in whichever Pane: dropping one when `change` gives none, its Pane's first left taking over if it was active. */
export function reviseTabs(ws: Workspace, change: (tab: OpenTab) => OpenTab | undefined): Workspace {
  const panes = ws.panes.map(({ id, tabs, activeKey }) => {
    const revised = tabs.flatMap((tab) => change(tab) ?? [])
    return { id, tabs: revised, activeKey: revised.some((tab) => tab.key === activeKey) ? activeKey : (revised[0]?.key ?? null) }
  })
  return withoutEmptyPanes({ ...ws, panes })
}

/** The Follow a log was read with, if any, running: its tab shows it and stops it when done with it. */
const followOf = (file: TabContent): FollowState | undefined => ('followId' in file ? { followId: file.followId, paused: false } : undefined)

/**
 * Whether a Log Stream, as read, says it has restarted, and whether it has Previous Logs and Since at all; nothing for
 * what doesn't say.
 */
const restartedOf = (file: TabContent): Pick<OpenTab, 'restarted' | 'offersPreviousLog' | 'offersSince'> =>
  file.view === 'log' && file.of === 'logStream' ? { restarted: file.restarted, offersPreviousLog: file.offersPreviousLog, offersSince: file.offersSince } : {}

/** The tab as it's added for a freshly read file. */
const addedTab = (tab: Pick<OpenTab, 'key' | 'source' | 'file'>, pinned: boolean): OpenTab => ({ ...tab, follow: followOf(tab.file), ...restartedOf(tab.file), pinned })

/**
 * Puts a file not open yet in the Pane at `index`, which becomes active: in place of its preview tab or, with none,
 * right after its active tab.
 */
function openInPane(ws: Workspace, index: number, tab: Pick<OpenTab, 'key' | 'source' | 'file'>, pinned: boolean): Workspace {
  const { key } = tab
  const added = addedTab(tab, pinned)
  const pane = ws.panes[index]!
  const { tabs, activeKey } = pane
  const preview = pinned ? -1 : tabs.findIndex((open) => !open.pinned)
  const active = tabs.findIndex((open) => open.key === activeKey)
  const opened = preview >= 0 ? tabs.with(preview, added) : tabs.toSpliced(active >= 0 ? active + 1 : tabs.length, 0, added)
  return { ...withPane(ws, index, { ...pane, tabs: opened, activeKey: key }), activePane: index }
}

/**
 * Shows a file: activating its tab, and that tab's Pane, if it's open already in any Pane; otherwise putting it, in
 * the active Pane, in place of its preview tab or, with none, right after its active tab. Opening as pinned pins it
 * for good.
 */
export function openTab(ws: Workspace, tab: Pick<OpenTab, 'key' | 'source' | 'file'>, { pinned = false } = {}): Workspace {
  if (findTab(ws, tab.key)) return showOpen(ws, tab.key, pinned)
  return openInPane(ws, ws.activePane, tab, pinned)
}

/** Activates an open tab, and its Pane, pinning it if asked. */
function showOpen(ws: Workspace, key: string, pinned: boolean) {
  const shown = activateTab(ws, key)
  return pinned ? pinTab(shown, key) : shown
}

/**
 * Opens a file to the side: in a new Pane after the active one, while the layout has room for one, side by side if
 * it was alone; or else in the next Pane. The Pane it's opened in becomes active. Open already, it's shown as
 * `openTab` shows it; with no tab open at all, it's opened as `openTab` opens it, leaving no empty Pane beside it.
 */
export function openToSide(ws: Workspace, tab: Pick<OpenTab, 'key' | 'source' | 'file'>, { pinned = false } = {}): Workspace {
  if (findTab(ws, tab.key)) return showOpen(ws, tab.key, pinned)
  if (!activePaneOf(ws).tabs.length) return openInPane(ws, ws.activePane, tab, pinned)
  const next = ws.activePane + 1
  if (ws.panes.length >= maxPanes) return openInPane(ws, next % ws.panes.length, tab, pinned)
  const id = Math.max(...ws.panes.map((pane) => pane.id)) + 1
  const layout: Layout = ws.layout.kind === 'single' ? { kind: 'sideBySide', ratio: 0.5 } : ws.layout
  const added: Workspace = { panes: ws.panes.toSpliced(next, 0, { ...emptyPane, id }), activePane: next, layout }
  return openInPane(added, next, tab, pinned)
}

/** Activates a tab, and the Pane holding it. */
export function activateTab(ws: Workspace, key: string): Workspace {
  const index = paneIndexOf(ws, key)
  if (index < 0) return ws
  return { ...withPane(ws, index, { ...ws.panes[index]!, activeKey: key }), activePane: index }
}

/**
 * Activates the tab `delta` places on from the active one (back, if negative) in the active Pane, wrapping around at
 * either end.
 */
export function cycleTab(ws: Workspace, delta: number): Workspace {
  const { tabs, activeKey } = activePaneOf(ws)
  if (!tabs.length) return ws
  const active = tabs.findIndex((open) => open.key === activeKey)
  const next = (((active + delta) % tabs.length) + tabs.length) % tabs.length
  return activateTab(ws, tabs[next]!.key)
}

export const pinTab = (ws: Workspace, key: string): Workspace => updateTab(ws, key, (tab) => (tab.pinned ? tab : { ...tab, pinned: true }))

/**
 * Closes a tab; if it was active in its Pane, the tab taking its place (or, at the end, the one before) becomes active.
 * A Pane left with no tabs closes.
 */
export function closeTab(ws: Workspace, key: string): Workspace {
  const index = paneIndexOf(ws, key)
  if (index < 0) return ws
  const pane = ws.panes[index]!
  const at = pane.tabs.findIndex((open) => open.key === key)
  const tabs = pane.tabs.toSpliced(at, 1)
  const activeKey = key !== pane.activeKey ? pane.activeKey : (tabs[Math.min(at, tabs.length - 1)]?.key ?? null)
  return withoutEmptyPanes(withPane(ws, index, { ...pane, tabs, activeKey }))
}

/** Closes every tab but one in its Pane, which it's left active in, the Pane becoming active too. */
export function closeOtherTabs(ws: Workspace, key: string): Workspace {
  const index = paneIndexOf(ws, key)
  if (index < 0) return ws
  const pane = ws.panes[index]!
  return { ...withPane(ws, index, { ...pane, tabs: pane.tabs.filter((open) => open.key === key), activeKey: key }), activePane: index }
}

/** Closes every tab in the Pane at `index`, by default the active one, which then closes too unless it's the only one. */
export function closeAllTabs(ws: Workspace, index = ws.activePane): Workspace {
  const pane = ws.panes[index]
  return pane ? withoutEmptyPanes(withPane(ws, index, { ...pane, tabs: [], activeKey: null })) : ws
}

/** Makes the Pane at `index` active, as when it's focused; the same Workspace if it is already. */
export const activatePane = (ws: Workspace, index: number): Workspace =>
  index === ws.activePane || !ws.panes[index] ? ws : { ...ws, activePane: index }

/** Changes one tab, in whichever Pane holds it; a tab closed meanwhile (say, while its file was being read) stays closed. */
function updateTab(ws: Workspace, key: string, change: Partial<OpenTab> | ((tab: OpenTab) => OpenTab)): Workspace {
  const index = paneIndexOf(ws, key)
  if (index < 0) return ws
  const pane = ws.panes[index]!
  const changed = (tab: OpenTab) => (typeof change === 'function' ? change(tab) : { ...tab, ...change })
  return withPane(ws, index, { ...pane, tabs: pane.tabs.map((open) => (open.key === key ? changed(open) : open)) })
}

/**
 * Puts a freshly read file in its tab, remembering how it was read (e.g. in an encoding picked for
 * it) so reloads read it the same way. Like any change to a tab, it pins it.
 */
export function reopenTab(ws: Workspace, key: string, file: TabContent, openAs: OpenOptions = {}): Workspace {
  return updateTab(ws, key, (tab) => {
    // Read afresh, so from a pod that's there.
    const { podGone: _, ...reopened } = tab
    return { ...reopened, file, openAs, pinned: true }
  })
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
  const tab = findTab(ws, key)
  if (!tab || earlierOf(tab) !== earlier) return ws
  const content = joinLines(read.content, tab.loadedEarlier?.content ?? '')
  return updateTab(ws, key, { loadedEarlier: { content, ...(read.earlier !== undefined && { earlier: read.earlier }) } })
}

/** Notes that a log tab's Follow dropped its first lines, so it no longer reads further back. */
export const dropEarlier = (ws: Workspace, key: string): Workspace => updateTab(ws, key, { earlierDropped: true })

/**
 * Puts a freshly read log in its tab, with the Follow that goes on from it, if any. Pins the tab. Read as the Events of
 * the pod of the container `podEventsOf`, it shows them in the container's stead, keeping whether the container has a
 * Previous Log and Since; read without, it shows its Log Stream again.
 */
export function reopenLogTab(ws: Workspace, key: string, file: TabContent, podEventsOf?: ContainerLog): Workspace {
  return updateTab(ws, key, (tab) => {
    // Read afresh, so from a Log Stream that's there, and with only the lines just read.
    const { logStreamGone: _, loadedEarlier: __, earlierDropped: ___, podEventsOf: ____, ...reopened } = tab
    // Showing the pod's Events, the tab keeps what its container said of its Previous Log and Since.
    return { ...reopened, file, follow: followOf(file), ...(podEventsOf ? { podEventsOf } : restartedOf(file)), pinned: true }
  })
}

/** Changes how a log tab is shown or followed, leaving its content as it is. */
export const setLogView = (ws: Workspace, key: string, change: Partial<Pick<OpenTab, 'follow' | 'utc' | 'wrap' | 'since'>>): Workspace =>
  updateTab(ws, key, change)

/** Whether a tab's lines can be shown by Log Level: a log's, or a file's highlighted as a log. */
export const offersLevelFilter = ({ file, language }: OpenTab) =>
  isLog(file) || (file.view === 'editor' && (language ?? file.language) === 'log')

/** The Log Levels a tab's Level Filter hides. */
export const hiddenLevelsOf = (tab: OpenTab): LogLevel[] => tab.hiddenLevels ?? []

/** Hides a Log Level in a log view, or shows it again. */
export function toggleLevel(ws: Workspace, key: string, level: LogLevel): Workspace {
  const tab = findTab(ws, key)
  if (!tab) return ws
  const hidden = hiddenLevelsOf(tab)
  return updateTab(ws, key, { hiddenLevels: hidden.includes(level) ? hidden.filter((other) => other !== level) : [...hidden, level] })
}

/** Notes that a Follow's container restarted, so its tab can switch to the Previous Log. */
export function noteRestart(ws: Workspace, followId: string): Workspace {
  const tab = allTabsOf(ws).find((open) => open.follow?.followId === followId)
  return tab ? updateTab(ws, tab.key, { restarted: true }) : ws
}

/** Notes whether a Follow is slowed down, so its tab can say so. */
export function noteSlowed(ws: Workspace, followId: string, slowed: boolean): Workspace {
  const tab = allTabsOf(ws).find((open) => open.follow?.followId === followId)
  if (!tab?.follow) return ws
  const { slowed: _, ...follow } = tab.follow
  return updateTab(ws, tab.key, { follow: { ...follow, ...(slowed && { slowed }) } })
}

/** Marks a Follow as over in whichever tab it was going on, leaving what it showed; and its Log Stream as gone if that's why. */
export function endFollow(ws: Workspace, followId: string, reason?: FollowEndReason): Workspace {
  const tab = allTabsOf(ws).find((open) => open.follow?.followId === followId)
  if (!tab) return ws
  const gone = reason === 'gone' && tab.file.view === 'log' && tab.file.of === 'logStream'
  return updateTab(ws, tab.key, { follow: undefined, ...(gone && { logStreamGone: true }) })
}

/** The Large Files open in `tabs`. */
export const largeFileIdsIn = (tabs: OpenTab[]) => new Set(tabs.flatMap((tab) => (tab.file.view === 'large' ? [tab.file.largeFileId] : [])))

/** The Large Files open in the tabs of every Pane, which the core keeps (and caches) until they're closed. */
export const largeFileIdsOf = (ws: Workspace) => largeFileIdsIn(allTabsOf(ws))

/** The Follows going on in the tabs of every Pane. */
export const followIdsOf = (ws: Workspace) => new Set(allTabsOf(ws).flatMap((tab) => (tab.follow ? [tab.follow.followId] : [])))

/** Highlights a tab’s file as `language` instead of the detected one, pinning the tab. */
export const setLanguage = (ws: Workspace, key: string, language: LanguageId): Workspace =>
  updateTab(ws, key, { language, pinned: true })
