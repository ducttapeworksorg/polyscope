/** One of a toolbar's items, in the order it shows them, as wide as it is laid out. */
export interface ToolbarItem {
  key: string
  width: number
  /** The space between it and the item before it. */
  gap: number
}

/** How wide the items are laid out in a row, with the gaps between them (the first item's gap not counted). */
const rowWidth = (items: readonly ToolbarItem[]) => items.reduce((sum, item, at) => sum + item.width + (at === 0 ? 0 : item.gap), 0)

/** The item that has the focus, to stay where it is: in the toolbar, or in its "…" menu. */
export interface HeldItem {
  shown?: string
  folded?: string
}

/**
 * The keys of the toolbar's items to fold into its "…" menu, the "…" button taking room once any are, so the rest fit in
 * the room on one line. Items fold in fold order, so the most used stay longest; those not in it never fold. The item
 * held where it is, being in use, is passed over.
 */
export function foldedItems(items: readonly ToolbarItem[], foldOrder: readonly string[], room: number, more: { width: number; gap: number }, held: HeldItem = {}): string[] {
  const folded = held.folded !== undefined && items.some((item) => item.key === held.folded) ? [held.folded] : []
  const shown = () => items.filter((item) => !folded.includes(item.key))
  for (const key of foldOrder.filter((key) => key !== held.shown && key !== held.folded && items.some((item) => item.key === key))) {
    const width = rowWidth(shown()) + (folded.length > 0 ? more.gap + more.width : 0)
    if (width <= room) break
    folded.push(key)
  }
  return folded
}
