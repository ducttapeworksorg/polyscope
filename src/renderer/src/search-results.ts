import type { LargeFileMatch, LargeFileSearchQuery, LargeFileSearchUpdate } from '@shared/core-api'

/** A search of a Large File as its viewer shows it: what it's for, what it has found so far, and how it ended. */
export interface SearchResults {
  searchId: string
  query: LargeFileSearchQuery
  /** The matching lines found so far, in order. */
  matches: LargeFileMatch[]
  scannedBytes: number
  totalBytes: number
  /** Left out while it's going on. */
  outcome?: Exclude<LargeFileSearchUpdate, { kind: 'progress' }>
  /** The match last gone to, by its place in `matches`; null before any. */
  current: number | null
}

export const startedSearch = (query: LargeFileSearchQuery, searchId: string): SearchResults => ({
  searchId,
  query,
  matches: [],
  scannedBytes: 0,
  totalBytes: 0,
  current: null
})

/** The results once `update` has come. */
export function applySearchUpdate(search: SearchResults, update: LargeFileSearchUpdate): SearchResults {
  if (update.kind !== 'progress') return { ...search, outcome: update }
  const { scannedBytes, totalBytes, matches } = update
  return { ...search, scannedBytes, totalBytes, matches: matches.length ? [...search.matches, ...matches] : search.matches }
}

/**
 * The match to go to next (`direction` 1) or before (-1), by its place in the matches: on from the current
 * one, or with none, from line `fromLine`, the one in view. Wraps around at either end; null when there are none.
 */
export function nextMatch({ matches, current }: Pick<SearchResults, 'matches' | 'current'>, direction: 1 | -1, fromLine: number): number | null {
  const count = matches.length
  if (!count) return null
  if (current !== null) return (current + direction + count) % count
  if (direction === 1) {
    const after = matches.findIndex((match) => match.line >= fromLine)
    return after < 0 ? 0 : after
  }
  const before = matches.findLastIndex((match) => match.line < fromLine)
  return before < 0 ? count - 1 : before
}
