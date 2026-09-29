import { describe, expect, it } from 'vitest'
import { createTypeAhead, treeFocusTarget, typeAheadTarget, type TreeRow } from './tree-navigation'

/**
 * Two Sources' rows, in the order the sidebar shows them:
 *   0 Fixture (open)
 *   1   logs (open)
 *   2     app.log
 *   3     error.log
 *   4   readme.md
 *   5 Other (closed)
 */
const rows: TreeRow[] = [
  { label: 'Fixture', level: 1, expanded: true },
  { label: 'logs', level: 2, expanded: true },
  { label: 'app.log', level: 3 },
  { label: 'error.log', level: 3 },
  { label: 'readme.md', level: 2 },
  { label: 'Other', level: 1, expanded: false }
]

describe('moving through the tree', () => {
  it('moves down and up a row, stopping at either end', () => {
    expect(treeFocusTarget(rows, 2, 'ArrowDown')).toBe(3)
    expect(treeFocusTarget(rows, 2, 'ArrowUp')).toBe(1)
    expect(treeFocusTarget(rows, 5, 'ArrowDown')).toBeNull()
    expect(treeFocusTarget(rows, 0, 'ArrowUp')).toBeNull()
  })

  it('goes across Sources, as the sidebar shows them as one list', () => {
    expect(treeFocusTarget(rows, 4, 'ArrowDown')).toBe(5)
  })

  it('jumps to the first and last rows with Home and End', () => {
    expect(treeFocusTarget(rows, 3, 'Home')).toBe(0)
    expect(treeFocusTarget(rows, 1, 'End')).toBe(5)
  })

  it('goes into an open folder with Right, to its first child', () => {
    expect(treeFocusTarget(rows, 1, 'ArrowRight')).toBe(2)
    expect(treeFocusTarget(rows, 0, 'ArrowRight')).toBe(1)
  })

  it('stays put on Right from a file, or a closed folder (which opens instead)', () => {
    expect(treeFocusTarget(rows, 2, 'ArrowRight')).toBeNull()
    expect(treeFocusTarget(rows, 5, 'ArrowRight')).toBeNull()
  })

  it('goes out to the parent with Left from a file or a closed folder', () => {
    expect(treeFocusTarget(rows, 3, 'ArrowLeft')).toBe(1)
    expect(treeFocusTarget(rows, 4, 'ArrowLeft')).toBe(0)
  })

  it('stays put on Left from an open folder (which closes instead) or a Source', () => {
    expect(treeFocusTarget(rows, 1, 'ArrowLeft')).toBeNull()
    expect(treeFocusTarget(rows, 5, 'ArrowLeft')).toBeNull()
  })

  it('ignores other keys', () => {
    expect(treeFocusTarget(rows, 1, 'a')).toBeNull()
  })

  it('stays put on Right while an open folder’s children are still loading', () => {
    const loading: TreeRow[] = [{ label: 'Fixture', level: 1, expanded: true }]
    expect(treeFocusTarget(loading, 0, 'ArrowRight')).toBeNull()
  })
})

describe('type-ahead', () => {
  it('jumps to the next row whose name starts with what was typed, ignoring case', () => {
    expect(typeAheadTarget(rows, 0, 'E')).toBe(3)
    expect(typeAheadTarget(rows, 0, 'read')).toBe(4)
  })

  it('wraps around past the last row', () => {
    expect(typeAheadTarget(rows, 4, 'f')).toBe(0)
  })

  it('keeps to the current row while it still matches a longer query', () => {
    expect(typeAheadTarget(rows, 2, 'ap')).toBe(2)
  })

  it('cycles through rows starting with the same letter when it is typed again', () => {
    const logs: TreeRow[] = [
      { label: 'a.log', level: 1 },
      { label: 'b.log', level: 1 },
      { label: 'a2.log', level: 1 }
    ]
    expect(typeAheadTarget(logs, 0, 'a')).toBe(2)
    expect(typeAheadTarget(logs, 0, 'aa')).toBe(2)
    expect(typeAheadTarget(logs, 2, 'aa')).toBe(0)
  })

  it('finds nothing when no row matches', () => {
    expect(typeAheadTarget(rows, 0, 'zz')).toBeNull()
  })

  it('builds a query from keys typed in quick succession, starting over after a pause', () => {
    let now = 0
    const typeAhead = createTypeAhead(() => now)
    expect(typeAhead.type('r')).toBe('r')
    now += 200
    expect(typeAhead.type('e')).toBe('re')
    now += 1000
    expect(typeAhead.type('a')).toBe('a')
  })

  it('starts a new query once reset, however soon the next key comes', () => {
    const typeAhead = createTypeAhead(() => 0)
    typeAhead.type('r')
    typeAhead.reset()
    expect(typeAhead.type('a')).toBe('a')
  })
})
