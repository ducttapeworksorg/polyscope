import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSince, shownSince, sinceTimeOf } from './since'

afterEach(() => {
  vi.unstubAllEnvs()
})

const now = new Date('2026-10-18T12:00:00Z')

describe('a Since chosen', () => {
  it('as a while ago is that long before now', () => {
    expect(sinceTimeOf({ minutesAgo: 15 }, now)).toBe('2026-10-18T11:45:00.000Z')
    expect(sinceTimeOf({ minutesAgo: 24 * 60 }, now)).toBe('2026-10-17T12:00:00.000Z')
  })

  it('as a time is that time', () => {
    expect(sinceTimeOf({ time: '2026-10-18T09:00:00.000Z' }, now)).toBe('2026-10-18T09:00:00.000Z')
  })
})

describe('a Since typed in', () => {
  it('is read as a date and time in local time', () => {
    vi.stubEnv('TZ', 'America/New_York')

    expect(readSince('2026-10-18 09:00', false, now)).toBe('2026-10-18T13:00:00.000Z')
    expect(readSince('2026-10-18T09:00:30', false, now)).toBe('2026-10-18T13:00:30.000Z')
  })

  it('is read in UTC when the log view shows UTC', () => {
    vi.stubEnv('TZ', 'America/New_York')

    expect(readSince('2026-10-18 09:00', true, now)).toBe('2026-10-18T09:00:00.000Z')
  })

  it('is read as today when it’s a time alone', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo')

    expect(readSince('09:00', false, now)).toBe('2026-10-18T00:00:00.000Z')
    expect(readSince(' 9:05 ', true, now)).toBe('2026-10-18T09:05:00.000Z')
  })

  it('is refused when it can’t be read', () => {
    for (const typed of ['', 'yesterday', '2026-02-30 09:00', '2026-10-18 25:00', '2026-10-18', '09:60', '2026-13-01 00:00']) {
      expect(readSince(typed, false, now), typed).toBeUndefined()
    }
  })
})

describe('a Since shown', () => {
  it('is in local time, or in UTC when asked', () => {
    vi.stubEnv('TZ', 'America/New_York')

    expect(shownSince('2026-10-18T13:00:00.000Z', false)).toBe('2026-10-18 09:00')
    expect(shownSince('2026-10-18T13:00:30.000Z', true)).toBe('2026-10-18 13:00:30')
  })

  it('reads back as the same time', () => {
    vi.stubEnv('TZ', 'Europe/Kyiv')

    expect(readSince(shownSince('2026-10-18T13:00:00.000Z', false), false, now)).toBe('2026-10-18T13:00:00.000Z')
  })
})
