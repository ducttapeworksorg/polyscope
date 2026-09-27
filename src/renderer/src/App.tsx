import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState, EntryNode, OpenedFile, OpenOptions, SourceInfo } from '@shared/core-api'
import type { Settings, Theme } from '@shared/settings'
import { ApertureMark } from './components/icons'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { nodeKey } from './components/SourceTree'
import { StatusBar } from './components/StatusBar'
import { Tabs } from './components/Tabs'
import { Viewer } from './components/Viewer'
import { core, describeError, describeFailure } from './core-client'
import { t } from './i18n'
import { applyTheme } from './theme'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  emptyWorkspace,
  openTab,
  pinTab,
  reopenTab,
  setLanguage,
  type Workspace
} from './workspace'

/** Whether two versions of a Source point at the same place, whatever they are called. */
const sameTarget = (a: SourceInfo, b: SourceInfo) => a.type === b.type && a.rootPath === b.rootPath

export function App() {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const sourcesRef = useRef<SourceInfo[]>([])
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  // Files being opened, by tab key, so a double-click's second click waits for the first instead of reading again.
  const pendingOpens = useRef(new Map<string, Promise<OpenedFile>>())
  // The file asked for last; a slower read of one asked for earlier doesn't take over from it.
  const latestOpen = useRef<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // Mirrors the core's per-Source connection state; a Source with no entry is Disconnected.
  const [connections, setConnections] = useState<ReadonlyMap<string, ConnectionState>>(new Map())
  // Null until loaded; nothing is shown before then, so a saved theme never flashes the other one first.
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // A theme being tried out in the Settings dialog, shown instead of the saved one until it closes.
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null)

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
  const connect = async (source: SourceInfo): Promise<EntryNode[] | null> => {
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
    const previous = new Map(sourcesRef.current.map((s) => [s.id, s]))
    sourcesRef.current = latest
    setSources(latest)
    // The core disconnects a Source that now points somewhere else, and forgets a deleted one.
    setConnections((prev) => {
      const kept = new Map<string, ConnectionState>()
      for (const source of latest) {
        const was = previous.get(source.id)
        const state = prev.get(source.id)
        if (state && was && sameTarget(was, source)) kept.set(source.id, state)
      }
      return kept
    })
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

  useEffect(() => {
    void reloadSources()
  }, [reloadSources])

  const { tabs } = workspace
  const activeTab = tabs.find((tab) => tab.key === workspace.activeKey) ?? null

  /** Reads a file to open it, sharing the read with any other click opening the same file meanwhile. */
  const readForOpening = (key: string, sourceId: string, path: string) => {
    let pending = pendingOpens.current.get(key)
    if (!pending) {
      pending = core.openFile(sourceId, path).finally(() => pendingOpens.current.delete(key))
      pendingOpens.current.set(key, pending)
    }
    return pending
  }

  const openFile = async (source: SourceInfo, node: EntryNode, { pinned = false } = {}) => {
    const key = nodeKey(source.id, node.path)
    setOpenError(null)
    latestOpen.current = key
    const open = tabs.find((tab) => tab.key === key)
    if (open) return setWorkspace((ws) => openTab(ws, open, { pinned }))
    setOpening(node.name)
    try {
      const file = await readForOpening(key, source.id, node.path)
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

  // The new value arrives through onSettingsChanged; if it can't be saved, the toggle stays as it was.
  const toggleTreeDetails = async () => {
    if (settings) await core.updateSettings({ showTreeDetails: !settings.showTreeDetails }).catch(() => undefined)
  }

  if (!settings) return null

  const activeConnection: ConnectionState = (activeTab && connections.get(activeTab.source.id)) || { state: 'disconnected' }

  return (
    <div className="app">
      <Sidebar
        sources={sources}
        connections={connections}
        onConnect={connect}
        onDisconnect={(source) => void disconnect(source)}
        onSourcesChanged={() => void reloadSources()}
        onOpenFile={openFile}
        onOpenSettings={() => setSettingsOpen(true)}
        showDetails={settings.showTreeDetails}
        onToggleDetails={() => void toggleTreeDetails()}
        theme={previewTheme ?? settings.theme}
      />

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onPreviewTheme={setPreviewTheme}
          onSaved={(saved) => {
            setSettings(saved)
            setPreviewTheme(null)
            setSettingsOpen(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <main className="workbench">
        <Tabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
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
        <div className="viewer">
          <Viewer tabs={tabs} activeTab={activeTab} onShowHex={(key) => void reopenTabAs(key, { hex: true })} />
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
        onPickEncoding={(encoding) => activeTab && void reopenTabAs(activeTab.key, encoding ? { encoding } : {})}
        onPickLanguage={(language) => activeTab && setWorkspace((ws) => setLanguage(ws, activeTab.key, language))}
      />
    </div>
  )
}
