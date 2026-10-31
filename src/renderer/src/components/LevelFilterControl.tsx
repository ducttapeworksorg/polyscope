import { t } from '../i18n'
import { formatCount } from '../i18n/format'
import type { LevelCounts } from '../log-entries'
import { logLevels, type LogLevel } from '../log-level'
import { Toggle } from './LogToolbar'

interface Props {
  /** The Log Levels the Level Filter hides. */
  hidden: readonly LogLevel[]
  /** How many Log Entries the log has of each Log Level; unknown until it's shown. */
  counts?: LevelCounts
  disabled?: boolean
  onToggle(level: LogLevel): void
}

/** A log view's Level Filter: a toggle for each Log Level, in its colour, saying how many Log Entries it has. */
export function LevelFilterControl({ hidden, counts, disabled, onToggle }: Props) {
  return (
    <div className="level-filter" role="group" aria-label={t('levelFilter.label')}>
      {logLevels.map((level) => (
        <Toggle key={level} pressed={!hidden.includes(level)} disabled={disabled} tooltip={t(`levelFilter.${level}.tooltip`)} onToggle={() => onToggle(level)}>
          <span className={`level-filter__name level-filter__name--${level}`}>{t(`levelFilter.${level}`)}</span>
          {counts && <span className="level-filter__count">{formatCount(counts[level])}</span>}
        </Toggle>
      ))}
    </div>
  )
}
