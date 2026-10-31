import { t } from '../i18n'
import type { LevelCounts } from '../log-entries'
import type { LogLevel } from '../log-level'
import { hiddenLevelsOf, offersLevelFilter, type OpenTab } from '../workspace'
import { LevelFilterControl } from './LevelFilterControl'
import { Toggle } from './LogToolbar'

interface Props {
  tab: OpenTab
  onToggleWrap(): void
  /** How many Log Entries the file has of each Log Level, for its Level Filter when it's highlighted as a log. */
  levelCounts?: LevelCounts
  onToggleLevel(level: LogLevel): void
  /** Saves a copy of the file, asking where; without it, the toolbar offers no "Save a copy…". */
  onSaveCopy?(): void
}

/** "Save a copy…", in a file's or a log's toolbar. */
export function SaveCopyButton({ tooltip = t('saveCopy.tooltip'), disabled, onSaveCopy }: { tooltip?: string; disabled?: boolean; onSaveCopy(): void }) {
  return (
    <button type="button" className="log-toolbar__toggle" title={tooltip} disabled={disabled} onClick={onSaveCopy}>
      {t('saveCopy.action')}
    </button>
  )
}

/**
 * The controls at the top of a file open in the editor, shown as hex or as binary, as in a log view: its Level Filter
 * when it's highlighted as a log, "Save a copy…", and wrapping (only for text: a hex dump's columns it would break).
 */
export function FileToolbar({ tab, onToggleWrap, levelCounts, onToggleLevel, onSaveCopy }: Props) {
  const text = tab.file.view === 'editor'
  return (
    <div className="log-toolbar">
      {offersLevelFilter(tab) && <LevelFilterControl hidden={hiddenLevelsOf(tab)} {...(levelCounts && { counts: levelCounts })} onToggle={onToggleLevel} />}
      <div className="log-toolbar__toggles">
        {onSaveCopy && <SaveCopyButton onSaveCopy={onSaveCopy} />}
        <Toggle pressed={text && (tab.wrap ?? false)} disabled={!text} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
      </div>
    </div>
  )
}
