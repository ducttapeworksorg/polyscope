import type { SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileEntry, FileSource, FileStat } from './file-source'

/** An object in a store, by its whole key. */
export interface StoredObject {
  key: string
  size?: number
  modifiedTime?: Date
}

/**
 * What a File Source needs of a store keeping objects by key, with '/' in keys standing for folders: an S3 bucket, an
 * Azure Blob Storage container. Each throws CoreError, saying where with the key it's given.
 */
export interface ObjectStore {
  /**
   * One page, of `limit` keys at most, of what lies directly under `prefix` (blank, or ending in '/'): the key prefixes
   * up to the next '/', each ending in it, and the objects, the prefix's own marker object included if it has one.
   */
  listPage(prefix: string, limit: number, cursor?: string): Promise<{ prefixes: string[]; objects: StoredObject[]; cursor?: string }>
  /** What the object `key` is; undefined if there's no such object. A store with directories of its own may say it's one. */
  head(key: string): Promise<FileStat | undefined>
  /** Whether any key starts with `prefix`. */
  hasKeysUnder(prefix: string): Promise<boolean>
  /** The bytes in a range of the object `key`, which is at least a byte long: none if it starts at the end or beyond. NOT_FOUND if there's no such object. */
  read(key: string, offset: number, length: number): Promise<Uint8Array>
  /** Where the object `key` is, as the store's users would write it, for errors to name. */
  where(key: string): string
}

const isWholeNumber = (n: number) => Number.isSafeInteger(n) && n >= 0

/**
 * A modified time to the second: listings may give milliseconds but a HEAD's Last-Modified header only seconds, and a
 * file's time shouldn't change between the tree and the opened file.
 */
const toSeconds = (time: number) => Math.floor(time / 1000) * 1000

/**
 * A File Source over the objects under a store's `prefix` (no leading or trailing '/'; blank for all of them), with key
 * prefixes up to a '/' shown as folders. An object and a key prefix may share a name: both are listed, the object
 * opened as a file and the prefix expanded as a folder.
 */
export function createObjectStoreFileSource(store: ObjectStore, { prefix, pageSize }: { prefix: string; pageSize: number }): FileSource {
  const root = prefix ? `${prefix}/` : ''
  const keyOf = (path: SourcePath) => root + path
  const folderKeyOf = (path: SourcePath) => (path ? `${root}${path}/` : root)
  const where = (path: SourcePath) => store.where(keyOf(path))

  /** Whether any key lies under the folder `path` (a zero-byte `path/` marker counts). */
  const isFolder = (path: SourcePath) => (path ? store.hasKeysUnder(folderKeyOf(path)) : Promise.resolve(true))

  /** The error for `path` not being a file: it's a folder, or nothing at all. */
  const notAFile = async (path: SourcePath) =>
    (await isFolder(path))
      ? new CoreError('NOT_A_FILE', `Not a file: ${where(path)}`)
      : new CoreError('NOT_FOUND', `No such object: ${where(path)}`)

  const stat = async (path: SourcePath): Promise<FileStat> => {
    if (!path) return { kind: 'folder' }
    const object = await store.head(keyOf(path))
    if (object?.kind === 'file') return { ...object, modifiedTime: toSeconds(object.modifiedTime) }
    if (object || (await isFolder(path))) return { kind: 'folder' }
    throw new CoreError('NOT_FOUND', `No such object: ${where(path)}`)
  }

  return {
    async listChildren(path, cursor) {
      const folderKey = folderKeyOf(path)
      const page = await store.listPage(folderKey, pageSize, cursor)
      const nameIn = (key: string) => key.slice(folderKey.length).replace(/\/$/, '')
      const folders = page.prefixes.map((key): FileEntry => ({ kind: 'folder', name: nameIn(key) }))
      // The folder's own marker, if it has one, isn't one of its entries.
      const objects = page.objects.filter(({ key }) => key !== folderKey)
      const files = objects.map(
        ({ key, size, modifiedTime }): FileEntry => ({
          kind: 'file',
          name: nameIn(key),
          ...(size !== undefined && { size }),
          ...(modifiedTime && { modifiedTime: toSeconds(modifiedTime.getTime()) })
        })
      )
      // Keys like `a//b` would make a folder with no name, which no path could reach.
      const entries = [...folders, ...files].filter((e) => e.name)
      if (path && !cursor && page.prefixes.length + page.objects.length === 0) {
        // A store with directories of its own (Azure's Data Lake) has empty ones with nothing under them.
        const kind = (await stat(path)).kind
        if (kind === 'folder') return { entries: [] }
        throw new CoreError('NOT_A_FOLDER', `Not a folder: ${where(path)}`)
      }
      return page.cursor ? { entries, cursor: page.cursor } : { entries }
    },

    stat,

    async read(path, { offset, length }) {
      if (!isWholeNumber(offset) || !isWholeNumber(length)) {
        throw new CoreError('INVALID_RANGE', `Not a valid byte range: offset ${offset}, length ${length}`)
      }
      if (length === 0) {
        if ((await stat(path)).kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${where(path)}`)
        return new Uint8Array()
      }
      try {
        return await store.read(keyOf(path), offset, length)
      } catch (error) {
        if (error instanceof CoreError && error.code === 'NOT_FOUND') throw await notAFile(path)
        throw error
      }
    }
  }
}
