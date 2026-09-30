import { useEffect, useState, type FormEvent } from 'react'
import { MB, settingProblems, themes, type NumberSetting, type Settings, type Theme } from '@shared/settings'
import { canApply, type UpdateStatus } from '@shared/updates'
import { core, describeError } from '../core-client'
import { t } from '../i18n'
import { useModalDialog } from './use-modal-dialog'

interface Props {
  settings: Settings
  update: UpdateStatus
  /** Shows a theme while it is being chosen, or null to go back to the saved one. */
  onPreviewTheme(theme: Theme | null): void
  onManageEnvironments(): void
  onSaved(settings: Settings): void
  onClose(): void
}

// The byte-sized settings are edited in whole megabytes.
const fields: { key: NumberSetting; unit: number; section: 'files' | 'logs' }[] = [
  { key: 'largeFileThreshold', unit: MB, section: 'files' },
  { key: 'openAnywayLimit', unit: MB, section: 'files' },
  { key: 'cacheSizeCap', unit: MB, section: 'files' },
  { key: 'defaultLastNLines', unit: 1, section: 'logs' }
]

/** A typed whole number, or NaN for anything else (which the shared rules then reject). */
const parseWhole = (text: string) => (/^\s*\d+\s*$/.test(text) ? Number(text) : NaN)

const issuesUrl = 'https://github.com/ducttapeworksorg/polyscope/issues'
const licenseUrl = 'https://github.com/ducttapeworksorg/polyscope/blob/main/LICENSE'

/** Edits the app-wide settings. The theme is previewed as soon as it's picked; nothing is saved until Save. */
export function SettingsDialog({ settings, update, onPreviewTheme, onManageEnvironments, onSaved, onClose }: Props) {
  const close = () => {
    onPreviewTheme(null)
    onClose()
  }
  const modal = useModalDialog(close)
  const [theme, setTheme] = useState(settings.theme)
  const [texts, setTexts] = useState(
    () => Object.fromEntries(fields.map(({ key, unit }) => [key, String(settings[key] / unit)])) as Record<NumberSetting, string>
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [diagnostics, setDiagnostics] = useState<'copied' | 'failed' | null>(null)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.polyscope.appVersion().then(setVersion)
  }, [])

  // Settings this dialog doesn't edit, like the sidebar's details toggle, are kept as they are.
  const edited: Settings = {
    ...settings,
    theme,
    ...(Object.fromEntries(fields.map(({ key, unit }) => [key, parseWhole(texts[key]) * unit])) as Record<NumberSetting, number>)
  }
  const problems = settingProblems(edited)
  const valid = Object.keys(problems).length === 0

  const pickTheme = (next: Theme) => {
    setTheme(next)
    onPreviewTheme(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await core.updateSettings(edited))
    } catch (e) {
      setError(describeError(e))
      setBusy(false)
    }
  }

  const copyDiagnostics = async () => {
    setDiagnostics(null)
    try {
      await window.polyscope.copyDiagnostics()
      setDiagnostics('copied')
    } catch {
      setDiagnostics('failed')
    }
  }

  const numberField = ({ key }: (typeof fields)[number]) => {
    const problem = problems[key]
    return (
      <label key={key} className="field">
        <span className="field__label">{t(`settings.${key}`)}</span>
        <input
          className="field__input field__input--number"
          inputMode="numeric"
          value={texts[key]}
          onChange={(e) => setTexts({ ...texts, [key]: e.target.value })}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`setting-${key}-note`}
          spellCheck={false}
        />
        <span id={`setting-${key}-note`} className={problem ? 'field__problem' : 'field__hint'}>
          {problem ? t(`settings.problem.${problem}`) : t(`settings.${key}.hint`)}
        </span>
      </label>
    )
  }

  return (
    <dialog {...modal} className="dialog" aria-label={t('settings.title')}>
      <form className="dialog__form" onSubmit={submit} noValidate>
        <h2 className="dialog__title">{t('settings.title')}</h2>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.appearance')}</legend>
          <div className="segmented" role="radiogroup" aria-label={t('settings.theme')}>
            {themes.map((option) => (
              <label key={option} className="segmented__option">
                <input
                  type="radio"
                  name="theme"
                  value={option}
                  checked={theme === option}
                  onChange={() => pickTheme(option)}
                />
                {t(`settings.theme.${option}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.environments')}</legend>
          <p className="field__hint">{t('environments.intro')}</p>
          <div>
            <button type="button" className="button button--quiet" onClick={onManageEnvironments}>
              {t('settings.manageEnvironments')}
            </button>
          </div>
        </fieldset>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.files')}</legend>
          {fields.filter((f) => f.section === 'files').map(numberField)}
        </fieldset>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.logs')}</legend>
          {fields.filter((f) => f.section === 'logs').map(numberField)}
        </fieldset>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.updates')}</legend>
          {version && <p className="field__hint">{t('settings.version', { version })}</p>}
          <div className="settings-action">
            {canApply(update) ? (
              <button type="button" className="button button--quiet" onClick={() => void window.polyscope.applyUpdate()}>
                {t(update.state === 'available' ? 'settings.downloadUpdate' : 'settings.restartToUpdate')}
              </button>
            ) : (
              <button
                type="button"
                className="button button--quiet"
                disabled={update.state === 'off' || update.state === 'checking' || update.state === 'downloading'}
                onClick={() => void window.polyscope.checkForUpdates()}
              >
                {t('settings.checkForUpdates')}
              </button>
            )}
            <span role="status" className={update.state === 'error' ? 'field__problem' : 'field__hint'}>
              {t(`settings.update.${update.state}`, { ...update })}
            </span>
          </div>
        </fieldset>

        <fieldset className="settings-section">
          <legend className="settings-section__title">{t('settings.help')}</legend>
          <p className="field__hint">
            {t('settings.diagnostics.hint')}{' '}
            <a href={issuesUrl} target="_blank" rel="noreferrer">
              {t('settings.reportIssue')}
            </a>
          </p>
          <div className="settings-action">
            <button type="button" className="button button--quiet" onClick={copyDiagnostics}>
              {t('settings.copyDiagnostics')}
            </button>
            <span role="status" className={diagnostics === 'failed' ? 'field__problem' : 'field__hint'}>
              {diagnostics && t(`settings.diagnostics.${diagnostics}`)}
            </span>
          </div>
          <p className="field__hint">
            {t('settings.disclaimer')}{' '}
            <a href={licenseUrl} target="_blank" rel="noreferrer">
              {t('settings.license')}
            </a>
            .
          </p>
        </fieldset>

        {error && (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="button button--quiet" onClick={close}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={busy || !valid}>
            {t('settings.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
