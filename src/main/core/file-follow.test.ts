import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowUpdate } from '@shared/core-api'
import { CoreError } from './core-error'
import { fileFollowTiming, readLastLines, startFileFollow, type FileFollowOptions } from './file-follow'
import type { FileSource } from './file-source'
import { followTiming } from './log-follow'

const path = 'app/server.log'

/** A File Source holding one file, which the test writes to, truncates, replaces and deletes. */
function fakeFileSource(initial = '') {
  let bytes = Buffer.from(initial)
  let identity = 1
  let gone = false
  /** Failures to answer the next stats with, one each. */
  const failures: CoreError[] = []
  const reads: { offset: number; length: number }[] = []

  const fileSource: FileSource = {
    listChildren: () => Promise.reject(new Error('not used')),
    async stat() {
      const failure = failures.shift()
      if (failure) throw failure
      if (gone) throw new CoreError('NOT_FOUND', `Nothing at ${path}`)
      return { kind: 'file', size: bytes.length, modifiedTime: 0, identity: String(identity) }
    },
    async read(_path, range) {
      if (gone) throw new CoreError('NOT_FOUND', `Nothing at ${path}`)
      reads.push(range)
      return new Uint8Array(bytes.subarray(range.offset, range.offset + range.length))
    }
  }

  return {
    fileSource,
    failures,
    reads,
    get size() {
      return bytes.length
    },
    append: (text: string) => (bytes = Buffer.concat([bytes, Buffer.from(text)])),
    truncate: (text = '') => (bytes = Buffer.from(text)),
    /** Puts a new file in its place, as log rotation does. */
    replace: (text = '') => {
      bytes = Buffer.from(text)
      identity++
      gone = false
    },
    remove: () => (gone = true)
  }
}

describe('reading a file’s last lines', () => {
  const read = (text: string, lastNLines: number | 'all', maxBytes = 1_000_000) =>
    readLastLines(fakeFileSource(text).fileSource, path, { size: Buffer.byteLength(text), lastNLines, maxBytes })

  it('gives the last N whole lines, and where the unfinished last one starts', async () => {
    await expect(read('one\ntwo\nthree\nfour\n', 2)).resolves.toEqual({ lines: ['three', 'four'], partial: '', end: 19 })
    await expect(read('one\ntwo\nthree\nhalf a li', 2)).resolves.toEqual({ lines: ['two', 'three'], partial: 'half a li', end: 14 })
  })

  it('gives every line when asked for all, or for more than there are', async () => {
    await expect(read('one\ntwo\n', 'all')).resolves.toMatchObject({ lines: ['one', 'two'] })
    await expect(read('one\ntwo\n', 10)).resolves.toMatchObject({ lines: ['one', 'two'] })
  })

  it('gives nothing for an empty file', async () => {
    await expect(read('', 10)).resolves.toEqual({ lines: [], partial: '', end: 0 })
  })

  it('drops the carriage return of Windows line ends', async () => {
    await expect(read('one\r\ntwo\r\n', 10)).resolves.toMatchObject({ lines: ['one', 'two'] })
  })

  it('keeps characters whole wherever the reads split them', async () => {
    const text = `${'ünïcødé ✓ '.repeat(20_000)}\nlast ✓\n`
    await expect(read(text, 2)).resolves.toMatchObject({ lines: [text.split('\n')[0], 'last ✓'] })
  })

  it('reads only the end of a huge file', async () => {
    const line = `${'x'.repeat(99)}\n`
    const source = fakeFileSource(line.repeat(200_000)) // 20 MB
    const { lines } = await readLastLines(source.fileSource, path, { size: source.size, lastNLines: 10, maxBytes: 100_000_000 })

    expect(lines).toHaveLength(10)
    expect(source.reads.reduce((total, r) => total + r.length, 0)).toBeLessThan(1_000_000)
  })

  it('stops looking back after `maxBytes`, giving the whole lines found by then', async () => {
    const source = fakeFileSource(`${'x'.repeat(10_000)}\nshort\n`)
    const { lines } = await readLastLines(source.fileSource, path, { size: source.size, lastNLines: 10, maxBytes: 100 })

    expect(lines).toEqual(['short'])
  })
})

let updates: FollowUpdate[]
let file: ReturnType<typeof fakeFileSource>

beforeEach(() => {
  vi.useFakeTimers()
  updates = []
  file = fakeFileSource('first\nsecond\n')
})

afterEach(() => {
  vi.useRealTimers()
})

/** Follows the fake file from its end, as if its snapshot had shown all of it. */
function follow(options: Partial<FileFollowOptions> = {}) {
  return startFileFollow(file.fileSource, path, {
    from: file.size,
    identity: '1',
    cap: 1_000,
    emit: (update) => updates.push(update),
    ...options
  })
}

/** Lets a poll or two go by. */
const poll = (times = 1) => vi.advanceTimersByTimeAsync(fileFollowTiming.pollInterval * times)

const lines = () => updates.flatMap((update) => (update.kind === 'lines' ? update.lines : [`<${update.kind}>`]))

describe('following a file', () => {
  it('sends the lines added to it after the snapshot', async () => {
    follow()
    file.append('third\nfourth\n')
    await poll()
    file.append('fifth\n')
    await poll()

    expect(lines()).toEqual(['third', 'fourth', 'fifth'])
  })

  it('waits for a line to end before sending it', async () => {
    follow()
    file.append('thi')
    await poll()
    expect(lines()).toEqual([])

    file.append('rd\n')
    await poll()
    expect(lines()).toEqual(['third'])
  })

  it('goes on from where the snapshot’s whole lines ended, so a line it left unfinished comes whole', async () => {
    file.append('half a')
    follow({ from: file.size - 'half a'.length })
    file.append(' line\n')
    await poll()

    expect(lines()).toEqual(['half a line'])
  })

  it('marks a file cut short and follows it from its start', async () => {
    follow()
    file.append('unfinished')
    await poll()
    file.truncate('anew\n')
    await poll()

    expect(lines()).toEqual(['unfinished', '<truncated>', 'anew'])
  })

  it('marks a file replaced by another, as log rotation does, and follows the new one from its start', async () => {
    follow()
    file.replace('rotated in\nand more\n')
    await poll()

    expect(lines()).toEqual(['<rotated>', 'rotated in', 'and more'])
  })

  it('tells when the file has gone, tries again, and marks the new one when it comes back', async () => {
    follow()
    file.remove()
    await poll()
    expect(updates).toEqual([{ kind: 'failed', code: 'NOT_FOUND', message: expect.any(String), retryIn: followTiming.firstRetry }])

    file.replace('back\n')
    await vi.advanceTimersByTimeAsync(followTiming.firstRetry)
    expect(lines().slice(1)).toEqual(['<recovered>', '<rotated>', 'back'])
  })

  it('waits longer each time it fails in a row', async () => {
    follow()
    file.remove()
    await poll()
    await vi.advanceTimersByTimeAsync(followTiming.firstRetry)
    await vi.advanceTimersByTimeAsync(followTiming.firstRetry * 2)

    expect(updates.map((u) => u.kind === 'failed' && u.retryIn)).toEqual([1_000, 2_000, 4_000])
  })

  it('ends when the pod the file was in has gone', async () => {
    follow()
    file.failures.push(new CoreError('POD_GONE', 'Pod web-1 no longer exists'))
    await poll()

    expect(updates).toEqual([{ kind: 'ended', reason: 'gone' }])
    file.append('never sent\n')
    await poll(3)
    expect(updates).toHaveLength(1)
  })

  it('holds lines back while paused, at most its last N, and sends them on resuming', async () => {
    const following = follow({ cap: 2 })
    following.pause()
    file.append('a\nb\nc\n')
    await poll()
    expect(updates).toEqual([])

    following.resume()
    expect(lines()).toEqual(['b', 'c'])
  })

  it('sends nothing more once stopped, and stops looking at the file', async () => {
    const following = follow()
    following.stop()
    const reads = file.reads.length
    file.append('late\n')
    await poll(3)

    expect(updates).toEqual([])
    expect(file.reads).toHaveLength(reads)
  })
})
