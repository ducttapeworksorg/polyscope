import { Fragment, useEffect, useRef, type CSSProperties } from 'react'
import type { ConnectionState } from '@shared/core-api'
import { ApertureMark } from './components/icons'
import { SaveCopies } from './components/SaveCopies'
import { SidebarResizer, sidebarMinWidth, useSidebarWidth, workbenchMinWidth } from './components/SidebarResizer'
import { PaneDivider, panesMinWidth } from './components/PaneDivider'
import { SourcesPane } from './components/SourcesPane'
import { StatusBar } from './components/StatusBar'
import { Tabs } from './components/Tabs'
import { TabView } from './components/TabView'
import { useSources } from './components/use-sources'
import { useTabs } from './components/use-tabs'
import { useSaveCopies } from './components/use-save-copies'
import { useAppVersion, useUpdateStatus } from './components/use-update-status'
import { environmentOf } from './environments'
import { t } from './i18n'
import {
  activatePane,
  activateTab,
  activeTabIn,
  canMoveToOtherPane,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  cycleTab,
  flipLayout,
  moveTab,
  moveToOtherPane,
  pinTab,
  resetPaneSizes,
  resizePanes,
  setLanguage,
  type Pane,
  type Workspace
} from './workspace'

/** Where the Pane with `id` now is, as Panes before it may have closed; -1 if it's closed itself. */
const indexOfPane = (ws: Workspace, id: number) => ws.panes.findIndex((pane) => pane.id === id)

export function App() {
  const sourcesModel = useSources({ onSourcesReloaded: (latest) => tabsModel.sourcesReloaded(latest) })
  const tabsModel = useTabs({ onSourcesChanged: () => sourcesModel.reloadSources() })
  const { settings, sources, environments, connections, setSettingsOpen } = sourcesModel
  const { workspace, activeTab, setWorkspace } = tabsModel
  const update = useUpdateStatus()
  const saveCopies = useSaveCopies()
  const { saveCopy, saveLogCopy } = saveCopies
  const version = useAppVersion()
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  const sidebarRef = useRef<HTMLElement>(null)
  const panesRef = useRef<HTMLDivElement>(null)

  // Ctrl+, opens the Settings; Ctrl+0 takes the keyboard to the sidebar, and Ctrl+N to what the Nth Pane's tab shows.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      // Ctrl+N with no Nth Pane isn't taken, left to whatever else might want it.
      const pane = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
      const shortcut = paneAt(pane) ? () => focusPane(pane) : { ',': () => setSettingsOpen(true), '0': focusSidebar }[event.key]
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

  /** The Pane at `index`, as shown; undefined if there's none. */
  const paneAt = (index: number) => panesRef.current?.querySelectorAll<HTMLElement>(':scope > .pane')[index]

  /**
   * Makes the Pane at `index` the active one and focuses what its active tab shows: the editor, a Large File's lines, or the button offered
   * in their place. Focusing it would make it active anyway, but a Pane may show nothing to focus.
   */
  const focusPane = (index: number) => {
    setWorkspace((ws) => activatePane(ws, index))
    const shown = '.viewer__editor:not([hidden]) textarea, .large-file__scroller, .viewer__binary button'
    paneAt(index)?.querySelector('.viewer')?.querySelector<HTMLElement>(shown)?.focus(shownFocus)
  }

  if (!settings) return null

  const activeEnvironment = activeTab ? environmentOf(environments, activeTab.source) : undefined

  // A narrower window takes its room from the sidebar first, down to the sidebar's own minimum, two Panes keeping theirs.
  const workbenchMin = panesMinWidth(workspace.layout.kind) ?? workbenchMinWidth
  const layout = { '--sidebar-width': `max(${sidebarMinWidth}px, min(${sidebarWidth}px, 100vw - ${workbenchMin}px))` } as CSSProperties

  const severalPanes = workspace.panes.length > 1

  /** A Pane: its tabs, and what its active tab shows. Focusing it, or pressing in it, makes it the active Pane. */
  const renderPane = (pane: Pane, index: number) => {
    const active = index === workspace.activePane
    const paneTab = activeTabIn(pane)
    const connection: ConnectionState = (paneTab && connections.get(paneTab.source.id)) || { state: 'disconnected' }
    const panelId = `viewer-panel-${pane.id}`
    const focus = () => setWorkspace((ws) => activatePane(ws, indexOfPane(ws, pane.id)))
    const share = workspace.layout.kind === 'single' ? 1 : index === 0 ? workspace.layout.ratio : 1 - workspace.layout.ratio
    return (
      <section
        className={`pane ${severalPanes && active ? 'is-active' : ''}`}
        style={{ flexGrow: share }}
        aria-label={severalPanes ? t('pane.label', { number: index + 1 }) : undefined}
        aria-current={severalPanes && active ? 'true' : undefined}
        onFocus={focus}
        onMouseDown={focus}
      >
        <Tabs
          tabs={pane.tabs}
          activeKey={pane.activeKey}
          paneActive={active}
          environments={environments}
          onActivate={(key) => setWorkspace((ws) => activateTab(ws, key))}
          onCycle={(delta) => setWorkspace((ws) => cycleTab(ws, delta))}
          onPin={(key) => setWorkspace((ws) => pinTab(ws, key))}
          onReload={(key) => void tabsModel.reopenTabAs(key)}
          onFollow={tabsModel.followTab}
          onClose={(key) => setWorkspace((ws) => closeTab(ws, key))}
          onCloseOthers={(key) => setWorkspace((ws) => closeOtherTabs(ws, key))}
          onCloseAll={() => setWorkspace((ws) => closeAllTabs(ws, indexOfPane(ws, pane.id)))}
          minimap={settings.showMinimap}
          onToggleMinimap={() => void sourcesModel.toggleMinimap()}
          panelId={panelId}
          onMoveToOtherPane={(key) => setWorkspace((ws) => moveToOtherPane(ws, key))}
          canMoveToOtherPane={(key) => canMoveToOtherPane(workspace, key)}
          onMoveToNewPane={(key) => setWorkspace((ws) => moveTab(ws, key, 'newPane'))}
          onDropTab={(key, at) => setWorkspace((ws) => moveTab(ws, key, indexOfPane(ws, pane.id), at))}
        />
        <TabView
          model={tabsModel}
          tabs={pane.tabs}
          activeTab={paneTab}
          paneActive={active}
          settings={settings}
          connection={connection}
          onReconnect={() => paneTab && void sourcesModel.connect(paneTab.source)}
          panelId={panelId}
          onSaveCopy={(tab) => void saveCopy(tab.source, tab.file.path, tab.file.name)}
          onSaveLogCopy={(tab, lines) => void saveLogCopy(tab, lines)}
        >
          <div className="viewer__empty">
            <ApertureMark />
            <p>{tabsModel.opening ? t('viewer.opening', { name: tabsModel.opening }) : t(sources.length ? 'viewer.empty.noTabs' : 'viewer.empty.noSources')}</p>
          </div>
        </TabView>
      </section>
    )
  }

  return (
    <div className="app" style={layout}>
      <SourcesPane
        ref={sidebarRef}
        model={{ ...sourcesModel, settings }}
        update={update}
        onOpenFile={tabsModel.openFile}
        onOpenLog={tabsModel.openLog}
        onOpenToSide={(source, node) =>
          void (node.kind === 'logStream' ? tabsModel.openLog(source, node, { toSide: true }) : tabsModel.openFile(source, node, { toSide: true }))
        }
        onFollowFile={(source, node) => void tabsModel.followFile(source, node)}
        onSaveFile={(source, node) => void saveCopy(source, node.path, node.name)}
      />
      <SidebarResizer width={sidebarWidth} workbenchMin={workbenchMin} onResize={setSidebarWidth} />

      <main className="workbench">
        <div ref={panesRef} className={`workbench__panes workbench__panes--${workspace.layout.kind}`}>
          {workspace.panes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && workspace.layout.kind !== 'single' && (
                <PaneDivider
                  kind={workspace.layout.kind}
                  ratio={workspace.layout.ratio}
                  onResize={(ratio, room) => setWorkspace((ws) => resizePanes(ws, ratio, room))}
                  onReset={() => setWorkspace(resetPaneSizes)}
                  onFlip={() => setWorkspace(flipLayout)}
                />
              )}
              {renderPane(pane, index)}
            </Fragment>
          ))}
        </div>
        <SaveCopies saves={saveCopies.saves} onCancel={saveCopies.cancel} onDismiss={saveCopies.dismiss} />
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
        version={version}
      />
    </div>
  )
}
