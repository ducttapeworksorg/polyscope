import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveCopyStatus } from '@shared/core-api'
import { CoreError } from './core-error'
import type { ByteRange, FileSource } from './file-source'
import { largeFileReading } from './large-file'
import { saveCopy } from './save-copy'

let dir: string
let target: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-save-copy-'))
  target = join(dir, 'app.log')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const chunk = largeFileReading.cacheChunk

/**
 * A File Source holding one file of `size` bytes (each byte its offset's last 8 bits), noting each range read; `onRead`
 * may hold a read back, or fail it.
 */
function fakeSource(size: number, onRead: (range: ByteRange) => Promise<void> = async () => {}) {
  const reads: ByteRange[] = []
  const fileSource: FileSource = {
    listChildren: async () => ({ entries: [] }),
    stat: async () => ({ kind: 'file', size, modifiedTime: 0 }),
    async read(_path, range) {
      reads.push(range)
      await onRead(range)
      const end = Math.min(size, range.offset + range.length)
      return Uint8Array.from({ length: Math.max(0, end - range.offset) }, (_, i) => (range.offset + i) & 0xff)
    }
  }
  return { fileSource, reads }
}

function save(fileSource: FileSource) {
  const statuses: SaveCopyStatus[] = []
  const saving = saveCopy({ fileSource, path: 'logs/app.log', target, onStatus: (status) => statuses.push(status) })
  return { saving, statuses }
}

describe('saving a copy', () => {
  it('reads the file a range at a time, no range larger than one read, reporting progress as it goes', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => performance.now() * 1000) // every read far enough apart to report it
    const size = 3 * chunk + 10
    const { fileSource, reads } = fakeSource(size)
    const { saving, statuses } = save(fileSource)
    await saving.done
    vi.restoreAllMocks()

    expect(reads).toEqual([
      { offset: 0, length: chunk },
      { offset: chunk, length: chunk },
      { offset: 2 * chunk, length: chunk },
      { offset: 3 * chunk, length: 10 }
    ])
    expect(statuses).toEqual([
      { state: 'saving', savedBytes: 0, totalBytes: size },
      { state: 'saving', savedBytes: chunk, totalBytes: size },
      { state: 'saving', savedBytes: 2 * chunk, totalBytes: size },
      { state: 'saving', savedBytes: 3 * chunk, totalBytes: size },
      { state: 'saving', savedBytes: size, totalBytes: size },
      { state: 'saved', savedBytes: size }
    ])
    expect((await readFile(target)).length).toBe(size)
  })

  it('stops when cancelled, without waiting for a read on its way, and leaves nothing behind', async () => {
    let held: (() => void) | undefined
    const { fileSource, reads } = fakeSource(3 * chunk, (range) => (range.offset > 0 ? new Promise((resolve) => (held = resolve)) : Promise.resolve()))
    const { saving, statuses } = save(fileSource)
    await vi.waitFor(() => expect(held).toBeDefined())

    saving.cancel()
    await saving.done

    expect(statuses.at(-1)).toEqual({ state: 'cancelled' })
    expect(await readdir(dir)).toEqual([])
    held!()
    expect(reads).toHaveLength(2)
  })

  it('leaves nothing behind when cancelled the moment it starts', async () => {
    const { saving, statuses } = save(fakeSource(3 * chunk).fileSource)
    saving.cancel()
    await saving.done

    expect(statuses).toEqual([{ state: 'cancelled' }])
    expect(await readdir(dir)).toEqual([])
  })

  it('fails saying why when a read fails midway, and leaves nothing behind', async () => {
    const { fileSource } = fakeSource(3 * chunk, async (range) => {
      if (range.offset > 0) throw new CoreError('UNREACHABLE', 'The connection to the server dropped')
    })
    const { saving, statuses } = save(fileSource)
    await saving.done

    expect(statuses.at(-1)).toEqual({ state: 'failed', code: 'UNREACHABLE', message: 'The connection to the server dropped' })
    expect(await readdir(dir)).toEqual([])
  })

  it('fails, as aborted, when its Source is disconnected meanwhile', async () => {
    const { fileSource } = fakeSource(3 * chunk, (range) => (range.offset > 0 ? new Promise(() => {}) : Promise.resolve()))
    const { saving, statuses } = save(fileSource)
    await vi.waitFor(() => expect(statuses.length).toBeGreaterThan(0))

    saving.abort('SOURCE_DISCONNECTED', 'The Source was disconnected')
    await saving.done

    expect(statuses.at(-1)).toEqual({ state: 'failed', code: 'SOURCE_DISCONNECTED', message: 'The Source was disconnected' })
    expect(await readdir(dir)).toEqual([])
  })

  it('replaces a file already there only once the copy is whole, keeping it if the save fails', async () => {
    await writeFile(target, 'kept')
    const failing = fakeSource(2 * chunk, async (range) => {
      if (range.offset > 0) throw new CoreError('NOT_FOUND', 'Gone')
    })
    await save(failing.fileSource).saving.done
    expect(await readFile(target, 'utf8')).toBe('kept')

    await save(fakeSource(5).fileSource).saving.done
    expect([...(await readFile(target))]).toEqual([0, 1, 2, 3, 4])
    expect(await readdir(dir)).toEqual(['app.log'])
  })

  it('fails saying why when the copy can’t be written where it’s to go', async () => {
    target = join(dir, 'missing-folder', 'app.log')
    const { saving, statuses } = save(fakeSource(5).fileSource)
    await saving.done

    expect(statuses.at(-1)).toMatchObject({ state: 'failed', code: 'SAVE_UNWRITABLE' })
    expect(await readdir(dir)).toEqual([])
  })

  it('tells nothing more once done', async () => {
    const { saving, statuses } = save(fakeSource(5).fileSource)
    await saving.done
    const told = statuses.length

    saving.cancel()
    saving.abort('SOURCE_DISCONNECTED', 'Disconnected')
    await Promise.resolve()

    expect(statuses).toHaveLength(told)
  })
})
