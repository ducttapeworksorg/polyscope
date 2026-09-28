import { t } from '../i18n'
import type { OpenTab } from '../workspace'
import { Toggle } from './LogToolbar'

interface Props {
  tab: OpenTab
  onToggleWrap(): void
}

/** The controls at the top of a file open in the editor, as in a log view: wrapping (not for a hex dump, whose columns it would break). */
export function FileToolbar({ tab, onToggleWrap }: Props) {
  const text = tab.file.view === 'editor'
  return (
    <div className="log-toolbar">
      <div className="log-toolbar__toggles">
        <Toggle pressed={text && (tab.wrap ?? false)} disabled={!text} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
      </div>
    </div>
  )
}
