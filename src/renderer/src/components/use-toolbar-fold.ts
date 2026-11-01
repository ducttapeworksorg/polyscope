import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { foldedItems, type HeldItem } from '../toolbar-fold'

/** One of a toolbar's items, in the order it shows them: among its first items, or among its toggles at its far end. */
export interface FoldableItem<Key extends string = string> {
  key: Key
  group: 'start' | 'toggles'
}

/** The item in the toolbar, or in its "…" menu, that has the focus. */
function heldItem(bar: HTMLElement): HeldItem {
  const focused = document.activeElement
  if (!focused || !bar.contains(focused)) return {}
  const shown = focused.closest<HTMLElement>('[data-fold-key]')?.dataset['foldKey']
  const folded = focused.closest<HTMLElement>('[data-menu-key]')?.dataset['menuKey']
  return { ...(shown !== undefined && { shown }), ...(folded !== undefined && { folded }) }
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, at) => key === b[at])

/**
 * Which of a toolbar's items fold into its "…" menu so the rest fit on one line, as wide as the toolbar is now. Each item
 * in the toolbar is marked with its key in `data-fold-key`, and measured there; a folded one is taken to be as wide as
 * when it was last there. Should it have grown meanwhile, it folds again as soon as it's back, before that's painted.
 * `moreRef` is a hidden copy of the "…" button, measured to know the room it takes. The control with the focus stays where
 * it is, in the toolbar or in the "…" menu (where each item is marked with its key in `data-menu-key`), so it's neither
 * rebuilt from under the keyboard nor loses what's being typed in it, until the focus leaves it.
 */
export function useToolbarFold<Key extends string>(items: readonly FoldableItem<Key>[], foldOrder: readonly Key[]) {
  const barRef = useRef<HTMLDivElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [folded, setFolded] = useState<readonly Key[]>([])
  const widths = useRef(new Map<string, number>())
  const observer = useRef<ResizeObserver | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const measure = useCallback(() => {
    const bar = barRef.current
    const toggles = togglesRef.current
    const more = moreRef.current
    if (!bar || !toggles || !more) return
    const barStyle = getComputedStyle(bar)
    const room = bar.clientWidth - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight)
    const barGap = parseFloat(barStyle.columnGap) || 0
    const togglesGap = parseFloat(getComputedStyle(toggles).columnGap) || 0
    for (const element of bar.querySelectorAll<HTMLElement>('[data-fold-key]')) widths.current.set(element.dataset['foldKey']!, element.getBoundingClientRect().width)
    const firstToggle = itemsRef.current.find((item) => item.group === 'toggles')
    const next = foldedItems(
      itemsRef.current.map((item) => ({ key: item.key, width: widths.current.get(item.key) ?? 0, gap: item.group === 'toggles' && item !== firstToggle ? togglesGap : barGap })),
      foldOrder,
      room,
      { width: more.getBoundingClientRect().width, gap: togglesGap },
      heldItem(bar)
    ) as Key[]
    setFolded((prev) => (sameKeys(prev, next) ? prev : next))
  }, [foldOrder])

  // Measured after every render, before it's painted, as what it shows may have changed width.
  useLayoutEffect(measure)

  // And again whenever the toolbar or any item changes width by itself, as when the window is resized.
  useLayoutEffect(() => {
    let frame = 0
    const measureSoon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    observer.current = new ResizeObserver(measureSoon)
    // And once the focus leaves a control, held where it was while in use.
    const bar = barRef.current
    bar?.addEventListener('focusout', measureSoon)
    return () => {
      cancelAnimationFrame(frame)
      observer.current?.disconnect()
      bar?.removeEventListener('focusout', measureSoon)
    }
  }, [measure])
  // Watching the items in the toolbar now: they change only when some fold or unfold, or the toolbar offers others.
  const shownKeys = items.map((item) => item.key).filter((key) => !folded.includes(key)).join(' ')
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar || !observer.current) return
    observer.current.disconnect()
    observer.current.observe(bar)
    for (const element of bar.querySelectorAll('[data-fold-key]')) observer.current.observe(element)
  }, [shownKeys, measure])

  return { folded, barRef, togglesRef, moreRef }
}
