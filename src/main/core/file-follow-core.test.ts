import { appendFile, mkdtemp, open, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent } from '@shared/core-api'
import { createCore, type Core } from './core'

let dir: string
let core: Core
let sourceId: string
let events: FollowEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-file-follow-'))
  core = createCore()
  sourceId = (await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })).id
  events = []
  core.onFollowEvent((event) => events.push(event))
})

afterEach(async () => {
  await core.disconnect(sourceId)
  await rm(dir, { recursive: true, force: true })
})

/** A Follow's updates so far, as lines, marks in angle brackets. */
const updatesOf = (followId: string) =>
  events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [`<${e.kind}>`]))

/** Waits for `check` to pass, long enough for a few looks at the file. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 100 })

const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('')

/** Writes app.log in the Source, connects, and follows the file. */
async function followAppLog(content: string, lastNLines = 2) {
  await writeFile(join(dir, 'app.log'), content)
  await core.connect(sourceId)
  return core.followFile(sourceId, 'app.log', { lastNLines })
}

describe('a file’s last lines', () => {
  it('opens in a log view with only its last N lines', async () => {
    await writeFile(join(dir, 'app.log'), numbered(1, 5))
    await core.connect(sourceId)

    expect(await core.openFileLog(sourceId, 'app.log', { lastNLines: 2 })).toEqual({
      view: 'log',
      of: 'file',
      path: 'app.log',
      name: 'app.log',
      previous: false,
      timestamps: false,
      lastNLines: 2,
      content: 'line 4\nline 5'
    })
  })

  it('shows as many lines as the Source remembers, or else the Settings default', async () => {
    await writeFile(join(dir, 'app.log'), numbered(1, 5))
    await core.connect(sourceId)
    await core.updateSettings({ defaultLastNLines: 3 })
    expect(await core.openFileLog(sourceId, 'app.log')).toMatchObject({ lastNLines: 3, content: 'line 3\nline 4\nline 5' })

    await core.rememberLastNLines(sourceId, 1)
    expect(await core.openFileLog(sourceId, 'app.log')).toMatchObject({ lastNLines: 1, content: 'line 5' })
  })

  it('refuses all of a file over the Large File threshold, unless told to go ahead', async () => {
    await core.updateSettings({ largeFileThreshold: 1024 })
    await writeFile(join(dir, 'app.log'), numbered(1, 500))
    await core.connect(sourceId)

    await expect(core.openFileLog(sourceId, 'app.log', { lastNLines: 'all' })).rejects.toMatchObject({ code: 'LOG_TOO_LARGE' })
    const whole = await core.openFileLog(sourceId, 'app.log', { lastNLines: 'all', allowLarge: true })
    expect(whole.content.split('\n')).toHaveLength(500)
  })

  it('is only for files', async () => {
    await core.connect(sourceId)

    await expect(core.openFileLog(sourceId, '', { lastNLines: 2 })).rejects.toMatchObject({ code: 'NOT_A_FILE' })
  })
})

describe('following a file', () => {
  it('starts with its last N lines and adds lines as they are written', async () => {
    const followed = await followAppLog(numbered(1, 5))
    expect(followed).toMatchObject({ view: 'log', of: 'file', content: 'line 4\nline 5', followId: expect.any(String) })

    await appendFile(join(dir, 'app.log'), numbered(6, 7))
    await eventually(() => expect(updatesOf(followed.followId)).toEqual(['line 6', 'line 7']))
    await appendFile(join(dir, 'app.log'), 'line 8\n')
    await eventually(() => expect(updatesOf(followed.followId)).toEqual(['line 6', 'line 7', 'line 8']))
  })

  it('holds back a last line not yet ended, then adds it whole', async () => {
    const followed = await followAppLog('line 1\nline 2 is')

    expect(followed.content).toBe('line 1')
    await appendFile(join(dir, 'app.log'), ' done\n')
    await eventually(() => expect(updatesOf(followed.followId)).toEqual(['line 2 is done']))
  })

  it('marks a file cut short and follows it from its start', async () => {
    const followed = await followAppLog(numbered(1, 5))

    await writeFile(join(dir, 'app.log'), 'anew\n')
    await eventually(() => expect(updatesOf(followed.followId)).toEqual(['<truncated>', 'anew']))
  })

  it('marks a file rotated out for a new one and follows the new one', async () => {
    const followed = await followAppLog(numbered(1, 5))

    await rename(join(dir, 'app.log'), join(dir, 'app.log.1'))
    await writeFile(join(dir, 'app.log'), `${numbered(1, 9)}rotated in\n`)
    await eventually(() => expect(updatesOf(followed.followId).slice(-2)).toEqual(['line 9', 'rotated in']))
    expect(updatesOf(followed.followId)).toContain('<rotated>')
  })

  it.skipIf(process.platform === 'win32')(
    'opens a multi-gigabyte file at once, reading only its end',
    async () => {
      const path = join(dir, 'huge.log')
      // Sparse: gigabytes long without taking up the disk.
      await writeFile(path, '')
      await truncate(path, 4 * 1024 ** 3)
      const file = await open(path, 'a')
      await file.write(numbered(1, 3))
      await file.close()
      await core.connect(sourceId)

      const started = Date.now()
      const followed = await core.followFile(sourceId, 'huge.log', { lastNLines: 2 })

      expect(followed.content).toBe('line 2\nline 3')
      expect(Date.now() - started).toBeLessThan(2_000)
      await appendFile(path, 'line 4\n')
      await eventually(() => expect(updatesOf(followed.followId)).toEqual(['line 4']))
    },
    30_000
  )

  it('holds new lines back while paused, and adds them on resuming', async () => {
    const followed = await followAppLog(numbered(1, 2))
    await core.pauseFollow(followed.followId)

    await appendFile(join(dir, 'app.log'), numbered(3, 5))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(updatesOf(followed.followId)).toEqual([])
    await core.resumeFollow(followed.followId)
    expect(updatesOf(followed.followId)).toEqual(['line 4', 'line 5'])
  })

  it('ends when its Source is disconnected', async () => {
    const followed = await followAppLog(numbered(1, 2))

    await core.disconnect(sourceId)
    expect(updatesOf(followed.followId)).toEqual(['<ended>'])
    expect(events.at(-1)).toMatchObject({ kind: 'ended', reason: 'disconnected' })
  })

  it('sends nothing more once stopped', async () => {
    const followed = await followAppLog(numbered(1, 2))

    await core.stopFollow(followed.followId)
    await appendFile(join(dir, 'app.log'), 'line 3\n')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(updatesOf(followed.followId)).toEqual([])
  })

  it('isn’t offered for S3 objects, which don’t grow', async () => {
    const s3 = await core.addSource({ type: 's3', name: 'Bucket', host: 'http://localhost:9', bucket: 'logs', accessKeyId: 'key', secretAccessKey: 'secret' })

    await expect(core.followFile(s3.id, 'app.log')).rejects.toMatchObject({ code: 'NOT_FOLLOWABLE' })
  })
})
