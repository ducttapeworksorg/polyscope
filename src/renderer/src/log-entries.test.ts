import { describe, expect, it } from 'vitest'
import { LogEntries } from './log-entries'

const log = [
  'INFO starting',
  'ERROR request failed',
  '    at com.example.Handler.handle(Handler.java:42)',
  '    at com.example.Server.run(Server.java:7)',
  'WARN retrying',
  'DEBUG attempt 2'
]

describe('LogEntries', () => {
  it('hides a Log Entry whole: an error with its stack trace', () => {
    expect(new LogEntries(log, ['error']).shown).toEqual(['INFO starting', 'WARN retrying', 'DEBUG attempt 2'])
  })

  it('always shows the lines before the first Log Level, and marks, which belong to no Log Entry', () => {
    const lines = ['Picked up JAVA_TOOL_OPTIONS', 'ERROR crashed', '── Container restarted ──', 'banner line', 'ERROR crashed again']
    expect(new LogEntries(lines, ['error', 'warning', 'info', 'debug']).shown).toEqual(['Picked up JAVA_TOOL_OPTIONS', '── Container restarted ──', 'banner line'])
  })

  it('treats an Event of type Normal as info', () => {
    const events = ['[Normal] Scheduled pod/x: assigned', '[Warning] BackOff pod/x: restarting']
    expect(new LogEntries(events, ['info']).shown).toEqual(['[Warning] BackOff pod/x: restarting'])
  })

  it('counts each Log Level\'s Log Entries, not their lines, hidden or not', () => {
    expect(new LogEntries([...log, 'ERROR again'], ['error']).counts).toEqual({ error: 2, warning: 1, info: 1, debug: 1 })
  })

  it('numbers each shown line as it is in the whole log', () => {
    const entries = new LogEntries(log, ['error'])
    expect([1, 2, 3].map((line) => entries.numberOf(line))).toEqual([1, 5, 6])
  })

  it('adds lines at the end, which go on with the last Log Entry, and says which of them show', () => {
    const entries = new LogEntries(['INFO up', 'ERROR failed'], ['error'])
    expect(entries.append(['    at Handler.handle', 'INFO recovered'])).toEqual(['INFO recovered'])
    expect(entries.shown).toEqual(['INFO up', 'INFO recovered'])
    expect(entries.numberOf(2)).toBe(4)
    expect(entries.counts).toEqual({ error: 1, warning: 0, info: 2, debug: 0 })
  })

  it('drops the first lines, saying how many of them showed; what is left of a Log Entry stays in it', () => {
    const entries = new LogEntries(log, ['error'])
    expect(entries.dropFirst(2)).toBe(1)
    expect(entries.shown).toEqual(['WARN retrying', 'DEBUG attempt 2'])
    expect(entries.numberOf(1)).toBe(3)
    expect(entries.counts).toEqual({ error: 1, warning: 1, info: 0, debug: 1 })
  })

  it('adds lines read further back at the start, whose last Log Entry takes in the first lines that were in none', () => {
    const entries = new LogEntries(['    at Handler.handle', 'INFO next'], ['error'])
    expect(entries.shown).toEqual(['    at Handler.handle', 'INFO next'])
    expect(entries.prepend(['INFO start', 'ERROR boom'])).toEqual({ added: ['INFO start'], removed: 1 })
    expect(entries.shown).toEqual(['INFO start', 'INFO next'])
    expect(entries.numberOf(2)).toBe(4)
    expect(entries.counts).toEqual({ error: 1, warning: 0, info: 2, debug: 0 })
  })

  it('filters the lines it has again when the Level Filter changes', () => {
    const entries = new LogEntries(log, ['error'])
    entries.filter(['info', 'debug'])
    expect(entries.shown).toEqual(log.slice(1, 5))
    expect(entries.numberOf(1)).toBe(2)
  })

  it('finds the shown line at a line of the whole log, or the first shown after it, or the last shown', () => {
    const entries = new LogEntries(log, ['error'])
    expect([1, 3, 6, 9].map((number) => entries.lineAt(number))).toEqual([1, 2, 3, 3])
  })

  it('still counts a Log Entry whose first line was dropped, as its lines left are still hidden with it', () => {
    const entries = new LogEntries(log, ['error'])
    entries.dropFirst(2)
    entries.append(['ERROR again'])
    expect(entries.counts).toEqual({ error: 2, warning: 1, info: 0, debug: 1 })
  })
})
