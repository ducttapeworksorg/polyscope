import type { ReactNode } from 'react'
import type { LastNLines } from '@shared/core-api'
import { t } from '../i18n'
import type { OpenTab } from '../workspace'
import { LastNLinesControl } from './LastNLinesControl'

interface Props {
  tab: OpenTab
  onChangeLastNLines(value: LastNLines): void
  onToggleFollow(): void
  onTogglePause(): void
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

function Toggle({ pressed, disabled, tooltip, onToggle, children }: ToggleProps) {
  return (
    <button type="button" className="log-toolbar__toggle" aria-pressed={pressed} disabled={disabled} title={tooltip} onClick={onToggle}>
      {children}
    </button>
  )
}

/**
 * The controls at the top of every log view: its "Last N lines", Follow (with pause and resume) for a
 * container's current log, timestamps in local time or UTC, and wrapping.
 */
export function LogToolbar({ tab, onChangeLastNLines, onToggleFollow, onTogglePause, onToggleTimestamps, onToggleUtc, onToggleWrap }: Props) {
  const { file, follow } = tab
  const log = file.view === 'log' ? file : null
  const timestamps = log?.timestamps ?? false
  return (
    <div className="log-toolbar">
      <LastNLinesControl value={log ? log.lastNLines : 'all'} onChange={onChangeLastNLines} />
      <div className="log-toolbar__toggles">
        {!log?.previous && (
          <>
            <Toggle pressed={Boolean(follow)} disabled={!log} tooltip={t('logView.follow.tooltip')} onToggle={onToggleFollow}>
              {t('logView.follow')}
            </Toggle>
            <Toggle pressed={follow?.paused ?? false} disabled={!follow} tooltip={t('logView.pause.tooltip')} onToggle={onTogglePause}>
              {t(follow?.paused ? 'logView.resume' : 'logView.pause')}
            </Toggle>
          </>
        )}
        <Toggle pressed={timestamps} disabled={!log} tooltip={t('logView.timestamps.tooltip')} onToggle={onToggleTimestamps}>
          {t('logView.timestamps')}
        </Toggle>
        <Toggle pressed={tab.utc ?? false} disabled={!timestamps} tooltip={t('logView.utc.tooltip')} onToggle={onToggleUtc}>
          {t('logView.utc')}
        </Toggle>
        <Toggle pressed={tab.wrap ?? false} disabled={!log} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
      </div>
    </div>
  )
}
