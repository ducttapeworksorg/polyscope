import { describeFailure } from '../core-client'
import { t } from '../i18n'
import { formatSize } from '../i18n/format'
import type { ShownSave } from '../save-copies'

interface Props {
  saves: ShownSave[]
  onCancel(saveId: string): void
  onDismiss(saveId: string): void
}

/** The copies of files being saved, at the foot of the workbench: each one's progress and Cancel, then how it ended. */
export function SaveCopies({ saves, onCancel, onDismiss }: Props) {
  if (!saves.length) return null
  return (
    <section className="save-copies" aria-label={t('saveCopy.region')}>
      {saves.map((save) => (
        <SaveRow key={save.saveId} save={save} onCancel={() => onCancel(save.saveId)} onDismiss={() => onDismiss(save.saveId)} />
      ))}
    </section>
  )
}

function SaveRow({ save, onCancel, onDismiss }: { save: ShownSave; onCancel(): void; onDismiss(): void }) {
  const { name, target, status } = save
  if (status.state === 'saving') {
    return (
      <div className="workbench__banner save-copies__row" role="status">
        <span className="workbench__banner-text">{t('saveCopy.saving', { name })}</span>
        <progress
          className="large-file__bar save-copies__bar"
          aria-label={t('saveCopy.progress.label', { name })}
          // Indeterminate until its size is known.
          {...(status.totalBytes > 0 && { max: status.totalBytes, value: status.savedBytes })}
        />
        <span className="save-copies__amount">{t('saveCopy.progress', { saved: formatSize(status.savedBytes), total: formatSize(status.totalBytes) })}</span>
        <button type="button" className="button button--quiet" onClick={onCancel}>
          {t('saveCopy.cancel')}
        </button>
      </div>
    )
  }
  const failed = status.state === 'failed'
  return (
    <div className="workbench__banner save-copies__row" role={failed ? 'alert' : 'status'}>
      <span className="workbench__banner-text" title={failed ? undefined : target}>
        {failed ? t('saveCopy.failed', { name }) : t('saveCopy.saved', { name, target })}
        {failed && <span className="workbench__banner-detail">{describeFailure(status)}</span>}
      </span>
      <button type="button" className="button button--quiet" onClick={onDismiss}>
        {t('saveCopy.dismiss')}
      </button>
    </div>
  )
}
