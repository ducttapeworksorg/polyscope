import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  ConnectionState,
  ContainerNode,
  EntryNode,
  Environment,
  LastNLines,
  OpenLogOptions,
  OpenOptions,
  SourceInfo,
  TreeNode
} from '@shared/core-api'
import type { Settings, Theme } from '@shared/settings'
import { EnvironmentsDialog } from './components/EnvironmentsDialog'
import { ApertureMark } from './components/icons'
import { LastNLinesControl } from './components/LastNLinesControl'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SidebarResizer, sidebarMinWidth, useSidebarWidth, workbenchMinWidth } from './components/SidebarResizer'
import { nodeKey } from './components/SourceTree'
import { StatusBar } from './components/StatusBar'
import { Tabs } from './components/Tabs'
import { Viewer } from './components/Viewer'
import { core, CoreCallError, describeError, describeFailure } from './core-client'
import { environmentOf } from './environments'
import { t } from './i18n'
import { targetOf } from './source-types'
import { applyTheme } from './theme'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  emptyWorkspace,
  isLog,
  openTab,
  pinTab,
  reopenTab,
  setLanguage,
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
   * Fetches a container's log. When all of it is asked for but it's over the Large File threshold, the tab
   * says so instead of showing it, until the user goes ahead or picks fewer lines.
   */
  const readLog = async (sourceId: string, path: string, options?: OpenLogOptions): Promise<TabContent> => {
    try {
      return await core.openLog(sourceId, path, options)
    } catch (error) {
      if (!(error instanceof CoreCallError) || error.code !== 'LOG_TOO_LARGE') throw error
      return { view: 'logTooLarge', path, name: path.slice(path.lastIndexOf('/') + 1) }
    }
  }

  const openFile = (source: SourceInfo, node: EntryNode, options?: { pinned: boolean }) =>
    openInTab(source, node, options, () => core.openFile(source.id, node.path))

  const openLog = (source: SourceInfo, node: ContainerNode, options?: { pinned: boolean }) =>
    openInTab(source, node, options, () => readLog(source.id, node.path))

  const openInTab = async (
    source: SourceInfo,
    node: EntryNode | ContainerNode,
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

  /** Fetches a log tab's lines again: as many as `options` asks for, or else as many as it shows. Pins the tab. */
  const reopenLog = async (key: string, options: OpenLogOptions = {}) => {
    const tab = tabs.find((open) => open.key === key)
    if (!tab) return
    const shown = tab.file.view === 'log' ? tab.file.lastNLines : 'all'
    // Only the latest fetch for a tab lands: picking 1K then 50K quickly must end on 50K, whichever answers first.
    const request = {}
    latestLogFetch.current.set(key, request)
    const isLatest = () => latestLogFetch.current.get(key) === request
    setOpenError(null)
    setWorkspace((ws) => pinTab(ws, key))
    try {
      const file = await readLog(tab.source.id, tab.file.path, { lastNLines: shown, ...options })
      if (isLatest()) setWorkspace((ws) => reopenTab(ws, key, file))
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
          <LastNLinesControl
            value={activeTab.file.view === 'log' ? activeTab.file.lastNLines : 'all'}
            onChange={(lastNLines) => void changeLastNLines(activeTab.key, lastNLines)}
          />
        )}
        <div className="viewer">
          <Viewer
            tabs={tabs}
            activeTab={activeTab}
            onShowHex={(key) => void reopenTabAs(key, { hex: true })}
            onShowWholeLog={(key) => void reopenLog(key, { lastNLines: 'all', allowLarge: true })}
            largeFileThreshold={settings.largeFileThreshold}
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
      />
    </div>
  )
}
