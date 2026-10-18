import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveCopyEvent } from '@shared/core-api'
import { createCore, type Core } from './core'
import { largeFileReading } from './large-file'

let dir: string
let saves: string
let core: Core
let sourceId: string
let events: SaveCopyEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-save-source-'))
  saves = await mkdtemp(join(tmpdir(), 'polyscope-saves-'))
  await mkdir(join(dir, 'logs'))
  core = createCore()
  sourceId = (await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })).id
  await core.connect(sourceId)
  events = []
  core.onSaveCopyEvent((event) => events.push(event))
})

afterEach(async () => {
  await core.disconnect(sourceId)
  await rm(dir, { recursive: true, force: true })
  await rm(saves, { recursive: true, force: true })
})

/** The last status told of a save, once it's done. */
async function outcome(saveId: string) {
  await vi.waitFor(() => expect(events.find((e) => e.saveId === saveId && e.state !== 'saving')).toBeDefined(), { timeout: 10_000 })
  return events.findLast((e) => e.saveId === saveId)
}

describe('saving a copy of a file', () => {
  it('saves the file’s bytes where it was asked to, telling its progress under the id it returns', async () => {
    await writeFile(join(dir, 'logs', 'app.log'), 'INFO started\n')
    const target = join(saves, 'app.log')

    const { saveId, target: savedTo } = await core.saveCopy(sourceId, 'logs/app.log', target)

    expect(savedTo).toBe(target)
    expect(await outcome(saveId)).toEqual({ saveId, state: 'saved', savedBytes: 13 })
    expect(await readFile(target, 'utf8')).toBe('INFO started\n')
  })

  it('saves a compressed file as stored, not decompressed', async () => {
    const compressed = gzipSync('INFO started\n'.repeat(1000))
    await writeFile(join(dir, 'logs', 'app.log.gz'), compressed)
    const target = join(saves, 'app.log.gz')

    const { saveId } = await core.saveCopy(sourceId, 'logs/app.log.gz', target)

    expect(await outcome(saveId)).toMatchObject({ state: 'saved', savedBytes: compressed.length })
    expect((await readFile(target)).equals(compressed)).toBe(true)
  })

  it('stops a save when it’s cancelled, leaving nothing of it behind', async () => {
    await writeFile(join(dir, 'logs', 'big.log'), Buffer.alloc(20 * largeFileReading.cacheChunk, 'x'))

    const { saveId } = await core.saveCopy(sourceId, 'logs/big.log', join(saves, 'big.log'))
    await core.cancelSaveCopy(saveId)

    expect(await outcome(saveId)).toEqual({ saveId, state: 'cancelled' })
    expect(await readdir(saves)).toEqual([])
  })

  it('fails a save when its Source is disconnected meanwhile, leaving nothing of it behind', async () => {
    await writeFile(join(dir, 'logs', 'big.log'), Buffer.alloc(20 * largeFileReading.cacheChunk, 'x'))

    const { saveId } = await core.saveCopy(sourceId, 'logs/big.log', join(saves, 'big.log'))
    await core.disconnect(sourceId)

    expect(await outcome(saveId)).toMatchObject({ state: 'failed', code: 'SOURCE_DISCONNECTED' })
    expect(await readdir(saves)).toEqual([])
  })

  it('refuses to save a copy of a Local file over the file itself', async () => {
    await writeFile(join(dir, 'logs', 'app.log'), 'INFO started\n')

    await expect(core.saveCopy(sourceId, 'logs/app.log', join(dir, 'logs', 'app.log'))).rejects.toMatchObject({ code: 'SAVE_OVER_SOURCE' })
    expect(await readFile(join(dir, 'logs', 'app.log'), 'utf8')).toBe('INFO started\n')
  })

  it('refuses a place to save to that isn’t an absolute path', async () => {
    await writeFile(join(dir, 'logs', 'app.log'), 'x')
    await expect(core.saveCopy(sourceId, 'logs/app.log', 'app.log')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('refuses a file that isn’t there, and a Source that isn’t connected', async () => {
    await expect(core.saveCopy(sourceId, 'logs/missing.log', join(saves, 'missing.log'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(core.saveCopy(sourceId, 'logs', join(saves, 'logs'))).rejects.toMatchObject({ code: 'NOT_A_FILE' })
    await core.disconnect(sourceId)
    await expect(core.saveCopy(sourceId, 'logs/app.log', join(saves, 'app.log'))).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
  })

  it('does nothing when cancelling a save that’s done or never was', async () => {
    await expect(core.cancelSaveCopy('no-such-save')).resolves.toBeUndefined()
  })
})
