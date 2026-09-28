import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat, utimes, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { MB } from '@shared/settings'
import { CoreError } from './core-error'

/** A file in the cache, kept there (never evicted) until released. */
export interface CacheEntry {
  /** Where the cached bytes are on disk. */
  path: string
  size: number
  release(): void
}

/** A file on its way into the cache; nothing of it is found in the cache until it's committed. */
export interface CacheWriter {
  /** Adds bytes to the end, first evicting what's needed to make room for them. */
  write(bytes: Uint8Array): Promise<void>
  /** Puts what was written in the cache, in use by the writer until released. */
  commit(): Promise<CacheEntry>
  /** Throws away what was written. */
  abort(): Promise<void>
}

export interface LargeFileCache {
  /** The file cached under `key`, marked as just used, or null if there isn't one. */
  open(key: string): Promise<CacheEntry | null>
  /** Starts caching a file under `key`; room for `size` bytes is made at once when it's known up front. */
  create(key: string, size?: number): Promise<CacheWriter>
}

interface Stored {
  size: number
  lastUsed: number
  users: number
}

const partSuffix = '.part'
const isKey = (name: string) => /^[0-9a-f]{64}$/.test(name)

const unwritable = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('CACHE_UNWRITABLE', `The Large File cache couldn’t be written: ${error instanceof Error ? error.message : String(error)}`)

/**
 * The local cache of Large Files: one file per key in `dir`, holding at most `cap()` bytes altogether. Making
 * room evicts the least recently used files not in use; a file that doesn't fit even then fails CACHE_TOO_SMALL.
 * What's cached outlives the app: files found in `dir` count as used when they were last modified.
 */
export function createLargeFileCache(dir: string, cap: () => number): LargeFileCache {
  const entries = new Map<string, Stored>()
  // Bytes room has been made for, by files still being written.
  const reserved = new Map<object, number>()

  const loaded = (async () => {
    await mkdir(dir, { recursive: true })
    for (const name of await readdir(dir)) {
      // A file part-written when the app last stopped is of no use.
      if (!isKey(name)) {
        if (name.endsWith(partSuffix)) await rm(join(dir, name), { force: true }).catch(() => undefined)
        continue
      }
      const info = await stat(join(dir, name)).catch(() => null)
      if (info?.isFile()) entries.set(name, { size: info.size, lastUsed: info.mtimeMs, users: 0 })
    }
  })()

  // What's being done to each key's file on disk, one thing at a time: an evicted file is deleted before
  // a new copy is renamed into its place, and two copies committed together don't both think they're first.
  const onDisk = new Map<string, Promise<unknown>>()
  const inTurn = <T>(key: string, work: () => Promise<T>) => {
    const turn = (onDisk.get(key) ?? Promise.resolve()).then(work)
    const settled = turn.catch(() => undefined)
    onDisk.set(key, settled)
    void settled.then(() => onDisk.get(key) === settled && onDisk.delete(key))
    return turn
  }

  const discard = (path: string) => rm(path, { force: true }).catch(() => undefined)

  const used = () => [...entries.values()].reduce((sum, e) => sum + e.size, 0) + [...reserved.values()].reduce((sum, n) => sum + n, 0)

  /**
   * Evicts least recently used files until `bytes` more fit under the cap, and reserves them for `writer`;
   * fails if they can't be made to fit. Decided at once, so writers making room together don't both count the same room.
   */
  const makeRoom = async (writer: object, bytes: number) => {
    const limit = cap()
    const evicted: string[] = []
    while (used() + bytes > limit) {
      const victim = [...entries].filter(([, e]) => e.users === 0).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]
      if (!victim) {
        throw new CoreError('CACHE_TOO_SMALL', `The file is larger than the ${Math.floor(limit / MB)} MB Large File cache has room for`)
      }
      entries.delete(victim[0])
      evicted.push(victim[0])
    }
    reserved.set(writer, reserved.get(writer)! + bytes)
    await Promise.all(evicted.map((key) => inTurn(key, () => discard(join(dir, key)))))
  }

  const handOut = (key: string, stored: Stored): CacheEntry => {
    stored.users++
    let released = false
    return {
      path: join(dir, key),
      size: stored.size,
      release() {
        if (released) return
        released = true
        stored.users--
      }
    }
  }

  const touch = (key: string, stored: Stored) => {
    stored.lastUsed = Date.now()
    const now = new Date(stored.lastUsed)
    // Only for the next launch's sake, so a failure costs nothing now.
    void utimes(join(dir, key), now, now).catch(() => undefined)
  }

  return {
    async open(key) {
      await loaded
      const stored = entries.get(key)
      if (!stored) return null
      touch(key, stored)
      return handOut(key, stored)
    },

    async create(key, size) {
      await loaded
      const writer = {}
      const partPath = join(dir, `${key}.${randomUUID()}${partSuffix}`)
      let written = 0
      let file: FileHandle | undefined
      const finish = async () => {
        reserved.delete(writer)
        await file?.close().catch(() => undefined)
        file = undefined
      }
      try {
        reserved.set(writer, 0)
        if (size !== undefined) await makeRoom(writer, size)
        file = await open(partPath, 'w')
      } catch (error) {
        await finish()
        await discard(partPath)
        throw unwritable(error)
      }
      return {
        async write(bytes) {
          try {
            const more = written + bytes.length - reserved.get(writer)!
            if (more > 0) await makeRoom(writer, more)
            await file!.write(bytes)
            written += bytes.length
          } catch (error) {
            throw unwritable(error)
          }
        },
        async commit() {
          await finish()
          return inTurn(key, async () => {
            const existing = entries.get(key)
            // Cached meanwhile by another opening of the same file: that copy will do.
            if (existing) {
              await discard(partPath)
              touch(key, existing)
              return handOut(key, existing)
            }
            try {
              await rename(partPath, join(dir, key))
            } catch (error) {
              await discard(partPath)
              throw unwritable(error)
            }
            const stored = { size: written, lastUsed: Date.now(), users: 0 }
            entries.set(key, stored)
            return handOut(key, stored)
          })
        },
        async abort() {
          await finish()
          await discard(partPath)
        }
      }
    }
  }
}
