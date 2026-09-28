import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LargeFile, LargeFileEvent, OpenedFile } from '@shared/core-api'
import { MB } from '@shared/settings'
import { createCore, type Core } from './core'

let dir: string
let cacheDir: string
let core: Core
let sourceId: string
let events: LargeFileEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-large-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'polyscope-large-cache-'))
  core = createCore({ cacheDir })
  sourceId = (await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })).id
  events = []
  core.onLargeFileEvent((event) => events.push(event))
})

afterEach(async () => {
  await core.disconnect(sourceId)
  await rm(dir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

/** Line `n` (from 0) of a generated log: 100 bytes with its line break, so any line's place is known. */
const lineOf = (n: number) => `${String(n).padStart(10, '0')} INFO ${'x'.repeat(83)}`

/** A generated log of `lines` lines, each ended by a line break. */
const generated = (lines: number, from = 0) => Array.from({ length: lines }, (_, i) => `${lineOf(from + i)}\n`).join('')

/** Writes a generated log of `lines` lines to `name`, a block at a time, so hundreds of MB never sit in memory. */
async function writeGenerated(name: string, lines: number) {
  const out = createWriteStream(join(dir, name))
  const block = 10_000
  for (let from = 0; from < lines; from += block) {
    if (!out.write(generated(Math.min(block, lines - from), from))) await new Promise((resolve) => out.once('drain', resolve))
  }
  out.end()
  await finished(out)
}

/** A small threshold and cache, so a few MB are enough to be Large; the cache holds `cacheSizeCap` bytes. */
const smallLimits = (cacheSizeCap = 4 * MB) => core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap })

const asLarge = (file: OpenedFile) => {
  expect(file.view).toBe('large')
  return file as LargeFile
}

async function openLarge(path: string) {
  await core.connect(sourceId).catch(() => undefined)
  return asLarge(await core.openFile(sourceId, path))
}

/** Waits for a Large File to be cached and indexed, returning its status then. */
async function ready(largeFileId: string, timeout = 60_000) {
  await vi.waitFor(
    async () => {
      const status = await core.largeFileStatus(largeFileId)
      if (status.state === 'failed') throw new Error(`failed: ${status.code} ${status.message}`)
      expect(status.state).toBe('ready')
    },
    { timeout, interval: 20 }
  )
  const status = await core.largeFileStatus(largeFileId)
  if (status.state !== 'ready') throw new Error('not ready')
  return status
}

const cacheBytes = async () => {
  const names = await readdir(cacheDir)
  const sizes = await Promise.all(names.map(async (name) => (await stat(join(cacheDir, name))).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}

describe('opening a Large File', () => {
  it('opens files over the threshold in the Large File Viewer, and the rest in the editor', async () => {
    await smallLimits()
    await writeFile(join(dir, 'small.log'), generated(10_000)) // 1,000,000 bytes: just under 1 MB
    await writeFile(join(dir, 'large.log'), generated(10_486)) // 1,048,600 bytes: just over
    await core.connect(sourceId)

    expect(await core.openFile(sourceId, 'small.log')).toMatchObject({ view: 'editor' })
    const large = asLarge(await core.openFile(sourceId, 'large.log'))
    expect(large).toMatchObject({ path: 'large.log', name: 'large.log', size: 1_048_600, encoding: 'utf-8', largeFileId: expect.any(String) })
  })

  it('opens a multi-hundred-MB file at its end at once, then caches and indexes the whole of it', { timeout: 180_000 }, async () => {
    const lines = 3_000_000 // 300 MB
    await writeGenerated('huge.log', lines)

    const file = await openLarge('huge.log')

    // The end is there straight away, before the file has been read through.
    expect(file.lastLines.at(-1)).toBe(lineOf(lines - 1))
    expect(file.lastLines).toEqual(Array.from({ length: file.lastLines.length }, (_, i) => lineOf(lines - file.lastLines.length + i)))
    expect(await core.largeFileStatus(file.largeFileId)).toMatchObject({ state: 'caching', totalBytes: 300_000_000 })

    expect(await ready(file.largeFileId, 170_000)).toEqual({ state: 'ready', lineCount: lines, fromCache: false })
    const progress = events.filter((e) => e.largeFileId === file.largeFileId && e.state === 'caching')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.map((e) => (e.state === 'caching' ? e.loadedBytes : 0))).toEqual(progress.map((e) => (e.state === 'caching' ? e.loadedBytes : 0)).toSorted((a, b) => a - b))

    for (const at of [0, 1, 255, 256, 257, 1_234_567, lines - 3]) {
      expect(await core.readLargeFileLines(file.largeFileId, at, 3)).toEqual({ firstLine: at, lines: [lineOf(at), lineOf(at + 1), lineOf(at + 2)] })
    }
  })

  it('jumps to any line, stopping at the end of the file', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log'), generated(20_000))
    const { largeFileId } = await openLarge('app.log')
    await ready(largeFileId)

    expect(await core.readLargeFileLines(largeFileId, 12_345, 2)).toEqual({ firstLine: 12_345, lines: [lineOf(12_345), lineOf(12_346)] })
    expect(await core.readLargeFileLines(largeFileId, 19_999, 5)).toEqual({ firstLine: 19_999, lines: [lineOf(19_999)] })
    expect(await core.readLargeFileLines(largeFileId, 25_000, 5)).toEqual({ firstLine: 20_000, lines: [] })
    await expect(core.readLargeFileLines(largeFileId, -1, 5)).rejects.toMatchObject({ code: 'INVALID_RANGE' })
    await expect(core.readLargeFileLines(largeFileId, 0, 0)).rejects.toMatchObject({ code: 'INVALID_RANGE' })
  })

  it('shows a last line without a line break, Windows line ends without their carriage returns, and cuts very long lines short', async () => {
    await smallLimits()
    const long = 'y'.repeat(100_000)
    await writeFile(join(dir, 'app.log'), `${generated(11_000).replaceAll('\n', '\r\n')}${long}\nlast`)
    const file = await openLarge('app.log')

    expect(file.lastLines.slice(-2)).toEqual([expect.stringMatching(/^y+…$/), 'last'])
    const { lineCount } = await ready(file.largeFileId)
    expect(lineCount).toBe(11_002)
    const { lines } = await core.readLargeFileLines(file.largeFileId, 10_999, 3)
    expect(lines[0]).toBe(lineOf(10_999))
    expect(lines[1]!.length).toBeLessThan(long.length)
    expect(lines[1]).toMatch(/^y+…$/)
    expect(lines[2]).toBe('last')
  })

  it('decodes a Latin-1 file as Latin-1', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log'), Buffer.from(`${generated(11_000)}olé ©\n`, 'latin1'))
    const file = await openLarge('app.log')

    expect(file.encoding).toBe('latin1')
    expect(file.lastLines.at(-1)).toBe('olé ©')
    await ready(file.largeFileId)
    expect((await core.readLargeFileLines(file.largeFileId, 11_000, 1)).lines).toEqual(['olé ©'])
  })

  it('shows a binary Large File as binary, and its start as hex, without reading it all', async () => {
    await smallLimits()
    const binary = Buffer.alloc(2 * MB, 0)
    await writeFile(join(dir, 'image.bin'), binary)
    await core.connect(sourceId)

    expect(await core.openFile(sourceId, 'image.bin')).toMatchObject({ view: 'binary', size: 2 * MB, contentLength: 2 * MB })
    expect(await core.openFile(sourceId, 'image.bin', { hex: true })).toMatchObject({ view: 'hex', contentLength: 2 * MB, shownLength: MB })
  })

  it('isn’t read until it’s cached and indexed', { timeout: 60_000 }, async () => {
    await smallLimits()
    await writeGenerated('app.log', 1_000_000) // 100 MB: not read through in the moment it takes to ask
    const { largeFileId } = await openLarge('app.log')

    await expect(core.readLargeFileLines(largeFileId, 0, 10)).rejects.toMatchObject({ code: 'LARGE_FILE_NOT_READY' })
  })

  it('is closed for good once closed', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log'), generated(20_000))
    const { largeFileId } = await openLarge('app.log')
    await ready(largeFileId)

    await core.closeLargeFile(largeFileId)

    await expect(core.readLargeFileLines(largeFileId, 0, 10)).rejects.toMatchObject({ code: 'LARGE_FILE_NOT_OPEN' })
    await expect(core.largeFileStatus(largeFileId)).rejects.toMatchObject({ code: 'LARGE_FILE_NOT_OPEN' })
    await expect(core.closeLargeFile('nope')).resolves.toBeUndefined()
  })

  it('stops caching when its Source is disconnected', { timeout: 30_000 }, async () => {
    await smallLimits(200 * MB)
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(500_000), { level: 1 })) // 50 MB inside
    const { largeFileId } = await openLarge('app.log.gz')

    await core.disconnect(sourceId)

    expect(await core.largeFileStatus(largeFileId)).toMatchObject({ state: 'failed', code: 'SOURCE_DISCONNECTED' })
    await vi.waitFor(async () => expect(await readdir(cacheDir)).toEqual([]))
  })
})

describe('compressed Large Files', () => {
  it('opens a file that decompresses to more than the threshold once decompressed, then caches it', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(20_000)))
    await writeFile(join(dir, 'app.log.zst'), zstdCompressSync(generated(20_000)))

    for (const name of ['app.log.gz', 'app.log.zst']) {
      const file = await openLarge(name)
      expect(file).toMatchObject({ compression: name.endsWith('gz') ? 'gzip' : 'zstd', encoding: 'utf-8', lastLines: [] })
      expect(await ready(file.largeFileId)).toEqual({ state: 'ready', lineCount: 20_000, fromCache: false })
      expect(await core.readLargeFileLines(file.largeFileId, 19_998, 5)).toEqual({ firstLine: 19_998, lines: [lineOf(19_998), lineOf(19_999)] })
    }
  })

  it('opens a file that decompresses to no more than the threshold in the editor, as before', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(10_000)))
    await core.connect(sourceId)

    expect(await core.openFile(sourceId, 'app.log.gz')).toMatchObject({ view: 'editor', compression: 'gzip', content: generated(10_000) })
  })

  it('reads a cached file from the cache when it’s opened again', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(20_000)))
    const first = await openLarge('app.log.gz')
    await ready(first.largeFileId)
    await core.closeLargeFile(first.largeFileId)

    const again = await openLarge('app.log.gz')

    expect(await ready(again.largeFileId)).toEqual({ state: 'ready', lineCount: 20_000, fromCache: true })
    expect((await core.readLargeFileLines(again.largeFileId, 5, 1)).lines).toEqual([lineOf(5)])
  })

  it('caches a file anew once it has changed', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(20_000)))
    const first = await openLarge('app.log.gz')
    await ready(first.largeFileId)
    await core.closeLargeFile(first.largeFileId)
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(21_000)))

    const again = await openLarge('app.log.gz')

    expect(await ready(again.largeFileId)).toEqual({ state: 'ready', lineCount: 21_000, fromCache: false })
  })

  it('evicts the least recently used files to stay within the cache size cap', async () => {
    await smallLimits(5 * MB)
    // 2 MB each once decompressed: two fit in the cache, three don't.
    for (const name of ['a', 'b', 'c']) await writeFile(join(dir, `${name}.log.gz`), gzipSync(generated(20_000)))
    const cacheAndClose = async (name: string) => {
      const file = await openLarge(`${name}.log.gz`)
      const status = await ready(file.largeFileId)
      await core.closeLargeFile(file.largeFileId)
      return status.fromCache
    }

    expect(await cacheAndClose('a')).toBe(false)
    expect(await cacheAndClose('b')).toBe(false)
    expect(await cacheAndClose('a')).toBe(true) // now b is the least recently used
    expect(await cacheAndClose('c')).toBe(false)

    expect(await cacheBytes()).toBeLessThanOrEqual(5 * MB)
    expect(await cacheAndClose('a')).toBe(true)
    expect(await cacheAndClose('b')).toBe(false)
  })

  it('keeps a file open in a viewer in the cache, however long ago it was used', async () => {
    await smallLimits(5 * MB)
    for (const name of ['a', 'b', 'c']) await writeFile(join(dir, `${name}.log.gz`), gzipSync(generated(20_000)))
    const a = await openLarge('a.log.gz')
    await ready(a.largeFileId)
    for (const name of ['b', 'c']) {
      const file = await openLarge(`${name}.log.gz`)
      await ready(file.largeFileId)
      await core.closeLargeFile(file.largeFileId)
    }

    expect((await core.readLargeFileLines(a.largeFileId, 7, 1)).lines).toEqual([lineOf(7)])
  })

  it('fails to cache a file larger than the whole cache, leaving what it has shown', async () => {
    await smallLimits(MB)
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(20_000)))
    const { largeFileId } = await openLarge('app.log.gz')

    await vi.waitFor(async () => expect(await core.largeFileStatus(largeFileId)).toMatchObject({ state: 'failed', code: 'CACHE_TOO_SMALL' }))
    expect(await cacheBytes()).toBe(0)
  })

  it('picks up a cache left by an earlier launch', async () => {
    await smallLimits()
    await writeFile(join(dir, 'app.log.gz'), gzipSync(generated(20_000)))
    const first = await openLarge('app.log.gz')
    await ready(first.largeFileId)
    await core.closeLargeFile(first.largeFileId)
    await core.disconnect(sourceId)

    const relaunched = createCore({ cacheDir })
    const source = await relaunched.addSource({ type: 'local', name: 'Logs', rootPath: dir })
    await relaunched.updateSettings({ largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap: 4 * MB })
    await relaunched.connect(source.id)
    const again = asLarge(await relaunched.openFile(source.id, 'app.log.gz'))

    await vi.waitFor(async () => expect(await relaunched.largeFileStatus(again.largeFileId)).toEqual({ state: 'ready', lineCount: 20_000, fromCache: true }))
    await relaunched.disconnect(source.id)
  })
})
