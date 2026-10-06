import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/red-hat-mono'
import '../src/styles/app.css'
import './webview.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionState, SourceInfo } from '@shared/core-api'
import type { OpenRequest } from '../../extension/bridge/protocol'
import { ApertureMark } from '../src/components/icons'
import { TabView } from '../src/components/TabView'
import { useSettings } from '../src/components/use-settings'
import { useTabs } from '../src/components/use-tabs'
import { core } from '../src/core-client'
import { t } from '../src/i18n'
import { tabName } from '../src/workspace'
import { bridge } from './bridge'

// A webview can't start a worker from its resources, which are of another origin, but can start one from a blob that
// loads them: so the editor's workers (see monaco.ts) are started that way.
const ResourceWorker = window.Worker
window.Worker = class extends ResourceWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const href = new URL(url, document.baseURI).href
    if (new URL(href).origin === location.origin) {
      super(url, options)
      return
    }
    // Vite builds the workers as classic scripts, whatever type they ask for, and a classic worker can load them
    // from another origin without CORS.
    const load = `importScripts(${JSON.stringify(href)})`
    super(URL.createObjectURL(new Blob([load], { type: 'text/javascript' })), { ...options, type: 'classic' })
  }
}

/** What the extension host opened this tab for. */
const request = JSON.parse(document.getElementById('root')!.dataset['polyscope']!) as OpenRequest

const viewerPanelId = 'viewer-panel'

/** A Polyscope viewer tab in VS Code: the desktop app's viewer and toolbars for one Followed file, Log Stream or Large File. */
function ViewerTab() {
  const { settings } = useSettings()
  const tabs = useTabs({ onSourcesChanged: async () => {} })
  const [source, setSource] = useState<SourceInfo | null>(null)
  // Deleted since the tab was asked for.
  const [sourceGone, setSourceGone] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>({ state: 'connected' })
  const { sourceId, path, name } = request

  const syncConnection = async () => {
    const state = await core.connectionState(sourceId).catch(() => null)
    if (state) setConnection(state)
  }

  // Opens what the tab is for, the way the desktop app opens it in a tab of its own.
  useEffect(() => {
    void core.listSources().then((sources) => {
      const found = sources.find(({ id }) => id === sourceId)
      if (!found) return setSourceGone(true)
      setSource(found)
      if (request.kind === 'follow') void tabs.followFile(found, { path, name })
      else if (request.kind === 'file') void tabs.openFile(found, { path, name }, { pinned: true })
      else void tabs.openLog(found, { path, name }, { pinned: true })
    })
    void syncConnection()
  }, [])

  // Named as the desktop app names its tab, marked while the log view shows the Previous Log.
  const title = tabs.activeTab && tabName(tabs.activeTab.file)
  useEffect(() => {
    if (title) void bridge.retitle(title)
  }, [title])

  // The sidebar connects and disconnects the Source; a Follow ending on its own says it may have.
  useEffect(() => core.onFollowEvent((event) => event.kind === 'ended' && void syncConnection()), [])

  if (!settings) return null

  const reconnect = async () => {
    if (!source) return
    setConnection({ state: 'connecting' })
    await core.connect(source.id).catch(() => undefined)
    await syncConnection()
  }

  return (
    <main className="workbench">
      <TabView
        model={tabs}
        settings={settings}
        connection={connection}
        onReconnect={() => void reconnect()}
        panelId={viewerPanelId}
        // In VS Code's editor rather than this tab's, which then closes.
        onOpenAnyway={() => void bridge.open({ ...request, kind: 'file', pinned: true, inEditor: true })}
      >
        <div className="viewer__empty">
          <ApertureMark />
          {sourceGone && <p>{t('error.SOURCE_NOT_FOUND')}</p>}
          {tabs.opening && <p>{t('viewer.opening', { name: tabs.opening })}</p>}
        </div>
      </TabView>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewerTab />
  </StrictMode>
)
