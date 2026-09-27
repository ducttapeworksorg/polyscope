import { afterEach, describe, expect, it, vi } from 'vitest'
import { followLines, isMarker, shownContent } from './log-lines'

afterEach(() => {
  vi.unstubAllEnvs()
})

const snapshot = (content: string, timestamps = true) => ({ content, timestamps })

describe('timestamps', () => {
  it('are shown in local time, to the millisecond', () => {
    vi.stubEnv('TZ', 'America/New_York')

    expect(shownContent(snapshot('2026-09-27T10:00:00.123456789Z started\n2026-09-27T23:59:59Z done'), false)).toBe(
      '2026-09-27 06:00:00.123 started\n2026-09-27 19:59:59.000 done'
    )
  })

  it('are shown in UTC, marked as such, when asked', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo')

    expect(shownContent(snapshot('2026-09-27T10:00:00.5Z started'), true)).toBe('2026-09-27 10:00:00.500Z started')
  })

  it('leave a line that has none as it is', () => {
    expect(shownContent(snapshot('no time here\n2026-09-27T10:00:00Z'), true)).toBe('no time here\n2026-09-27 10:00:00.000Z')
  })

  it('are not looked for when the log has none', () => {
    expect(shownContent(snapshot('2026-09-27T10:00:00Z part of the message', false), false)).toBe('2026-09-27T10:00:00Z part of the message')
  })
})

describe('what a Follow adds to its log view', () => {
  const plain = { timestamps: false, utc: false }

  it('is its new lines', () => {
    expect(followLines({ kind: 'lines', lines: ['one', 'two'] }, plain)).toEqual(['one', 'two'])
  })

  it('shows their timestamps like the snapshot’s', () => {
    expect(followLines({ kind: 'lines', lines: ['2026-09-27T10:00:00.25Z one'] }, { timestamps: true, utc: true })).toEqual([
      '2026-09-27 10:00:00.250Z one'
    ])
  })

  it('marks a restart, a failure, recovering and the end with a line each', () => {
    const marks = [
      followLines({ kind: 'restarted' }, plain),
      followLines({ kind: 'failed', code: 'UNREACHABLE', message: 'connection reset', retryIn: 4_000 }, plain),
      followLines({ kind: 'recovered' }, plain),
      followLines({ kind: 'ended', reason: 'exited' }, plain)
    ]

    for (const lines of marks) {
      expect(lines).toHaveLength(1)
      expect(isMarker(lines[0]!)).toBe(true)
    }
    expect(marks[0]![0]).toMatch(/container restarted/)
    expect(marks[1]![0]).toMatch(/4 s/)
  })

  it('does not take a log line for a mark', () => {
    expect(isMarker('── not from Polyscope')).toBe(false)
  })
})
