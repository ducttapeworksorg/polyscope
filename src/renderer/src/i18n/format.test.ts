import { describe, expect, it } from 'vitest'
import { formatRelativeTime, formatSize } from './format'

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1,023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024 + 300, '10 KB'],
    [5.25 * 1024 * 1024, '5.3 MB'],
    [3 * 1024 ** 3, '3 GB'],
    [2.5 * 1024 ** 4, '2.5 TB'],
    [4096 * 1024 ** 4, '4,096 TB']
  ])('shows %i bytes as %s', (bytes, shown) => {
    expect(formatSize(bytes)).toBe(shown)
  })
})

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0)
  const ago = (ms: number) => formatRelativeTime(now - ms, now)
  const s = 1000
  const min = 60 * s
  const hr = 60 * min
  const day = 24 * hr

  it.each([
    ['moments ago', 10 * s, 'now'],
    ['in the future, e.g. from clock skew', -5 * min, 'now'],
    ['minutes ago', 5 * min, '5 min. ago'],
    ['hours ago', 3 * hr + 20 * min, '3 hr. ago'],
    ['a day ago', day + hr, 'yesterday'],
    ['days ago', 4 * day, '4 days ago'],
    ['weeks ago', 15 * day, '2 wk. ago'],
    ['months ago', 70 * day, '2 mo. ago'],
    ['years ago', 800 * day, '2 yr. ago']
  ])('describes a time %s', (_, elapsed, shown) => {
    expect(ago(elapsed)).toBe(shown)
  })
})
