/** A tree row as keyboard navigation sees it: its name, how deep it is, and whether it's an open or closed folder. */
export interface TreeRow {
  label: string
  /** 1 for a Source's own row, 2 for what's in it, and so on. */
  level: number
  /** Open or closed for a folder (or anything else with children); undefined for a file or log. */
  expanded?: boolean
}

/** The keys that move the focus between rows (see `treeFocusTarget`), besides typing a name. */
export const treeNavigationKeys: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft']

/**
 * Where a key moves the focus from the row at `index`, or null if it stays put: up and down a row, to the
 * first or last row, into an open folder (Right) or out to the parent (Left). Right on a closed folder and
 * Left on an open one stay put, as they open or close it instead.
 */
export function treeFocusTarget(rows: readonly TreeRow[], index: number, key: string): number | null {
  const row = rows[index]
  if (!row) return null
  switch (key) {
    case 'ArrowDown':
      return index + 1 < rows.length ? index + 1 : null
    case 'ArrowUp':
      return index > 0 ? index - 1 : null
    case 'Home':
      return 0
    case 'End':
      return rows.length - 1
    case 'ArrowRight': {
      const next = rows[index + 1]
      return row.expanded && next && next.level > row.level ? index + 1 : null
    }
    case 'ArrowLeft': {
      if (row.expanded) return null
      for (let i = index - 1; i >= 0; i--) if (rows[i]!.level < row.level) return i
      return null
    }
    default:
      return null
  }
}

/**
 * The row type-ahead jumps to from `index`: the first one on (wrapping around) whose name starts with `query`,
 * ignoring case. A longer query keeps to the current row while it still matches; a single letter, or the same
 * letter typed again and again, goes on to the next row starting with it.
 */
export function typeAheadTarget(rows: readonly TreeRow[], index: number, query: string): number | null {
  const repeated = [...query].every((char) => char === query[0])
  const prefix = (repeated ? query[0]! : query).toLocaleLowerCase()
  const from = repeated ? index + 1 : index
  for (let step = 0; step < rows.length; step++) {
    const i = (from + step) % rows.length
    if (rows[i]!.label.toLocaleLowerCase().startsWith(prefix)) return i
  }
  return null
}

/** How long after a key typed the next one still adds to the query, in milliseconds. */
const typeAheadPause = 700

/**
 * Collects keys typed in quick succession into a type-ahead query; after a pause, or once reset (say, by moving
 * with the arrows), the next key starts a new one.
 */
export function createTypeAhead(now: () => number = Date.now) {
  let query = ''
  let last = -Infinity
  return {
    type(char: string) {
      const at = now()
      query = at - last > typeAheadPause ? char : query + char
      last = at
      return query
    },
    reset() {
      last = -Infinity
    }
  }
}
