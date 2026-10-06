import type { ReactNode, Ref } from 'react'
import type { ConnectionState } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import { describeFailure } from '../core-client'
import { t } from '../i18n'
import { isLog, tabName } from '../workspace'
import { FileToolbar } from './FileToolbar'
import { LogToolbar } from './LogToolbar'
import type { TabsModel } from './use-tabs'
import { Viewer } from './Viewer'

interface Props {
  viewerRef?: Ref<HTMLDivElement>
  /** From useTabs. */
  model: TabsModel
  settings: Settings
  /** The active tab's Source's connection state. */
  connection: ConnectionState
  /** Connects the active tab's Source again. */
  onReconnect(): void
  /** The viewer's id, for the tabs it's the panel of. */
  panelId: string
  /** Opens a Large File in an editor anyway; by default, in the tab's own. */
  onOpenAnyway?(key: string): void
  /** Shown in the viewer when no tab is active. */
  children?: ReactNode
}

/**
 * What the active tab shows: any error opening it, banners for a Disconnected Source or a pod that's gone,
 * its toolbar, and the viewer.
 */
export function TabView({ viewerRef, model, settings, connection, onReconnect, panelId, onOpenAnyway, children }: Props) {
  const { tabs, activeTab, openError } = model
  return (
    <>
      {openError && (
        <p className="workbench__error" role="alert">
          {openError}
        </p>
      )}
      {activeTab && connection.state !== 'connected' && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">
            {t('viewer.disconnected')}
            {connection.state === 'error' && <span className="workbench__banner-detail">{describeFailure(connection)}</span>}
          </span>
          <button type="button" className="button button--quiet" disabled={connection.state === 'connecting'} onClick={onReconnect}>
            {t(connection.state === 'connecting' ? 'viewer.reconnecting' : 'viewer.reconnect')}
          </button>
        </div>
      )}
      {activeTab?.podGone && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{t('viewer.podGone', { pod: activeTab.podGone })}</span>
        </div>
      )}
      {activeTab && isLog(activeTab.file) && (
        <LogToolbar
          tab={activeTab}
          onChangeLastNLines={(lastNLines) => void model.changeLastNLines(activeTab.key, lastNLines)}
          onToggleFollow={() => model.toggleFollow(activeTab.key)}
          onTogglePause={() => model.togglePause(activeTab.key)}
          onTogglePrevious={() => model.togglePrevious(activeTab.key)}
          onToggleTimestamps={() => model.toggleTimestamps(activeTab.key)}
          onToggleUtc={() => model.toggleUtc(activeTab.key)}
          onToggleWrap={() => model.toggleWrap(activeTab.key)}
        />
      )}
      {activeTab && (activeTab.file.view === 'editor' || activeTab.file.view === 'hex') && (
        <FileToolbar tab={activeTab} onToggleWrap={() => model.toggleWrap(activeTab.key)} />
      )}
      <div
        ref={viewerRef}
        id={panelId}
        className="viewer"
        role={activeTab ? 'tabpanel' : undefined}
        aria-label={activeTab ? tabName(activeTab.file) : undefined}
      >
        <Viewer
          tabs={tabs}
          activeTab={activeTab}
          onShowHex={(key) => void model.reopenTabAs(key, { hex: true })}
          onShowWholeLog={(key) => void model.reopenLog(key, { lastNLines: 'all', allowLarge: true })}
          largeFileThreshold={settings.largeFileThreshold}
          openAnywayLimit={settings.openAnywayLimit}
          onOpenAnyway={onOpenAnyway ?? ((key) => void model.reopenTabAs(key, { inEditor: true }))}
          followFeed={model.followFeed}
          onLineCount={model.noteLineCount}
          minimap={settings.showMinimap}
        />
        {!activeTab && children}
      </div>
    </>
  )
}
