import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState, EntryNode, SourceInfo } from '@shared/core-api'
import { ApertureMark } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { nodeKey } from './components/SourceTree'
import { Tabs } from './components/Tabs'
import { Viewer } from './components/Viewer'
import { core, describeError, describeFailure } from './core-client'
import { t } from './i18n'
import { uiFor } from './source-types'
import type { OpenTab } from './workspace'

/** Whether two versions of a Source point at the same place, whatever they are called. */
const sameTarget = (a: SourceInfo, b: SourceInfo) => a.type === b.type && a.rootPath === b.rootPath

export function App() {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const sourcesRef = useRef<SourceInfo[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // Mirrors the core's per-Source connection state; a Source with no entry is Disconnected.
  const [connections, setConnections] = useState<ReadonlyMap<string, ConnectionState>>(new Map())

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
    setTabs((prev) =>
      prev.flatMap((tab) => {
        const source = byId.get(tab.source.id)
        return source && sameTarget(source, tab.source) ? [{ ...tab, source }] : []
      })
    )
  }, [])

  useEffect(() => {
    void reloadSources()
  }, [reloadSources])

  // If the active tab closed along with its Source, the first remaining tab takes over.
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null

  const openFile = async (source: SourceInfo, node: EntryNode) => {
    const key = nodeKey(source.id, node.path)
    setOpenError(null)
    if (tabs.some((tab) => tab.key === key)) return setActiveKey(key)
    setOpening(node.name)
    try {
      const file = await core.openFile(source.id, node.path)
      setTabs((prev) => (prev.some((tab) => tab.key === key) ? prev : [...prev, { key, source, file }]))
      setActiveKey(key)
    } catch (error) {
      setOpenError(describeError(error))
    } finally {
      setOpening(null)
    }
  }

  const closeTab = (key: string) => {
    const index = tabs.findIndex((tab) => tab.key === key)
    const remaining = tabs.filter((tab) => tab.key !== key)
    setTabs(remaining)
    if (key === activeTab?.key) setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? null)
  }

  const StatusIcon = activeTab && uiFor(activeTab.source.type).Icon
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
      />

      <main className="workbench">
        <Tabs tabs={tabs} activeKey={activeTab?.key ?? null} onActivate={setActiveKey} onClose={closeTab} />
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
          <Viewer tabs={tabs} activeTab={activeTab} />
          {!activeTab && (
            <div className="viewer__empty">
              <ApertureMark />
              <p>{opening ? t('viewer.opening', { name: opening }) : t(sources.length ? 'viewer.empty.noTabs' : 'viewer.empty.noSources')}</p>
            </div>
          )}
        </div>
      </main>

      <footer className="statusbar">
        {activeTab && StatusIcon && (
          <>
            <span className="statusbar__item">
              <StatusIcon />
              {activeTab.source.name}
            </span>
            <span className="statusbar__item statusbar__item--path">{activeTab.file.path}</span>
          </>
        )}
        <span className="statusbar__item statusbar__item--end">{t('status.readOnly')}</span>
      </footer>
    </div>
  )
}
