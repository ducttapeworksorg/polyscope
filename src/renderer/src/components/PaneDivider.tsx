import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { t } from '../i18n'
import type { PaneRoom } from '../workspace'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { FlipLayoutIcon } from './icons'

/** The narrowest a Pane gets: just room for its log toolbar on one line, folded, as narrow as it's meant for. */
const paneMinWidth = 480
/** The shortest a Pane one above the other gets: its tab bar, its log toolbar and a few lines. */
const paneMinHeight = 160
/** How thick the divider's line is, between the Panes. */
const lineWidth = 1
const keyStep = 0.05

type Kind = 'sideBySide' | 'stacked'

/** What differs between dividing the room across, side by side, and down, one above the other. */
const axes = {
  sideBySide: {
    orientation: 'vertical',
    min: paneMinWidth,
    resizingClass: 'is-resizing',
    flipLabel: 'panes.flip.stacked',
    steps: { ArrowLeft: -keyStep, ArrowRight: keyStep } as Record<string, number>,
    at: (event: { clientX: number }) => event.clientX,
    span: (box: DOMRect) => ({ start: box.left, size: box.width })
  },
  stacked: {
    orientation: 'horizontal',
    min: paneMinHeight,
    resizingClass: 'is-resizing-rows',
    flipLabel: 'panes.flip.sideBySide',
    steps: { ArrowUp: -keyStep, ArrowDown: keyStep } as Record<string, number>,
    at: (event: { clientY: number }) => event.clientY,
    span: (box: DOMRect) => ({ start: box.top, size: box.height })
  }
} as const

/** The least of the window's width the workbench keeps for Panes laid out as `kind`, each at its minimum, if any. */
export const panesMinWidth = (kind: Kind | 'single'): number | undefined =>
  kind === 'sideBySide' ? 2 * paneMinWidth + lineWidth : kind === 'stacked' ? paneMinWidth : undefined

interface Props {
  kind: Kind
  /** The first Pane's share of the room. */
  ratio: number
  onResize(ratio: number, room: PaneRoom): void
  onReset(): void
  onFlip(): void
}

/**
 * The divider between two Panes, dragged to resize them and double-clicked to share the room evenly again. Its flip
 * control, and its menu, switch the Panes between side by side and one above the other. From the keyboard, arrows step
 * it.
 */
export function PaneDivider({ kind, ratio, onResize, onReset, onFlip }: Props) {
  const [dragging, setDragging] = useState(false)
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<object>()
  const axis = axes[kind]
  const flipLabel = t(axis.flipLabel)

  /** Where the room the Panes share starts, and how much of it there is besides the divider's line. */
  const roomOf = (handle: HTMLElement): { start: number; room: PaneRoom } => {
    const { start, size } = axis.span(handle.closest('.workbench__panes')!.getBoundingClientRect())
    return { start, room: { size: size - lineWidth, min: axis.min } }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    document.body.classList.add(axis.resizingClass)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const { start, room } = roomOf(event.currentTarget)
    onResize((axis.at(event) - start) / room.size, room)
  }

  const endDrag = () => {
    setDragging(false)
    document.body.classList.remove(axis.resizingClass)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = axis.steps[event.key]
    if (step === undefined) return
    event.preventDefault()
    onResize(ratio + step, roomOf(event.currentTarget).room)
  }

  return (
    <div className={`pane-divider pane-divider--${kind}`}>
      <div
        className={`pane-divider__handle ${dragging ? 'is-dragging' : ''}`}
        role="separator"
        aria-orientation={axis.orientation}
        aria-label={t('panes.resize')}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        title={t('panes.resize')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => openMenu(event, {})}
      />
      <button type="button" className="pane-divider__flip icon-button" aria-label={flipLabel} title={flipLabel} onClick={onFlip} onContextMenu={(event) => openMenu(event, {})}>
        <FlipLayoutIcon />
      </button>
      {menu && (
        <ContextMenu
          label={t('panes.menuLabel')}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: flipLabel, onSelect: onFlip },
            { label: t('panes.reset'), onSelect: onReset }
          ]}
        />
      )}
    </div>
  )
}
