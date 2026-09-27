import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Environment, NewEnvironment, SourceInfo } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { nextColor } from '../environments'
import { t } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { TrashIcon } from './icons'
import { useModalDialog } from './use-modal-dialog'

interface Props {
  environments: Environment[]
  /** For telling the user which Sources a deletion unlabels. */
  sources: SourceInfo[]
  /** An Environment was added, edited or deleted; the caller reloads Environments and Sources. */
  onChanged(): void
  onClose(): void
}

const settingsOf = ({ name, color, protected: isProtected }: Environment): NewEnvironment => ({ name, color, protected: isProtected })

/** Creates, renames, recolours, protects and deletes Environments. Every change is saved as it's made. */
export function EnvironmentsDialog({ environments, sources, onChanged, onClose }: Props) {
  const modal = useModalDialog(onClose)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Environment | null>(null)
  // The new Environment's colour is suggested until one is picked, so it follows the Environments as they change.
  const [draft, setDraft] = useState<Omit<NewEnvironment, 'color'> & { color?: string }>({ name: '', protected: false })
  const draftColor = draft.color ?? nextColor(environments)

  /** Runs a change, reporting what went wrong; resolves to whether it was saved. */
  const run = async (change: () => Promise<unknown>) => {
    setError(null)
    try {
      await change()
      return true
    } catch (e) {
      setError(describeError(e))
      return false
    } finally {
      onChanged()
    }
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (await run(() => core.addEnvironment({ ...draft, color: draftColor }))) setDraft({ name: '', protected: false })
  }

  const edit = (environment: Environment, change: Partial<NewEnvironment>) =>
    run(() => core.editEnvironment(environment.id, { ...settingsOf(environment), ...change }))

  const labelCount = deleting ? sources.filter((s) => s.environmentId === deleting.id).length : 0

  return (
    <>
      <dialog {...modal} className="dialog dialog--wide" aria-label={t('environments.title')}>
        <div className="dialog__form">
          <h2 className="dialog__title">{t('environments.title')}</h2>
          <p className="dialog__body">{t('environments.intro')}</p>

          {environments.length === 0 ? (
            <p className="env-list__empty">{t('environments.empty')}</p>
          ) : (
            <ul className="env-list" aria-label={t('environments.title')}>
              {environments.map((environment) => (
                <EnvironmentRow
                  key={environment.id}
                  environment={environment}
                  onEdit={(change) => edit(environment, change)}
                  onDelete={() => setDeleting(environment)}
                />
              ))}
            </ul>
          )}

          <form className="env-row env-row--new" onSubmit={add} aria-label={t('environments.add')}>
            <input
              type="color"
              className="env-row__color"
              aria-label={t('environments.newColor')}
              value={draftColor}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            />
            <input
              className="field__input env-row__name"
              aria-label={t('environments.newName')}
              placeholder={t('environments.newName')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              spellCheck={false}
            />
            <label className="env-row__protected">
              <input
                type="checkbox"
                checked={draft.protected ?? false}
                onChange={(e) => setDraft({ ...draft, protected: e.target.checked })}
              />
              {t('environments.protected')}
            </label>
            <button type="submit" className="button button--quiet" disabled={!draft.name.trim()}>
              {t('environments.add')}
            </button>
          </form>

          {error && (
            <p className="dialog__error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog__actions">
            <button type="button" className="button button--primary" onClick={onClose}>
              {t('environments.done')}
            </button>
          </div>
        </div>
      </dialog>

      {deleting && (
        <ConfirmDialog
          title={t('deleteEnvironment.title', { name: deleting.name })}
          body={t(labelCount === 0 ? 'deleteEnvironment.body' : labelCount === 1 ? 'deleteEnvironment.bodyOne' : 'deleteEnvironment.bodyMany', {
            count: labelCount
          })}
          confirmLabel={t('deleteEnvironment.confirm')}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null)
            void run(() => core.deleteEnvironment(deleting.id))
          }}
        />
      )}
    </>
  )
}

interface RowProps {
  environment: Environment
  /** Saves a change; resolves to whether it was saved. */
  onEdit(change: Partial<NewEnvironment>): Promise<boolean>
  onDelete(): void
}

/**
 * One Environment, edited in place: the name when it loses focus or Enter is pressed, the colour once
 * the picker closes (not at every step of a drag), and Protected at once.
 */
function EnvironmentRow({ environment, onEdit, onDelete }: RowProps) {
  const { name, color, protected: isProtected } = environment
  // The name as typed, and the colour while it's being picked, until saved (or refused).
  const [typedName, setTypedName] = useState(name)
  const [pickedColor, setPickedColor] = useState(color)
  useEffect(() => setTypedName(name), [name])
  useEffect(() => setPickedColor(color), [color])

  // React's onChange fires at every step of a drag in the picker; the native change event only once it's picked.
  const colorInput = useRef<HTMLInputElement>(null)
  const onEditRef = useRef(onEdit)
  onEditRef.current = onEdit
  useEffect(() => {
    const input = colorInput.current!
    const save = () => void onEditRef.current({ color: input.value })
    input.addEventListener('change', save)
    return () => input.removeEventListener('change', save)
  }, [])

  const saveName = async () => {
    if (typedName === name) return
    if (!(await onEdit({ name: typedName }))) setTypedName(name)
  }

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Leaving the field saves it, so Enter doesn't save a second time.
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  return (
    <li className="env-row">
      <input
        type="color"
        className="env-row__color"
        ref={colorInput}
        aria-label={t('environments.colorOf', { name })}
        value={pickedColor}
        onChange={(e) => setPickedColor(e.target.value)}
      />
      <input
        className="field__input env-row__name"
        aria-label={t('environments.nameOf', { name })}
        value={typedName}
        onChange={(e) => setTypedName(e.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={onNameKeyDown}
        spellCheck={false}
      />
      <label className="env-row__protected" title={t('environments.protected.hint')}>
        <input type="checkbox" checked={isProtected} onChange={(e) => void onEdit({ protected: e.target.checked })} />
        {t('environments.protected')}
      </label>
      <button
        type="button"
        className="icon-button"
        aria-label={t('environments.delete', { name })}
        title={t('environments.delete', { name })}
        onClick={onDelete}
      >
        <TrashIcon />
      </button>
    </li>
  )
}
