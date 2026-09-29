import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppLog } from './app-log'

let dir: string
const now = () => new Date('2026-09-28T10:00:00.000Z')
// Each line's message, without the timestamp and level before it.
const messages = (log: string) =>
  log
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice('2026-09-28T10:00:00.000Z INFO  '.length))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-app-log-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('app log', () => {
  it('has nothing recent before anything is logged', async () => {
    const log = createAppLog({ dir: join(dir, 'logs'), now })
    expect(await log.recent()).toBe('')
  })

  it('writes timestamped lines with their level, and errors with their stack', async () => {
    const log = createAppLog({ dir: join(dir, 'logs'), now })
    log.info('Polyscope started')
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at connect (core.ts:1:1)'
    log.error('connect failed', error)
    log.warn('slow', 'not an Error')

    expect(await log.recent()).toBe(
      [
        '2026-09-28T10:00:00.000Z INFO  Polyscope started',
        '2026-09-28T10:00:00.000Z ERROR connect failed: Error: boom',
        '    at connect (core.ts:1:1)',
        '2026-09-28T10:00:00.000Z WARN  slow: not an Error',
        ''
      ].join('\n')
    )
  })

  it('keeps secrets off the disk', async () => {
    const log = createAppLog({ dir, now })
    log.warn('connect failed via http://alice:hunter2@proxy.corp:3128')
    const [file] = await readdir(dir)
    const written = await readFile(join(dir, file!), 'utf8')
    expect(written).not.toContain('hunter2')
    expect(written).toContain('http://[redacted]@proxy.corp:3128')
  })

  it('rotates to one older file once the current one is full, and reads back across both in order', async () => {
    const line = (n: number) => `line ${String(n).padStart(3, '0')}` // 40 bytes with the timestamp and level
    const log = createAppLog({ dir, now, maxFileBytes: 100 })
    for (let n = 1; n <= 7; n++) log.info(line(n))

    // Two lines to a file: lines 1–4 have rotated away, 5–6 are the older file and 7 the current one.
    expect((await readdir(dir)).sort()).toEqual(['polyscope.log', 'polyscope.old.log'])
    const recent = await log.recent()
    expect(messages(recent)).toEqual([line(5), line(6), line(7)])
  })

  it('carries on from an existing log after a restart, still rotating on size', async () => {
    createAppLog({ dir, now, maxFileBytes: 100 }).info('before restart')
    const log = createAppLog({ dir, now, maxFileBytes: 100 })
    log.info('after restart 1')
    log.info('after restart 2')
    expect(messages(await log.recent())).toEqual([
      'before restart',
      'after restart 1',
      'after restart 2'
    ])
    expect((await readdir(dir)).sort()).toEqual(['polyscope.log', 'polyscope.old.log'])
  })

  it('returns only the most recent whole lines within the size asked for', async () => {
    const log = createAppLog({ dir, now })
    for (let n = 1; n <= 10; n++) log.info(`entry ${n}`)
    const recent = await log.recent(100)
    expect(recent.length).toBeLessThanOrEqual(100)
    expect(messages(recent)).toEqual(['entry 9', 'entry 10'])
  })
})
