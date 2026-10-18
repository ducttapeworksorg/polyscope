import { t } from '../i18n'
import type { OpenTab } from '../workspace'
import { Toggle } from './LogToolbar'

interface Props {
  tab: OpenTab
  onToggleWrap(): void
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
 * The controls at the top of a file open in the editor, shown as hex or as binary, as in a log view: "Save a copy…",
 * and wrapping (only for text: a hex dump's columns it would break).
 */
export function FileToolbar({ tab, onToggleWrap, onSaveCopy }: Props) {
  const text = tab.file.view === 'editor'
  return (
    <div className="log-toolbar">
      <div className="log-toolbar__toggles">
        {onSaveCopy && <SaveCopyButton onSaveCopy={onSaveCopy} />}
        <Toggle pressed={text && (tab.wrap ?? false)} disabled={!text} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
      </div>
    </div>
  )
}
