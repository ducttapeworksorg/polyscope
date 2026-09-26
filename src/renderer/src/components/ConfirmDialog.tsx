import { t } from '../i18n'
import { useModalDialog } from './use-modal-dialog'

interface Props {
  title: string
  body: string
  confirmLabel: string
  onConfirm(): void
  onClose(): void
}

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }: Props) {
  const modal = useModalDialog(onClose)

  return (
    <dialog {...modal} className="dialog" role="alertdialog" aria-label={title}>
      <div className="dialog__form">
        <h2 className="dialog__title">{title}</h2>
        <p className="dialog__body">{body}</p>
        <div className="dialog__actions">
          <button type="button" className="button button--quiet" onClick={onClose} autoFocus>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="button button--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
