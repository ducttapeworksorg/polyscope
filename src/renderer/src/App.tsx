import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  ConnectionState,
  ContainerNode,
  EntryNode,
  Environment,
  LastNLines,
  OpenLogOptions,
  OpenOptions,
  PreviousLogNode,
  SourceInfo,
  TreeNode
} from '@shared/core-api'
import type { Settings, Theme } from '@shared/settings'
import { EnvironmentsDialog } from './components/EnvironmentsDialog'
import { ApertureMark } from './components/icons'
import { LogToolbar } from './components/LogToolbar'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SidebarResizer, sidebarMinWidth, useSidebarWidth, workbenchMinWidth } from './components/SidebarResizer'
import { nodeKey } from './components/SourceTree'
import { StatusBar } from './components/StatusBar'
import { Tabs } from './components/Tabs'
import { Viewer } from './components/Viewer'
import { core, CoreCallError, describeError, describeFailure } from './core-client'
import { environmentOf } from './environments'
import { createFollowFeed } from './follow-feed'
import { t } from './i18n'
import { targetOf } from './source-types'
import { applyTheme } from './theme'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  emptyWorkspace,
  endFollow,
  followIdsOf,
  isLog,
  openTab,
  pinTab,
  reopenLogTab,
  reopenTab,
  setLanguage,
  setLogView,
  tabName,
  type TabContent,
  type Workspace
} from './workspace'

/** Whether two versions of a Source point at the same place, whatever they are called. */
const sameTarget = (a: SourceInfo, b: SourceInfo) => targetOf(a) === targetOf(b)

export function App() {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const sourcesRef = useRef<SourceInfo[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  // Files and logs being opened, by tab key, so a double-click's second click waits for the first instead of reading again.
  const pendingOpens = useRef(new Map<string, Promise<TabContent>>())
  // The file asked for last; a slower read of one asked for earlier doesn't take over from it.
  const latestOpen = useRef<string | null>(null)
  // The fetch of a log tab's lines asked for last, by tab key.
  const latestLogFetch = useRef(new Map<string, object>())
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // Mirrors the core's per-Source connection state; a Source with no entry is Disconnected.
  const [connections, setConnections] = useState<ReadonlyMap<string, ConnectionState>>(new Map())
  // Null until loaded; nothing is shown before then, so a saved theme never flashes the other one first.
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // A theme being tried out in the Settings dialog, shown instead of the saved one until it closes.
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null)
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  // Hands each Follow's new lines to the log view showing it; made once, as it's subscribed for good.
  const [followFeed] = useState(() => createFollowFeed(core.onFollowEvent))
  // How many lines each followed log's view holds, by Follow, once lines have been added.
  const [followedLineCounts, setFollowedLineCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const pendingLineCounts = useRef(new Map<string, number>())
  // The Follows the tabs had when last rendered, to stop those they no longer have.
  const shownFollows = useRef(new Set<string>())

  useEffect(() => {
    const unsubscribe = core.onSettingsChanged(setSettings)
    void core.getSettings().then(setSettings)
    return unsubscribe
  }, [])

  const theme = previewTheme ?? settings?.theme
  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === ',' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const setConnection = (sourceId: string, state: ConnectionState) =>
    setConnections((prev) => new Map(prev).set(sourceId, state))

  /** Takes the core's word for a Source's state, e.g. after a call that may have changed it. */
  const syncConnection = async (sourceId: string) => {
    const state = await core.connectionState(sourceId).catch(() => null)
    if (state) setConnection(sourceId, state)
  }

  /** Connects a Source; resolves to its root's children, or null if it couldn't connect. */
  const connect = async (source: SourceInfo): Promise<TreeNode[] | null> => {
    setConnection(source.id, { state: 'connecting' })
    try {
      return await core.connect(source.id)
    } catch {
      return null
    } finally {
      await syncConnection(source.id)
    }
  }

  const disconnect = async (source: SourceInfo) => {
    await core.disconnect(source.id).catch(() => undefined)
    await syncConnection(source.id)
  }

  const reloadSources = useCallback(async () => {
    const latest = await core.listSources()
    const byId = new Map(latest.map((s) => [s.id, s]))
    sourcesRef.current = latest
    setSources(latest)
    // The core disconnects a Source that now points somewhere else or signs in anew, and forgets a deleted one.
    const states = await Promise.all(latest.map((s) => core.connectionState(s.id).catch(() => null)))
    setConnections(new Map(latest.flatMap((s, i) => (states[i] ? [[s.id, states[i]] as const] : []))))
    // Tabs follow a rename, but close when their Source is deleted or now points somewhere else.
    setWorkspace((prev) => {
      const tabs = prev.tabs.flatMap((tab) => {
        const source = byId.get(tab.source.id)
        return source && sameTarget(source, tab.source) ? [{ ...tab, source }] : []
      })
      // If the active tab closed along with its Source, the first remaining tab takes over.
      const activeKey = tabs.some((tab) => tab.key === prev.activeKey) ? prev.activeKey : (tabs[0]?.key ?? null)
      return { tabs, activeKey }
    })
  }, [])

  const reloadEnvironments = useCallback(async () => setEnvironments(await core.listEnvironments()), [])

  useEffect(() => {
    void reloadSources()
    void reloadEnvironments()
  }, [reloadSources, reloadEnvironments])

  const { tabs } = workspace
  const activeTab = tabs.find((tab) => tab.key === workspace.activeKey) ?? null

  // A Follow that ends by itself (its container finished, its Source disconnected…) leaves its tab showing what it got.
  useEffect(
    () =>
      core.onFollowEvent((event) => {
        if (event.kind === 'ended') setWorkspace((ws) => endFollow(ws, event.followId))
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
   * Fetches a container's log (or its Previous Log), and Follows it when `following`. When all of it is
   * asked for but it's over the Large File threshold, the tab says so instead of showing it, until the
   * user goes ahead or picks fewer lines.
   */
  const readLog = async (
    sourceId: string,
    { path, name, previous }: { path: string; name: string; previous: boolean },
    options?: OpenLogOptions,
    following = false
  ): Promise<TabContent> => {
    try {
      return await (following ? core.followLog(sourceId, path, options) : core.openLog(sourceId, path, options))
    } catch (error) {
      if (!(error instanceof CoreCallError) || error.code !== 'LOG_TOO_LARGE') throw error
      return { view: 'logTooLarge', path, name, previous }
    }
  }

  const openFile = (source: SourceInfo, node: EntryNode, options?: { pinned: boolean }) =>
    openInTab(source, node, options, () => core.openFile(source.id, node.path))

  const openLog = (source: SourceInfo, node: ContainerNode | PreviousLogNode, options?: { pinned: boolean }) => {
    const log =
      node.kind === 'previousLog' ? { path: node.path, name: node.container, previous: true } : { path: node.path, name: node.name, previous: false }
    return openInTab(source, { path: log.path, name: tabName(log) }, options, () => readLog(source.id, log))
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
      setOpenError(describeError(error))
    }
  }

  /**
   * Fetches a log tab's lines again: as many as `options` asks for, or else as many as it shows, with or
   * without timestamps likewise. Following goes on (from the new lines) if it was, unless `following` says
   * otherwise. Pins the tab.
   */
  const reopenLog = async (key: string, options: OpenLogOptions = {}, following?: boolean) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab || !isLog(tab.file)) return
    const { path, name, previous } = tab.file
    const shown = tab.file.view === 'log' ? tab.file.lastNLines : 'all'
    const timestamps = tab.file.view === 'log' && tab.file.timestamps
    // Only the latest fetch for a tab lands: picking 1K then 50K quickly must end on 50K, whichever answers first.
    const request = {}
    latestLogFetch.current.set(key, request)
    const isLatest = () => latestLogFetch.current.get(key) === request
    setOpenError(null)
    setWorkspace((ws) => pinTab(ws, key))
    try {
      const file = await readLog(tab.source.id, { path, name, previous }, { lastNLines: shown, timestamps, ...options }, following ?? Boolean(tab.follow))
      if (isLatest()) setWorkspace((ws) => reopenLogTab(ws, key, file))
      // Overtaken by a later fetch: its Follow is shown nowhere.
      else if ('followId' in file) void core.stopFollow(file.followId).catch(() => undefined)
    } catch (error) {
      if (isLatest()) setOpenError(describeError(error))
    }
  }

  /** Shows another number of a log tab's last lines, and remembers it for the tab's Source. */
  const changeLastNLines = async (key: string, lastNLines: LastNLines) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab) return
    await Promise.all([
      reopenLog(key, { lastNLines }),
      core.rememberLastNLines(tab.source.id, lastNLines).then(reloadSources, (error) => setOpenError(describeError(error)))
    ])
  }

  /** Turns a log tab's Follow on (fetching its lines afresh to follow on from) or off, keeping what it shows. */
  const toggleFollow = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab?.follow) setWorkspace((ws) => setLogView(ws, key, { follow: undefined }))
    else void reopenLog(key, {}, true)
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

  /** Wraps a log tab's long lines, or stops wrapping them. */
  const toggleWrap = (key: string) => {
    const tab = tabs.find((open) => open.key === key)
    if (tab) setWorkspace((ws) => setLogView(ws, key, { wrap: !tab.wrap }))
  }

  // The new value arrives through onSettingsChanged; if it can't be saved, the toggle stays as it was.
  const toggleTreeDetails = async () => {
    if (settings) await core.updateSettings({ showTreeDetails: !settings.showTreeDetails }).catch(() => undefined)
  }

  if (!settings) return null

  const activeEnvironment = activeTab ? environmentOf(environments, activeTab.source) : undefined
  const activeConnection: ConnectionState = (activeTab && connections.get(activeTab.source.id)) || { state: 'disconnected' }

  // A narrower window takes its room from the sidebar first, down to the sidebar's own minimum.
  const layout = { '--sidebar-width': `max(${sidebarMinWidth}px, min(${sidebarWidth}px, 100vw - ${workbenchMinWidth}px))` } as CSSProperties

  return (
    <div className="app" style={layout}>
      <Sidebar
        sources={sources}
        environments={environments}
        onManageEnvironments={() => setEnvironmentsOpen(true)}
        connections={connections}
        onConnect={connect}
        onDisconnect={(source) => void disconnect(source)}
        onSourcesChanged={() => void reloadSources()}
        onOpenFile={openFile}
        onOpenLog={openLog}
        onOpenSettings={() => setSettingsOpen(true)}
        showDetails={settings.showTreeDetails}
        onToggleDetails={() => void toggleTreeDetails()}
        theme={previewTheme ?? settings.theme}
      />
      <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onPreviewTheme={setPreviewTheme}
          onManageEnvironments={() => setEnvironmentsOpen(true)}
          onSaved={(saved) => {
            setSettings(saved)
            setPreviewTheme(null)
            setSettingsOpen(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {environmentsOpen && (
        <EnvironmentsDialog
          environments={environments}
          sources={sources}
          onChanged={() => {
            // Deleting an Environment unlabels its Sources, so both are read again.
            void reloadEnvironments()
            void reloadSources()
          }}
          onClose={() => setEnvironmentsOpen(false)}
        />
      )}

      <main className="workbench">
        <Tabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
          environments={environments}
          onActivate={(key) => setWorkspace((ws) => activateTab(ws, key))}
          onPin={(key) => setWorkspace((ws) => pinTab(ws, key))}
          onReload={(key) => void reopenTabAs(key)}
          onClose={(key) => setWorkspace((ws) => closeTab(ws, key))}
          onCloseOthers={(key) => setWorkspace((ws) => closeOtherTabs(ws, key))}
          onCloseAll={() => setWorkspace(closeAllTabs)}
        />
        {openError && (
          <p className="workbench__error" role="alert">
            {openError}
          </p>
        )}
        {activeTab && activeConnection.state !== 'connected' && (
          <div className="workbench__banner" role="status">
            <span className="workbench__banner-text">
              {t('viewer.disconnected')}
              {activeConnection.state === 'error' && (
                <span className="workbench__banner-detail">{describeFailure(activeConnection)}</span>
              )}
            </span>
            <button
              type="button"
              className="button button--quiet"
              disabled={activeConnection.state === 'connecting'}
              onClick={() => void connect(activeTab.source)}
            >
              {t(activeConnection.state === 'connecting' ? 'viewer.reconnecting' : 'viewer.reconnect')}
            </button>
          </div>
        )}
        {activeTab && isLog(activeTab.file) && (
          <LogToolbar
            tab={activeTab}
            onChangeLastNLines={(lastNLines) => void changeLastNLines(activeTab.key, lastNLines)}
            onToggleFollow={() => toggleFollow(activeTab.key)}
            onTogglePause={() => togglePause(activeTab.key)}
            onToggleTimestamps={() => toggleTimestamps(activeTab.key)}
            onToggleUtc={() => toggleUtc(activeTab.key)}
            onToggleWrap={() => toggleWrap(activeTab.key)}
          />
        )}
        <div className="viewer">
          <Viewer
            tabs={tabs}
            activeTab={activeTab}
            onShowHex={(key) => void reopenTabAs(key, { hex: true })}
            onShowWholeLog={(key) => void reopenLog(key, { lastNLines: 'all', allowLarge: true })}
            largeFileThreshold={settings.largeFileThreshold}
            followFeed={followFeed}
            onLineCount={noteLineCount}
          />
          {!activeTab && (
            <div className="viewer__empty">
              <ApertureMark />
              <p>{opening ? t('viewer.opening', { name: opening }) : t(sources.length ? 'viewer.empty.noTabs' : 'viewer.empty.noSources')}</p>
            </div>
          )}
        </div>
      </main>

      <StatusBar
        activeTab={activeTab}
        environment={activeEnvironment}
        onPickEncoding={(encoding) => activeTab && void reopenTabAs(activeTab.key, encoding ? { encoding } : {})}
        onPickLanguage={(language) => activeTab && setWorkspace((ws) => setLanguage(ws, activeTab.key, language))}
        logLineCount={activeTab?.follow ? followedLineCounts.get(activeTab.follow.followId) : undefined}
      />
    </div>
  )
}
