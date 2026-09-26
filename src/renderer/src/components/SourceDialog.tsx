import { useState, type FormEvent } from 'react'
import { sourceTypeIds, type NewSource, type SourceInfo } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { t } from '../i18n'
import { uiFor } from '../source-types'
import { useModalDialog } from './use-modal-dialog'

interface Props {
  /** The Source being edited; without one the dialog adds a new Source. */
  editing?: SourceInfo
  onSaved(source: SourceInfo): void
  onClose(): void
}

/** Adds or edits a Source, showing the fields of the chosen Source Type. */
export function SourceDialog({ editing, onSaved, onClose }: Props) {
  const modal = useModalDialog(onClose)
  const [settings, setSettings] = useState<NewSource>(() =>
    editing ? uiFor(editing.type).settingsOf(editing) : uiFor(sourceTypeIds[0]!).blank()
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ui = uiFor(settings.type)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSaved(await (editing ? core.editSource(editing.id, settings) : core.addSource(settings)))
    } catch (e) {
      setError(describeError(e))
      setBusy(false)
    }
  }

  const title = editing ? t('sourceDialog.editTitle', { name: editing.name }) : t('sourceDialog.addTitle')

  return (
    <dialog {...modal} className="dialog" aria-label={title}>
      <form className="dialog__form" onSubmit={submit}>
        <h2 className="dialog__title">{title}</h2>

        {!editing && (
          <fieldset className="type-picker">
            <legend className="field__label">{t('sourceDialog.type')}</legend>
            {sourceTypeIds.map((type) => {
              const { Icon, label, hint } = uiFor(type)
              return (
                <label key={type} className="type-picker__option">
                  <input
                    type="radio"
                    name="source-type"
                    value={type}
                    checked={settings.type === type}
                    onChange={() => setSettings({ ...uiFor(type).blank(), name: settings.name })}
                  />
                  <span className="type-picker__icon">
                    <Icon />
                  </span>
                  <span className="type-picker__text">
                    <span className="type-picker__label">{t(label)}</span>
                    <span className="type-picker__hint">{t(hint)}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        )}

        <label className="field">
          <span className="field__label">{t('sourceDialog.name')}</span>
          <input
            className="field__input"
            value={settings.name}
            placeholder={t('sourceDialog.namePlaceholder')}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
            autoFocus
            spellCheck={false}
          />
        </label>

        <ui.Fields value={settings} onChange={setSettings} />

        {error && (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="button button--quiet" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {t(editing ? 'sourceDialog.save' : 'sourceDialog.add')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
