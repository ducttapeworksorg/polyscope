import { describe, expect, it } from 'vitest'
import { highlightLine, logTokens } from './line-highlights'

describe('log levels', () => {
  it('are picked out by how serious they are', () => {
    expect(highlightLine('a FATAL b').at(1)).toEqual({ text: 'FATAL', highlight: 'error' })
    expect(highlightLine('WARNING up').at(0)).toEqual({ text: 'WARNING', highlight: 'warning' })
    expect(highlightLine('INFO up').at(0)).toEqual({ text: 'INFO', highlight: 'info' })
    expect(highlightLine('TRACE up').at(0)).toEqual({ text: 'TRACE', highlight: 'debug' })
  })

  it('are one per line, its Log Level, not a level word later in its message', () => {
    expect(highlightLine('INFO retrying after ERROR')).toEqual([{ text: 'INFO', highlight: 'info' }, { text: ' retrying after ERROR' }])
  })

  it('are picked out from a level field', () => {
    expect(highlightLine('{"level":"warn","msg":"ERROR"}')).toEqual([{ text: '{"level":"' }, { text: 'warn', highlight: 'warning' }, { text: '","msg":"ERROR"}' }])
  })

  it('are not picked out from words in a message', () => {
    expect(highlightLine('Connected to Info Service')).toEqual([{ text: 'Connected to Info Service' }])
  })
})

describe('timestamps', () => {
  it('are picked out as dates and times, or times alone', () => {
    expect(highlightLine('2026-09-28T18:32:27.123Z started at 18:32:27,5 on 2026-09-28')).toEqual([
      { text: '2026-09-28T18:32:27.123Z', highlight: 'date' },
      { text: ' started at ' },
      { text: '18:32:27,5', highlight: 'date' },
      { text: ' on ' },
      { text: '2026-09-28', highlight: 'date' }
    ])
  })

  it('are picked out anywhere, the level besides', () => {
    expect(highlightLine('E1029 12:00:00.123456 1 a.go:1] at 13:00:00')).toEqual([
      { text: 'E', highlight: 'error' },
      { text: '1029 ' },
      { text: '12:00:00.123456', highlight: 'date' },
      { text: ' 1 a.go:1] at ' },
      { text: '13:00:00', highlight: 'date' }
    ])
  })

  it('take in a time zone offset', () => {
    expect(highlightLine('2026-09-28 18:32:27+02:00 INFO up')).toEqual([
      { text: '2026-09-28 18:32:27+02:00', highlight: 'date' },
      { text: ' ' },
      { text: 'INFO', highlight: 'info' },
      { text: ' up' }
    ])
  })
})

describe('search matches', () => {
  it('are marked wherever they are in the line', () => {
    expect(highlightLine('disk full, DISK gone', /disk/gi)).toEqual([
      { text: 'disk', match: true },
      { text: ' full, ' },
      { text: 'DISK', match: true },
      { text: ' gone' }
    ])
  })

  it('are marked over levels and timestamps, keeping their colours', () => {
    expect(highlightLine('ERROR disk', /ROR d/g)).toEqual([
      { text: 'ER', highlight: 'error' },
      { text: 'ROR', highlight: 'error', match: true },
      { text: ' d', match: true },
      { text: 'isk' }
    ])
  })

  it('that are empty mark nothing', () => {
    expect(highlightLine('anything', /^|x*/g)).toEqual([{ text: 'anything' }])
  })
})

it('leaves an empty line empty', () => {
  expect(highlightLine('', /x/g)).toEqual([])
})

describe('log view tokens', () => {
  /** Each token's text and kind, as the log view colours it. */
  const tokensOf = (line: string) =>
    logTokens(line).map(({ start, token }, i, tokens) => ({ text: line.slice(start, tokens[i + 1]?.start ?? line.length), ...(token && { token }) }))

  it('are a mark whole', () => {
    expect(tokensOf('── Container restarted at 12:00 ──')).toEqual([{ text: '── Container restarted at 12:00 ──', token: 'marker' }])
  })

  it('are the Log Level, timestamps, strings and numbers', () => {
    expect(tokensOf('2026-10-29 12:00:00.123 INFO took 42 ms for "a ERROR" at 13:00:00')).toEqual([
      { text: '2026-10-29 12:00:00.123', token: 'date' },
      { text: ' ' },
      { text: 'INFO', token: 'info' },
      { text: ' took ' },
      { text: '42', token: 'number' },
      { text: ' ms for ' },
      { text: '"a ERROR"', token: 'string' },
      { text: ' at ' },
      { text: '13:00:00', token: 'date' }
    ])
  })

  it('pick out a level in a string', () => {
    expect(tokensOf('{"level":"warn","n":3}')).toEqual([
      { text: '{' },
      { text: '"level"', token: 'string' },
      { text: ':' },
      { text: '"', token: 'string' },
      { text: 'warn', token: 'warning' },
      { text: '"', token: 'string' },
      { text: ',' },
      { text: '"n"', token: 'string' },
      { text: ':' },
      { text: '3', token: 'number' },
      { text: '}' }
    ])
  })

  it('are none for an empty line', () => {
    expect(logTokens('')).toEqual([])
  })
})
