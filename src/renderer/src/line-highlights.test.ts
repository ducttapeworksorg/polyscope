import { describe, expect, it } from 'vitest'
import { highlightLine } from './line-highlights'

describe('log levels', () => {
  it('are picked out by how serious they are', () => {
    expect(highlightLine('a FATAL b ERROR c WARN d WARNING e INFO f DEBUG g TRACE')).toEqual([
      { text: 'a ' },
      { text: 'FATAL', highlight: 'error' },
      { text: ' b ' },
      { text: 'ERROR', highlight: 'error' },
      { text: ' c ' },
      { text: 'WARN', highlight: 'warning' },
      { text: ' d ' },
      { text: 'WARNING', highlight: 'warning' },
      { text: ' e ' },
      { text: 'INFO', highlight: 'info' },
      { text: ' f ' },
      { text: 'DEBUG', highlight: 'debug' },
      { text: ' g ' },
      { text: 'TRACE', highlight: 'debug' }
    ])
  })

  it('are whole upper-case words only', () => {
    expect(highlightLine('an error, ERRORS, and INFORMATION')).toEqual([{ text: 'an error, ERRORS, and INFORMATION' }])
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
