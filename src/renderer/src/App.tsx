import { useEffect, useRef, type CSSProperties } from 'react'
import type { ConnectionState } from '@shared/core-api'
import { ApertureMark } from './components/icons'
import { SidebarResizer, sidebarMinWidth, useSidebarWidth, workbenchMinWidth } from './components/SidebarResizer'
import { SourcesPane } from './components/SourcesPane'
import { StatusBar } from './components/StatusBar'
import { Tabs } from './components/Tabs'
import { TabView } from './components/TabView'
import { useSources } from './components/use-sources'
import { useTabs } from './components/use-tabs'
import { useUpdateStatus } from './components/use-update-status'
import { environmentOf } from './environments'
import { t } from './i18n'
import { activateTab, closeAllTabs, closeOtherTabs, closeTab, cycleTab, pinTab, setLanguage } from './workspace'

const viewerPanelId = 'viewer-panel'

export function App() {
  const sourcesModel = useSources({ onSourcesReloaded: (latest) => tabsModel.sourcesReloaded(latest) })
  const tabsModel = useTabs({ onSourcesChanged: () => sourcesModel.reloadSources() })
  const { settings, sources, environments, connections, setSettingsOpen } = sourcesModel
  const { tabs, activeTab, setWorkspace } = tabsModel
  const update = useUpdateStatus()
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  const sidebarRef = useRef<HTMLElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)

  // Ctrl+, opens the Settings; Ctrl+0 takes the keyboard to the sidebar, and Ctrl+1 to what the active tab shows.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const shortcut = { ',': () => setSettingsOpen(true), '0': focusSidebar, '1': focusViewer }[event.key]
      // A dialog keeps the keyboard until it closes.
      if (!shortcut || document.querySelector('dialog:modal')) return
      event.preventDefault()
      event.stopPropagation()
      shortcut()
    }
    // Taken ahead of the editor, like the tabs' shortcuts.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Shown focused, as it's the keyboard that moved there, though Ctrl held down wouldn't show it by itself.
  const shownFocus = { focusVisible: true }

  /** Focuses the sidebar where the keyboard was last in it: its selected row if shown, or else the first Source; with none, adding one. */
  const focusSidebar = () => {
    const sidebar = sidebarRef.current
    const target =
      sidebar?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"][tabindex="0"]') ??
      sidebar?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
      sidebar?.querySelector<HTMLElement>('.sidebar__empty button')
    target?.focus(shownFocus)
  }

  /** Focuses what the active tab shows: the editor, a Large File's lines, or the button offered in their place. */
  const focusViewer = () => {
    const shown = '.viewer__editor:not([hidden]) textarea, .large-file__scroller, .viewer__binary button'
    viewerRef.current?.querySelector<HTMLElement>(shown)?.focus(shownFocus)
  }

  if (!settings) return null

  const activeEnvironment = activeTab ? environmentOf(environments, activeTab.source) : undefined
  const activeConnection: ConnectionState = (activeTab && connections.get(activeTab.source.id)) || { state: 'disconnected' }

  // A narrower window takes its room from the sidebar first, down to the sidebar's own minimum.
  const layout = { '--sidebar-width': `max(${sidebarMinWidth}px, min(${sidebarWidth}px, 100vw - ${workbenchMinWidth}px))` } as CSSProperties

  return (
    <div className="app" style={layout}>
      <SourcesPane
        ref={sidebarRef}
        model={{ ...sourcesModel, settings }}
        update={update}
        onOpenFile={tabsModel.openFile}
        onOpenLog={tabsModel.openLog}
        onFollowFile={(source, node) => void tabsModel.followFile(source, node)}
      />
      <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />

      <main className="workbench">
        <Tabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
          environments={environments}
          onActivate={(key) => setWorkspace((ws) => activateTab(ws, key))}
          onCycle={(delta) => setWorkspace((ws) => cycleTab(ws, delta))}
          onPin={(key) => setWorkspace((ws) => pinTab(ws, key))}
          onReload={(key) => void tabsModel.reopenTabAs(key)}
          onFollow={tabsModel.followTab}
          onClose={(key) => setWorkspace((ws) => closeTab(ws, key))}
          onCloseOthers={(key) => setWorkspace((ws) => closeOtherTabs(ws, key))}
          onCloseAll={() => setWorkspace(closeAllTabs)}
          minimap={settings.showMinimap}
          onToggleMinimap={() => void sourcesModel.toggleMinimap()}
          panelId={viewerPanelId}
        />
        <TabView
          viewerRef={viewerRef}
          model={tabsModel}
          settings={settings}
          connection={activeConnection}
          onReconnect={() => activeTab && void sourcesModel.connect(activeTab.source)}
          panelId={viewerPanelId}
        >
          <div className="viewer__empty">
            <ApertureMark />
            <p>{tabsModel.opening ? t('viewer.opening', { name: tabsModel.opening }) : t(sources.length ? 'viewer.empty.noTabs' : 'viewer.empty.noSources')}</p>
          </div>
        </TabView>
      </main>

      <StatusBar
        activeTab={activeTab}
        environment={activeEnvironment}
        onPickEncoding={(encoding) =>
          // A Large File opened in the editor anyway stays in the editor in its new encoding.
          activeTab && void tabsModel.reopenTabAs(activeTab.key, { ...(activeTab.openAs?.inEditor && { inEditor: true }), ...(encoding && { encoding }) })
        }
        onPickLanguage={(language) => activeTab && setWorkspace((ws) => setLanguage(ws, activeTab.key, language))}
        logLineCount={activeTab?.follow ? tabsModel.followedLineCounts.get(activeTab.follow.followId) : undefined}
        update={update}
      />
    </div>
  )
}
