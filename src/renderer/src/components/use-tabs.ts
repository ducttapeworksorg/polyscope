import { useEffect, useRef, useState } from 'react'
import type { ContainerNode, EntryNode, LastNLines, OpenLogOptions, OpenOptions, SourceInfo } from '@shared/core-api'
import { core, CoreCallError, describeError } from '../core-client'
import { createFollowFeed } from '../follow-feed'
import { targetOf } from '../source-types'
import {
  activateTab,
  emptyWorkspace,
  endFollow,
  followIdsOf,
  isLog,
  largeFileIdsOf,
  markPodGone,
  noteRestart,
  openTab,
  pinTab,
  reopenLogTab,
  reopenTab,
  setLogView,
  type LogFailed,
  type LogTooLarge,
  type TabContent,
  type Workspace
} from '../workspace'
import { nodeKey } from './SourceTree'

interface Options {
  /** A Source's settings were changed from a tab (its "Last N lines"); the caller reloads the Sources. */
  onSourcesChanged(): Promise<void>
}

/** Whether two versions of a Source point at the same place, whatever they are called. */
const sameTarget = (a: SourceInfo, b: SourceInfo) => targetOf(a) === targetOf(b)

/**
 * The open tabs and what each shows: opening files and Log Streams into them, Following, and their
 * toolbars' actions. A Follow or Large File no tab has any more is stopped or let go.
 */
export function useTabs({ onSourcesChanged }: Options) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  // Files and logs being opened, by tab key, so a double-click's second click waits for the first instead of reading again.
  const pendingOpens = useRef(new Map<string, Promise<TabContent>>())
  // The file asked for last; a slower read of one asked for earlier doesn't take over from it.
  const latestOpen = useRef<string | null>(null)
  // The fetch of a log tab's lines asked for last, by tab key.
  const latestLogFetch = useRef(new Map<string, object>())
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // Hands each Follow's new lines to the log view showing it; made once, as it's subscribed for good.
  const [followFeed] = useState(() => createFollowFeed(core.onFollowEvent))
  // How many lines each followed log's view holds, by Follow, once lines have been added.
  const [followedLineCounts, setFollowedLineCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const pendingLineCounts = useRef(new Map<string, number>())
  // The Follows the tabs had when last rendered, to stop those they no longer have.
  const shownFollows = useRef(new Set<string>())
  // Likewise the Large Files, to close those they no longer have.
  const shownLargeFiles = useRef(new Set<string>())

  const { tabs } = workspace
  const activeTab = tabs.find((tab) => tab.key === workspace.activeKey) ?? null

  // A Follow that ends by itself (its container finished, its Source disconnected…) leaves its tab showing what it got.
  // One whose container restarts lets its tab switch to the Previous Log.
  useEffect(
    () =>
      core.onFollowEvent((event) => {
        if (event.kind === 'ended') setWorkspace((ws) => endFollow(ws, event.followId))
        if (event.kind === 'restarted') setWorkspace((ws) => noteRestart(ws, event.followId))
      }),
    []
  )

  // A Follow no tab has any more (its tab closed, turned off, replaced on reopening) is stopped.
  useEffect(() => {
    const current = followIdsOf(workspace)
    for (const followId of shownFollows.current) {
      if (current.has(followId)) continue
      void core.stopFollow(followId).catch(() => undefined)
      followFeed.forget(followId)
      setFollowedLineCounts((counts) => {
        const next = new Map(counts)
        next.delete(followId)
        return next
      })
    }
    shownFollows.current = current
  }, [workspace, followFeed])

  // A Large File no tab has any more (its tab closed, or reopened as another) is let go, stopping its caching.
  useEffect(() => {
    const current = largeFileIdsOf(workspace)
    for (const largeFileId of shownLargeFiles.current) {
      if (!current.has(largeFileId)) void core.closeLargeFile(largeFileId).catch(() => undefined)
    }
    shownLargeFiles.current = current
  }, [workspace])

  /** Tabs follow a rename of their Source, but close when it's deleted or now points somewhere else. */
  const sourcesReloaded = (sources: SourceInfo[]) => {
    const byId = new Map(sources.map((s) => [s.id, s]))
    setWorkspace((prev) => {
      const tabs = prev.tabs.flatMap((tab) => {
        const source = byId.get(tab.source.id)
        return source && sameTarget(source, tab.source) ? [{ ...tab, source }] : []
      })
      // If the active tab closed along with its Source, the first remaining tab takes over.
      const activeKey = tabs.some((tab) => tab.key === prev.activeKey) ? prev.activeKey : (tabs[0]?.key ?? null)
      return { tabs, activeKey }
    })
  }

  /** Notes how many lines a followed log's view holds, at most once a frame. */
  const noteLineCount = (followId: string, count: number) => {
    const pending = pendingLineCounts.current
    if (!pending.size) {
      requestAnimationFrame(() => {
        const counts = [...pending]
        pending.clear()
        setFollowedLineCounts((prev) => new Map([...prev, ...counts]))
      })
    }
    pending.set(followId, count)
  }

  /** Reads a file or log to open it, sharing the read with any other click opening the same one meanwhile. */
  const readForOpening = (key: string, read: () => Promise<TabContent>) => {
    let pending = pendingOpens.current.get(key)
    if (!pending) {
      pending = read().finally(() => pendingOpens.current.delete(key))
      pendingOpens.current.set(key, pending)
    }
    return pending
  }

  /**
   * Fetches a container's log (or, as `options` asks, its Previous Log), or a file's last lines, and Follows it when `following`.
   * When all of it is asked for but it's over the Large File threshold, the tab says so instead of showing
   * it, until the user goes ahead or picks fewer lines.
   */
  const readLog = async (sourceId: string, log: Omit<LogTooLarge, 'view'>, options: OpenLogOptions = {}, following = false): Promise<TabContent> => {
    const { of, path } = log
    try {
      if (of === 'logStream') return await (following ? core.followLog(sourceId, path, options) : core.openLog(sourceId, path, options))
      // A file's lines have no timestamps to show, nor a Previous Log.
      const { timestamps: _, previous: __, ...fileOptions } = options
      return await (following ? core.followFile(sourceId, path, fileOptions) : core.openFileLog(sourceId, path, fileOptions))
    } catch (error) {
      if (!(error instanceof CoreCallError) || error.code !== 'LOG_TOO_LARGE') throw error
      return { view: 'logTooLarge', ...log }
    }
  }

  const openFile = (source: SourceInfo, node: Pick<EntryNode, 'path' | 'name'>, options?: { pinned: boolean }) =>
    openInTab(source, node, options, () => core.openFile(source.id, node.path))

  /** Opens a container's log Following it, as it's live. */
  const openLog = (source: SourceInfo, node: Pick<ContainerNode, 'path' | 'name'>, options?: { pinned: boolean }) =>
    openInTab(source, node, options, () => readLog(source.id, { of: 'logStream', path: node.path, name: node.name, previous: false }, {}, true))

  /**
   * Follows a file in a log view, starting from its last lines: in its tab, if it's open (in the editor
   * or not), or else in a new one. Either way the tab is pinned, as following is working with it.
   */
  const followFile = (source: SourceInfo, node: { path: string; name: string }) => {
    const key = nodeKey(source.id, node.path)
    if (!tabs.some((tab) => tab.key === key)) {
      const read = () => readLog(source.id, { of: 'file', path: node.path, name: node.name, previous: false }, {}, true)
      return openInTab(source, node, { pinned: true }, read)
    }
    setWorkspace((ws) => activateTab(ws, key))
    return reopenLog(key, {}, true)
  }

  const openInTab = async (
    source: SourceInfo,
    node: { path: string; name: string },
    { pinned = false } = {},
    read: () => Promise<TabContent>
  ) => {
    const key = nodeKey(source.id, node.path)
    setOpenError(null)
    latestOpen.current = key
    const open = tabs.find((tab) => tab.key === key)
    if (open) return setWorkspace((ws) => openTab(ws, open, { pinned }))
    setOpening(node.name)
    try {
      const file = await readForOpening(key, read)
      if (latestOpen.current === key) setWorkspace((ws) => openTab(ws, { key, source, file }, { pinned }))
    } catch (error) {
      if (latestOpen.current === key) setOpenError(describeError(error))
    } finally {
      if (latestOpen.current === key) setOpening(null)
    }
  }

  /**
   * Reads a tab's file again, `openAs` the way asked (another encoding, as hex), or by default the
   * way it was read last. That counts as working with the tab, so it's pinned rather than left for
   * the next preview.
   */
  const reopenTabAs = async (key: string, openAs?: OpenOptions) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab) return
    if (isLog(tab.file)) return reopenLog(key)
    const options = openAs ?? tab.openAs ?? {}
    setOpenError(null)
    setWorkspace((ws) => pinTab(ws, key))
    try {
      const file = await core.openFile(tab.source.id, tab.file.path, options)
      setWorkspace((ws) => reopenTab(ws, key, file, options))
    } catch (error) {
      // Replaced, say by a rollout: the tab keeps what it last read, saying where that came from.
      if (error instanceof CoreCallError && error.code === 'POD_GONE') {
        setWorkspace((ws) => markPodGone(ws, key, tab.file.path.split('/')[0]!))
      } else setOpenError(describeError(error))
    }
  }

  /**
   * Fetches a log tab's lines again: as many as `options` asks for, or else as many as it shows, with or
   * without timestamps likewise, and of the container's current log or its Previous Log likewise. Following
   * goes on (from the new lines) if it was, unless `following` says otherwise. A file open in the editor moves
   * to a log view, with its Source's "Last N lines". Pins the tab.
   */
  const reopenLog = async (key: string, options: OpenLogOptions = {}, following?: boolean) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab) return
    const { file } = tab
    const previous = options.previous ?? (isLog(file) && file.previous)
    const log = isLog(file)
      ? { of: file.of, path: file.path, name: file.name, previous }
      : { of: 'file' as const, path: file.path, name: file.name, previous: false }
    const shown = file.view === 'log' || file.view === 'logFailed' ? file.lastNLines : file.view === 'logTooLarge' ? 'all' : undefined
    const timestamps = (file.view === 'log' || file.view === 'logFailed') && file.timestamps
    // Only the latest fetch for a tab lands: picking 1K then 50K quickly must end on 50K, whichever answers first.
    const request = {}
    latestLogFetch.current.set(key, request)
    const isLatest = () => latestLogFetch.current.get(key) === request
    setOpenError(null)
    setWorkspace((ws) => pinTab(ws, key))
    const lines = shown === undefined ? {} : { lastNLines: shown }
    try {
      // A current log that failed to read had its Follow stopped; read again, it's Followed as when first opened.
      const retrying = file.view === 'logFailed' && !previous
      const read = await readLog(tab.source.id, log, { ...lines, timestamps, ...options, previous }, following ?? (Boolean(tab.follow) || retrying))
      if (isLatest()) setWorkspace((ws) => reopenLogTab(ws, key, read))
      // Overtaken by a later fetch: its Follow is shown nowhere.
      else if ('followId' in read) void core.stopFollow(read.followId).catch(() => undefined)
    } catch (error) {
      if (!isLatest()) return
      // Switching to or from the Previous Log, or trying again after failing to: the tab says why, and can switch back.
      const failsInTab = log.of === 'logStream' && (previous !== (isLog(file) && file.previous) || file.view === 'logFailed')
      if (!failsInTab) return setOpenError(describeError(error))
      const failed: LogFailed = { view: 'logFailed', of: 'logStream', path: log.path, name: log.name, previous, lastNLines: shown ?? 'all', timestamps, message: describeError(error) }
      setWorkspace((ws) => reopenLogTab(ws, key, failed))
    }
  }

  /** Shows another number of a log tab's last lines, and remembers it for the tab's Source. */
  const changeLastNLines = async (key: string, lastNLines: LastNLines) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab) return
    await Promise.all([
      reopenLog(key, { lastNLines }),
      core.rememberLastNLines(tab.source.id, lastNLines).then(onSourcesChanged, (error) => setOpenError(describeError(error)))
    ])
  }

  /** Follows a tab's file in a log view. */
  const followTab = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab) void followFile(tab.source, tab.file)
  }

  /** Turns a log tab's Follow on (fetching its lines afresh to follow on from) or off, keeping what it shows. */
  const toggleFollow = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab?.follow) setWorkspace((ws) => setLogView(ws, key, { follow: undefined }))
    else void reopenLog(key, {}, true)
  }

  /**
   * Switches a container's log tab to its Previous Log, which has ended so isn't followed, or back to its current
   * log, Following it as when first opened.
   */
  const togglePrevious = (key: string) => {
    const file = tabs.find((open) => open.key === key)?.file
    if (!file || !isLog(file) || file.of !== 'logStream') return
    void reopenLog(key, { previous: !file.previous }, file.previous)
  }

  /** Pauses a log tab's Follow, holding its new lines back, or resumes it, showing them. */
  const togglePause = (key: string) => {
    const follow = tabs.find((open) => open.key === key)?.follow
    if (!follow) return
    const paused = !follow.paused
    void (paused ? core.pauseFollow(follow.followId) : core.resumeFollow(follow.followId)).catch((error) => setOpenError(describeError(error)))
    setWorkspace((ws) => setLogView(ws, key, { follow: { ...follow, paused } }))
  }

  /** Fetches a log tab's lines again, with or without their timestamps. */
  const toggleTimestamps = (key: string) => {
    const file = tabs.find((open) => open.key === key)?.file
    if (file?.view === 'log') void reopenLog(key, { timestamps: !file.timestamps })
  }

  /** Shows a log tab's timestamps in UTC, or in local time again; the viewer reformats the lines it has. */
  const toggleUtc = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab) setWorkspace((ws) => setLogView(ws, key, { utc: !tab.utc }))
  }

  /** Wraps a log tab's (or an open file's) long lines, or stops wrapping them. */
  const toggleWrap = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab) setWorkspace((ws) => setLogView(ws, key, { wrap: !tab.wrap }))
  }

  return {
    setWorkspace,
    tabs,
    activeTab,
    /** The name of the file or log being opened, if any. */
    opening,
    openError,
    followFeed,
    followedLineCounts,
    noteLineCount,
    sourcesReloaded,
    openFile,
    openLog,
    followFile,
    followTab,
    reopenTabAs,
    reopenLog,
    changeLastNLines,
    toggleFollow,
    togglePrevious,
    togglePause,
    toggleTimestamps,
    toggleUtc,
    toggleWrap
  }
}

export type TabsModel = ReturnType<typeof useTabs>
