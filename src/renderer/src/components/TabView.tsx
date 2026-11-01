import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react'
import type { ConnectionState } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import { describeFailure } from '../core-client'
import { t } from '../i18n'
import type { LevelCounts } from '../log-entries'
import { logLevels } from '../log-level'
import { hiddenLevelsOf, isLog, noEventsNote, offersLevelFilter, tabName, type OpenTab } from '../workspace'
import { FileToolbar } from './FileToolbar'
import { LogToolbar } from './LogToolbar'
import type { TabsModel } from './use-tabs'
import { Viewer, type ShownLines } from './Viewer'

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
  /** Saves a copy of a tab's file, asking where; without it, files offer no "Save a copy…". */
  onSaveCopy?(tab: OpenTab): void
  /** Saves a copy of a log tab's lines, as shown, one per line, asking where; without it, logs offer no "Save a copy…". */
  onSaveLogCopy?(tab: OpenTab, lines: string[]): void
  /** Shown in the viewer when no tab is active. */
  children?: ReactNode
}

/**
 * What the active tab shows: any error opening it, banners for a Disconnected Source, a pod or Log Stream that's gone or
 * a slowed Follow, its toolbar, and the viewer.
 */
export function TabView({ viewerRef, model, settings, connection, onReconnect, panelId, onOpenAnyway, onSaveCopy, onSaveLogCopy, children }: Props) {
  const { tabs, activeTab, openError } = model
  const shownLines = useRef<ShownLines | null>(null)
  // How many Log Entries of each Log Level each tab's log has, as its viewer last said.
  const [levelCounts, setLevelCounts] = useState<ReadonlyMap<string, LevelCounts>>(new Map())
  const noteLevelCounts = useCallback((key: string, counts: LevelCounts) => setLevelCounts((prev) => new Map(prev).set(key, counts)), [])
  const activeCounts = activeTab && levelCounts.get(activeTab.key)
  const noEvents = activeTab && noEventsNote(activeTab)
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
      {activeTab?.logStreamGone && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{t('viewer.logStreamGone', { name: activeTab.file.name })}</span>
        </div>
      )}
      {activeTab?.follow?.slowed && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{t('viewer.followSlowed')}</span>
        </div>
      )}
      {noEvents && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{noEvents}</span>
        </div>
      )}
      {activeTab?.podGone && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{t('viewer.podGone', { pod: activeTab.podGone })}</span>
        </div>
      )}
      {activeTab && (activeTab.file.view === 'log' || activeTab.file.view === 'editor') && offersLevelFilter(activeTab) && hiddenLevelsOf(activeTab).length === logLevels.length && (
        <div className="workbench__banner" role="status">
          <span className="workbench__banner-text">{t('viewer.allLevelsHidden')}</span>
        </div>
      )}
      {activeTab && isLog(activeTab.file) && (
        <LogToolbar
          tab={activeTab}
          onChangeLastNLines={(lastNLines) => void model.changeLastNLines(activeTab.key, lastNLines)}
          onChangeSince={(since) => void model.changeSince(activeTab.key, since)}
          onToggleFollow={() => model.toggleFollow(activeTab.key)}
          onTogglePause={() => model.togglePause(activeTab.key)}
          onTogglePrevious={() => model.togglePrevious(activeTab.key)}
          onTogglePodEvents={() => model.togglePodEvents(activeTab.key)}
          onToggleTimestamps={() => model.toggleTimestamps(activeTab.key)}
          onToggleUtc={() => model.toggleUtc(activeTab.key)}
          onToggleWrap={() => model.toggleWrap(activeTab.key)}
          {...(activeCounts && { levelCounts: activeCounts })}
          onToggleLevel={(level) => model.toggleLevel(activeTab.key, level)}
          onLoadEarlier={() => void model.loadEarlier(activeTab.key)}
          {...(onSaveLogCopy && {
            onSaveCopy: () => {
              const lines = shownLines.current?.(activeTab.key)
              if (lines) onSaveLogCopy(activeTab, lines)
            }
          })}
        />
      )}
      {activeTab && (activeTab.file.view === 'editor' || activeTab.file.view === 'hex' || activeTab.file.view === 'binary') && (
        <FileToolbar
          tab={activeTab}
          onToggleWrap={() => model.toggleWrap(activeTab.key)}
          {...(activeCounts && { levelCounts: activeCounts })}
          onToggleLevel={(level) => model.toggleLevel(activeTab.key, level)}
          {...(onSaveCopy && { onSaveCopy: () => onSaveCopy(activeTab) })}
        />
      )}
      <div
        ref={viewerRef}
        id={panelId}
        className="viewer"
        role={activeTab ? 'tabpanel' : undefined}
        aria-label={activeTab ? tabName(activeTab) : undefined}
      >
        <Viewer
          tabs={tabs}
          activeTab={activeTab}
          onShowHex={(key) => void model.reopenTabAs(key, { hex: true })}
          onShowWholeLog={(key) => void model.reopenLog(key, { lastNLines: 'all', allowLarge: true })}
          largeFileThreshold={settings.largeFileThreshold}
          openAnywayLimit={settings.openAnywayLimit}
          onOpenAnyway={onOpenAnyway ?? ((key) => void model.reopenTabAs(key, { inEditor: true }))}
          {...(onSaveCopy && activeTab && { onSaveCopy: () => onSaveCopy(activeTab) })}
          followFeed={model.followFeed}
          onLineCount={model.noteLineCount}
          onDroppedLines={model.noteDroppedLines}
          minimap={settings.showMinimap}
          shownLinesRef={shownLines}
          onLevelCounts={noteLevelCounts}
        />
        {!activeTab && children}
      </div>
    </>
  )
}
