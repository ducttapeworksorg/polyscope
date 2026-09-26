import { useEffect, useRef, type SyntheticEvent } from 'react'

/** Shows a `<dialog>` modally while mounted; Escape asks the owner to close it instead of closing it natively. */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])

  const onCancel = (event: SyntheticEvent) => {
    event.preventDefault()
    onClose()
  }

  return { ref, onCancel }
}
