import { describe, expect, it } from 'vitest'
import { foldedItems, type ToolbarItem } from './toolbar-fold'

// A toolbar like a log view's: "Last N lines", the Level Filter, Follow, then toggles that can fold.
const items: ToolbarItem[] = [
  { key: 'lastNLines', width: 200, gap: 10 },
  { key: 'levels', width: 300, gap: 10 },
  { key: 'follow', width: 60, gap: 10 },
  { key: 'wrap', width: 50, gap: 4 },
  { key: 'saveCopy', width: 90, gap: 4 }
]
// Least used first.
const foldOrder = ['saveCopy', 'lastNLines', 'wrap']
const more = { width: 30, gap: 4 }

// 200 + 10 + 300 + 10 + 60 + 4 + 50 + 4 + 90
const wholeWidth = 728

describe('a toolbar with room for every item', () => {
  it('folds nothing', () => {
    expect(foldedItems(items, foldOrder, wholeWidth, more)).toEqual([])
  })
})

describe('a toolbar short of room', () => {
  it('folds the least used item first', () => {
    expect(foldedItems(items, foldOrder, wholeWidth - 1, more)).toEqual(['saveCopy'])
  })

  it('folds the next one when the "…" button leaves too little room', () => {
    // Without "Save a copy…", 634; with the "…" button, 668.
    expect(foldedItems(items, foldOrder, 660, more)).toEqual(['saveCopy', 'lastNLines'])
  })

  it('keeps the items that never fold, however little room there is', () => {
    expect(foldedItems(items, foldOrder, 100, more)).toEqual(['saveCopy', 'lastNLines', 'wrap'])
  })

  it('passes over items the toolbar is not showing', () => {
    expect(foldedItems(items, ['utc', 'saveCopy', 'lastNLines'], wholeWidth - 1, more)).toEqual(['saveCopy'])
  })
})

describe('the item with the focus', () => {
  it('stays in the toolbar, the next item folding in its place', () => {
    expect(foldedItems(items, foldOrder, wholeWidth - 1, more, { shown: 'saveCopy' })).toEqual(['lastNLines'])
  })

  it('stays in the "…" menu, however much room there is', () => {
    expect(foldedItems(items, foldOrder, wholeWidth, more, { folded: 'wrap' })).toEqual(['wrap'])
  })
})
