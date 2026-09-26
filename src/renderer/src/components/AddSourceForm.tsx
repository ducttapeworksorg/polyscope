import { useState, type FormEvent } from 'react'
import type { SourceInfo } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { t } from '../i18n'
import { HardDriveIcon } from './icons'

interface Props {
  onAdded(source: SourceInfo): void
  onCancel(): void
}

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export function AddSourceForm({ onAdded, onCancel }: Props) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const browse = async () => {
    const picked = await window.polyscope.pickFolder()
    if (!picked) return
    setRootPath(picked)
    if (!name.trim()) setName(lastSegment(picked))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onAdded(await core.addSource({ type: 'local', name, rootPath: rootPath.trim() }))
    } catch (e) {
      setError(describeError(e))
      setBusy(false)
    }
  }

  return (
    <form className="add-source" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <h3 className="add-source__title">
        <HardDriveIcon />
        {t('addSource.title')}
      </h3>
      <label className="field">
        <span className="field__label">{t('addSource.name')}</span>
        <input
          className="field__input"
          value={name}
          placeholder={t('addSource.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          spellCheck={false}
        />
      </label>
      <div className="field">
        <label className="field__label" htmlFor="add-source-root">
          {t('addSource.rootPath')}
        </label>
        <div className="field__row">
          <input
            id="add-source-root"
            className="field__input field__input--path"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            spellCheck={false}
          />
          <button type="button" className="button button--quiet" onClick={browse}>
            {t('addSource.browse')}
          </button>
        </div>
      </div>
      {error && (
        <p className="add-source__error" role="alert">
          {error}
        </p>
      )}
      <div className="add-source__actions">
        <button type="button" className="button button--quiet" onClick={onCancel}>
          {t('addSource.cancel')}
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          {t('addSource.submit')}
        </button>
      </div>
    </form>
  )
}
