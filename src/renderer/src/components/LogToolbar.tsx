import type { ReactNode } from 'react'
import type { LastNLines } from '@shared/core-api'
import { t } from '../i18n'
import { formatCount } from '../i18n/format'
import type { SinceChoice } from '../since'
import { canShowPrevious, earlierOf, isLog, offersPrevious, sinceOffered, type OpenTab } from '../workspace'
import { SaveCopyButton } from './FileToolbar'
import { LastNLinesControl } from './LastNLinesControl'
import { SinceControl } from './SinceControl'

interface Props {
  tab: OpenTab
  onChangeLastNLines(value: LastNLines): void
  onChangeSince(value: SinceChoice | undefined): void
  onToggleFollow(): void
  onTogglePause(): void
  onTogglePrevious(): void
  onToggleTimestamps(): void
  onToggleUtc(): void
  onToggleWrap(): void
  /** Reads the lines before the first shown, from a Source Type that can read further back. */
  onLoadEarlier(): void
  /** Saves a copy of the lines shown, asking where; without it, the toolbar offers no "Save a copy…". */
  onSaveCopy?(): void
}

interface ToggleProps {
  pressed: boolean
  disabled?: boolean
  tooltip: string
  onToggle(): void
  children: ReactNode
}

export function Toggle({ pressed, disabled, tooltip, onToggle, children }: ToggleProps) {
  return (
    <button type="button" className="log-toolbar__toggle" aria-pressed={pressed} disabled={disabled} title={tooltip} onClick={onToggle}>
      {children}
    </button>
  )
}

/**
 * The controls at the top of every log view: its "Last N lines", its Since when its Source Type offers it, loading
 * the lines before those shown when its Source Type can, Follow (with pause and resume) for a Log Stream's current log or a file, switching a Log Stream to its Previous Log and back if its Source Type has
 * them, timestamps in local time or UTC for a Log Stream, wrapping, and saving a copy of the lines shown.
 */
export function LogToolbar({ tab, onChangeLastNLines, onChangeSince, onToggleFollow, onTogglePause, onTogglePrevious, onToggleTimestamps, onToggleUtc, onToggleWrap, onLoadEarlier, onSaveCopy }: Props) {
  const { file, follow } = tab
  const log = file.view === 'log' ? file : null
  // Kept by a log that failed to read, for reading it again.
  const timestamps = file.view === 'log' || file.view === 'logFailed' ? file.timestamps : false
  // A file's lines come as they are, with no timestamps to add, and it has no Previous Log.
  const ofFile = isLog(file) && file.of === 'file'
  // A Previous Log has ended: there's nothing to Follow.
  const previous = isLog(file) && file.previous
  const lastNLines = file.view === 'log' || file.view === 'logFailed' ? file.lastNLines : 'all'
  return (
    <div className="log-toolbar">
      <LastNLinesControl value={lastNLines} onChange={onChangeLastNLines} />
      {sinceOffered(tab) && <SinceControl value={tab.since} utc={tab.utc ?? false} onChange={onChangeSince} />}
      {earlierOf(tab) !== undefined && lastNLines !== 'all' && (
        <button type="button" className="button button--quiet" title={lastNLines === 1 ? t('logView.loadEarlier.tooltip.one') : t('logView.loadEarlier.tooltip', { count: formatCount(lastNLines) })} onClick={onLoadEarlier}>
          {t('logView.loadEarlier')}
        </button>
      )}
      <div className="log-toolbar__toggles">
        <Toggle
          pressed={Boolean(follow)}
          disabled={!log || previous}
          tooltip={t(ofFile ? 'logView.follow.file.tooltip' : previous ? 'logView.follow.previous.tooltip' : 'logView.follow.tooltip')}
          onToggle={onToggleFollow}
        >
          {t('logView.follow')}
        </Toggle>
        <Toggle pressed={follow?.paused ?? false} disabled={!follow} tooltip={t('logView.pause.tooltip')} onToggle={onTogglePause}>
          {t(follow?.paused ? 'logView.resume' : 'logView.pause')}
        </Toggle>
        {offersPrevious(tab) && (
          <Toggle
            pressed={previous}
            disabled={!canShowPrevious(tab)}
            tooltip={t(canShowPrevious(tab) ? 'logView.previousLog.tooltip' : 'logView.previousLog.unavailable')}
            onToggle={onTogglePrevious}
          >
            {t('logView.previousLog')}
          </Toggle>
        )}
        {!ofFile && (
          <>
            <Toggle pressed={timestamps} disabled={!log} tooltip={t('logView.timestamps.tooltip')} onToggle={onToggleTimestamps}>
              {t('logView.timestamps')}
            </Toggle>
            <Toggle pressed={tab.utc ?? false} disabled={!timestamps} tooltip={t('logView.utc.tooltip')} onToggle={onToggleUtc}>
              {t('logView.utc')}
            </Toggle>
          </>
        )}
        <Toggle pressed={tab.wrap ?? false} disabled={!log} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
        {onSaveCopy && <SaveCopyButton tooltip={t('saveCopy.log.tooltip')} disabled={!log} onSaveCopy={onSaveCopy} />}
      </div>
    </div>
  )
}
