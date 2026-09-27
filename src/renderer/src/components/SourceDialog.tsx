import { useState, type FormEvent } from 'react'
import { sourceTypeIds, type Environment, type NewSource, type SourceInfo } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { environmentOf } from '../environments'
import { t } from '../i18n'
import { uiFor } from '../source-types'
import { useModalDialog } from './use-modal-dialog'

interface Props {
  /** The Source being edited; without one the dialog adds a new Source. */
  editing?: SourceInfo
  /** The Environments the Source can be labelled with. */
  environments: Environment[]
  onManageEnvironments(): void
  onSaved(source: SourceInfo): void
  onClose(): void
}

type TestRun = { state: 'testing' } | { state: 'passed' } | { state: 'failed'; message: string }

/** Settings with their Environment label set to `environmentId`, or taken off when it's undefined. */
const labelled = ({ environmentId: _, ...settings }: NewSource, environmentId: string | undefined): NewSource =>
  environmentId === undefined ? settings : { ...settings, environmentId }

/** Adds or edits a Source, showing the fields of the chosen Source Type. */
export function SourceDialog({ editing, environments, onManageEnvironments, onSaved, onClose }: Props) {
  const modal = useModalDialog(onClose)
  const [settings, setSettings] = useState<NewSource>(() =>
    editing ? labelled(uiFor(editing.type).settingsOf(editing), editing.environmentId) : uiFor(sourceTypeIds[0]!).blank()
  )
  // A label whose Environment was deleted meanwhile (say, from Manage…) no longer counts.
  const environmentId = environmentOf(environments, settings)?.id
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<TestRun | null>(null)
  const ui = uiFor(settings.type)

  // A test result only speaks for the settings it was run with.
  const change = (next: NewSource) => {
    setSettings(next)
    setTest(null)
  }

  const testConnection = async () => {
    const run: TestRun = { state: 'testing' }
    setTest(run)
    // Settings changed while testing replace the run; its result would describe settings no longer shown.
    const finish = (outcome: TestRun) => setTest((current) => (current === run ? outcome : current))
    try {
      await core.testConnection(settings)
      finish({ state: 'passed' })
    } catch (e) {
      finish({ state: 'failed', message: describeError(e) })
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const saved = labelled(settings, environmentId)
    try {
      onSaved(await (editing ? core.editSource(editing.id, saved) : core.addSource(saved)))
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
                    onChange={() => change(labelled({ ...uiFor(type).blank(), name: settings.name }, settings.environmentId))}
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
            onChange={(e) => change({ ...settings, name: e.target.value })}
            autoFocus
            spellCheck={false}
          />
        </label>

        <div className="field">
          <label className="field__label" htmlFor="source-environment">
            {t('sourceDialog.environment')}
          </label>
          <div className="field__row">
            <select
              id="source-environment"
              className="field__input field__select"
              value={environmentId ?? ''}
              onChange={(e) => change(labelled(settings, e.target.value || undefined))}
            >
              <option value="">{t('sourceDialog.noEnvironment')}</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
            <button type="button" className="button button--quiet" onClick={onManageEnvironments}>
              {t('sourceDialog.manageEnvironments')}
            </button>
          </div>
        </div>

        <ui.Fields value={settings} onChange={change} />

        <div className="dialog__test">
          <button type="button" className="button button--quiet" disabled={test?.state === 'testing'} onClick={testConnection}>
            {t(test?.state === 'testing' ? 'sourceDialog.testing' : 'sourceDialog.test')}
          </button>
          <p className={`dialog__test-result ${test?.state === 'failed' ? 'is-failed' : ''}`} role="status">
            {test?.state === 'passed' && t('sourceDialog.testSucceeded')}
            {test?.state === 'failed' && test.message}
          </p>
        </div>

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
