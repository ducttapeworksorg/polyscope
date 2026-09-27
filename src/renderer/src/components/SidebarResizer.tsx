import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { t } from '../i18n'

export const defaultSidebarWidth = 288
export const sidebarMinWidth = 240
const maxWidth = 640
/** The workbench keeps at least this much of the window, however wide the sidebar is dragged. */
export const workbenchMinWidth = 360
const keyStep = 16

const storageKey = 'polyscope.sidebarWidth'

/** The widest the sidebar may be in the window as it is now. */
const widest = () => Math.max(sidebarMinWidth, Math.min(maxWidth, window.innerWidth - workbenchMinWidth))
const clampWidth = (width: number) => Math.round(Math.min(widest(), Math.max(sidebarMinWidth, width)))

/** The sidebar's width as the user last left it, remembered on this machine. */
export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return saved > 0 ? saved : defaultSidebarWidth
  })
  const save = (next: number) => {
    setWidth(next)
    localStorage.setItem(storageKey, String(next))
  }
  return [width, save] as const
}

interface Props {
  width: number
  onResize(width: number): void
}

/**
 * The sidebar's right edge, dragged to resize it. From the keyboard, arrows step it and Home/End
 * jump to its limits; a double-click puts it back to its default width.
 */
export function SidebarResizer({ width, onResize }: Props) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ startX: event.clientX, startWidth: width })
    document.body.classList.add('is-resizing')
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) onResize(clampWidth(drag.startWidth + event.clientX - drag.startX))
  }

  const endDrag = () => {
    setDrag(null)
    document.body.classList.remove('is-resizing')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: width - keyStep, ArrowRight: width + keyStep, Home: sidebarMinWidth, End: maxWidth }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onResize(clampWidth(next))
  }

  return (
    <div
      className={`sidebar-resizer ${drag ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuenow={Math.min(width, widest())}
      aria-valuemin={sidebarMinWidth}
      aria-valuemax={widest()}
      tabIndex={0}
      title={t('sidebar.resize')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultSidebarWidth)}
      onKeyDown={onKeyDown}
    />
  )
}
