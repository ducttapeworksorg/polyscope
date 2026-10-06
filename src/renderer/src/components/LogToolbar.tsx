import type { ReactNode } from 'react'
import type { LastNLines } from '@shared/core-api'
import { t } from '../i18n'
import { canShowPrevious, isLog, type OpenTab } from '../workspace'
import { LastNLinesControl } from './LastNLinesControl'

interface Props {
  tab: OpenTab
  onChangeLastNLines(value: LastNLines): void
  onToggleFollow(): void
  onTogglePause(): void
  onTogglePrevious(): void
  onToggleTimestamps(): void
  onToggleUtc(): void
  onToggleWrap(): void
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
 * The controls at the top of every log view: its "Last N lines", Follow (with pause and resume) for a
 * container's current log or a file, switching a container's log to its Previous Log and back, timestamps
 * in local time or UTC for a container's log, and wrapping.
 */
export function LogToolbar({ tab, onChangeLastNLines, onToggleFollow, onTogglePause, onTogglePrevious, onToggleTimestamps, onToggleUtc, onToggleWrap }: Props) {
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
        {!ofFile && (
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
      </div>
    </div>
  )
}
