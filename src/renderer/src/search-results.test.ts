import { describe, expect, it } from 'vitest'
import type { LargeFileMatch } from '@shared/core-api'
import { applySearchUpdate, nextMatch, startedSearch } from './search-results'

const match = (line: number): LargeFileMatch => ({ line, preview: `line ${line}`, start: 0, end: 4 })

const found = (lines: number[]) =>
  applySearchUpdate(startedSearch({ pattern: 'x' }, 'search-1'), { kind: 'progress', scannedBytes: 10, totalBytes: 100, matches: lines.map(match) })

describe('a search’s results', () => {
  it('gather its matches and progress as they come, until it’s done', () => {
    let search = found([3, 7])
    search = applySearchUpdate(search, { kind: 'progress', scannedBytes: 100, totalBytes: 100, matches: [match(12)] })
    search = applySearchUpdate(search, { kind: 'done', matchedLines: 3, limited: false })

    expect(search).toMatchObject({ searchId: 'search-1', scannedBytes: 100, totalBytes: 100, outcome: { kind: 'done', matchedLines: 3 } })
    expect(search.matches.map((m) => m.line)).toEqual([3, 7, 12])
  })

  it('keep what was found when it fails', () => {
    const search = applySearchUpdate(found([3]), { kind: 'failed', code: 'UNKNOWN', message: 'gone' })

    expect(search).toMatchObject({ outcome: { kind: 'failed', message: 'gone' } })
    expect(search.matches).toHaveLength(1)
  })
})

describe('stepping through matches', () => {
  const search = found([10, 20, 30])

  it('starts from the first match at or after the line in view, or the last before it going back', () => {
    expect(nextMatch(search, 1, 15)).toBe(1)
    expect(nextMatch(search, 1, 20)).toBe(1)
    expect(nextMatch(search, -1, 25)).toBe(1)
    expect(nextMatch(search, -1, 20)).toBe(0)
  })

  it('goes on from the current match, wrapping around at either end', () => {
    expect(nextMatch({ ...search, current: 1 }, 1, 0)).toBe(2)
    expect(nextMatch({ ...search, current: 2 }, 1, 0)).toBe(0)
    expect(nextMatch({ ...search, current: 0 }, -1, 0)).toBe(2)
  })

  it('wraps around from the line in view too', () => {
    expect(nextMatch(search, 1, 35)).toBe(0)
    expect(nextMatch(search, -1, 5)).toBe(2)
  })

  it('has nowhere to go without matches', () => {
    expect(nextMatch(found([]), 1, 0)).toBeNull()
  })
})
