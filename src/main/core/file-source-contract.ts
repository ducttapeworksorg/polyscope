import { describe, expect, it } from 'vitest'
import type { SourcePath } from '@shared/core-api'
import type { FileEntry, FileSource } from './file-source'

/** What a File Source under test starts with: each file's content by path, or null for an empty folder. */
export type SeedTree = Record<SourcePath, string | Uint8Array | null>

export interface ContractSubject {
  fileSource: FileSource
  /** Removes whatever seeding created. */
  dispose?(): Promise<void>
}

/** Bytes that differ from their neighbours, so a range read from the wrong place shows. */
function bytes(length: number) {
  const content = new Uint8Array(length)
  for (let i = 0; i < length; i++) content[i] = i % 251
  return content
}
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
/** Every entry of a folder, following its pages to the end. */
async function listAll(source: FileSource, path: SourcePath) {
  const entries: FileEntry[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 1000; pages++) {
    const page = await source.listChildren(path, cursor)
    entries.push(...page.entries)
    if (page.cursor === undefined) return entries
    cursor = page.cursor
  }
  throw new Error(`Listing ${path} never ended`)
}

/** What was listed, leaving out the optional metadata. */
const kindsAndNames = (entries: FileEntry[]) => entries.map(({ kind, name }) => ({ kind, name })).toSorted(byName)

/**
 * The behaviour every File Source must show. A Source Type's tests call this with a function
 * that seeds its backend with a tree and returns a File Source rooted at it.
 */
export function describeFileSourceContract(name: string, seed: (tree: SeedTree) => Promise<ContractSubject>) {
  const withSource = async (tree: SeedTree, run: (fileSource: FileSource) => Promise<void>) => {
    const subject = await seed(tree)
    try {
      await run(subject.fileSource)
    } finally {
      await subject.dispose?.()
    }
  }

  describe(`${name} as a File Source`, () => {
    describe('listing', () => {
      it('lists the files and folders in the root', () =>
        withSource({ 'a.log': 'a', 'logs/b.log': 'b', empty: null }, async (source) => {
          expect(kindsAndNames(await listAll(source, ''))).toEqual([
            { kind: 'file', name: 'a.log' },
            { kind: 'folder', name: 'empty' },
            { kind: 'folder', name: 'logs' }
          ])
        }))

      it('lists a nested folder', () =>
        withSource({ 'app/current/server.log': 'x', 'app/current/old': null }, async (source) => {
          expect(kindsAndNames(await listAll(source, 'app/current'))).toEqual([
            { kind: 'folder', name: 'old' },
            { kind: 'file', name: 'server.log' }
          ])
        }))

      it('lists sizes and modified times, where it gives them, that agree with stat', () =>
        withSource({ 'a.log': 'twelve bytes', logs: null }, async (source) => {
          for (const entry of await listAll(source, '')) {
            const info = await source.stat(entry.name)
            if (entry.size !== undefined && info.kind === 'file') expect(entry.size).toBe(info.size)
            if (entry.modifiedTime !== undefined) expect(entry.modifiedTime).toBe(info.modifiedTime)
          }
        }))

      it('lists an empty folder as empty', () =>
        withSource({ empty: null }, async (source) => {
          expect(await listAll(source, 'empty')).toEqual([])
        }))

      it('lists every entry of a large folder, page after page, without repeating any', () => {
        const tree: SeedTree = {}
        for (let i = 0; i < 2500; i++) tree[`big/file-${String(i).padStart(4, '0')}.log`] = ''
        return withSource(tree, async (source) => {
          const names = (await listAll(source, 'big')).map((e) => e.name).sort()
          expect(names).toEqual(Object.keys(tree).map((path) => path.slice('big/'.length)))
        })
      }, 300_000) // seeding thousands of entries takes minutes on some backends

      it('reports a folder that does not exist', () =>
        withSource({ 'a.log': 'a' }, async (source) => {
          await expect(source.listChildren('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }))

      it('refuses to list a file', () =>
        withSource({ 'a.log': 'a' }, async (source) => {
          await expect(source.listChildren('a.log')).rejects.toMatchObject({ code: 'NOT_A_FOLDER' })
        }))
    })

    describe('stat', () => {
      it('reports a file’s size and modified time', () =>
        withSource({ 'logs/a.log': 'twelve bytes' }, async (source) => {
          const before = Date.now()
          const info = await source.stat('logs/a.log')
          expect(info).toMatchObject({ kind: 'file', size: 12 })
          expect(info.modifiedTime).toBeGreaterThan(before - 10 * 60_000)
          expect(info.modifiedTime).toBeLessThanOrEqual(Date.now() + 60_000)
        }))

      it('reports folders, including the root, as folders', () =>
        withSource({ 'logs/a.log': 'a' }, async (source) => {
          expect(await source.stat('logs')).toMatchObject({ kind: 'folder' })
          expect(await source.stat('')).toMatchObject({ kind: 'folder' })
        }))

      it('reports a path that does not exist', () =>
        withSource({ 'a.log': 'a' }, async (source) => {
          await expect(source.stat('missing.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }))
    })

    describe('reading a byte range', () => {
      const content = bytes(1000)

      it('reads from the start', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 0, length: 10 })).toEqual(content.slice(0, 10))
        }))

      it('reads from the middle', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 400, length: 250 })).toEqual(content.slice(400, 650))
        }))

      it('reads up to the very end', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 990, length: 10 })).toEqual(content.slice(990))
        }))

      it('reads the whole file', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 0, length: 1000 })).toEqual(content)
        }))

      it('stops at the end of the file when the range runs past it', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 995, length: 100 })).toEqual(content.slice(995))
        }))

      it('reads nothing from the end of the file or beyond', () =>
        withSource({ 'data.bin': content }, async (source) => {
          expect(await source.read('data.bin', { offset: 1000, length: 10 })).toEqual(new Uint8Array())
          expect(await source.read('data.bin', { offset: 5000, length: 10 })).toEqual(new Uint8Array())
        }))

      it('reads nothing for an empty range or from an empty file', () =>
        withSource({ 'data.bin': content, 'empty.log': '' }, async (source) => {
          expect(await source.read('data.bin', { offset: 10, length: 0 })).toEqual(new Uint8Array())
          expect(await source.read('empty.log', { offset: 0, length: 10 })).toEqual(new Uint8Array())
        }))

      it('reads text as its UTF-8 bytes', () =>
        withSource({ 'a.log': 'first — ünïcode\n' }, async (source) => {
          const read = await source.read('a.log', { offset: 0, length: 100 })
          expect(new TextDecoder().decode(read)).toBe('first — ünïcode\n')
        }))

      it('reads the end of a large file', () => {
        const large = bytes(8 * 1024 * 1024)
        return withSource({ 'large.bin': large }, async (source) => {
          const end = await source.read('large.bin', { offset: large.length - 4096, length: 4096 })
          expect(end).toEqual(large.slice(-4096))
        })
      })

      it('refuses ranges that are negative or not whole numbers', () =>
        withSource({ 'a.log': 'abc' }, async (source) => {
          for (const range of [
            { offset: -1, length: 1 },
            { offset: 0, length: -1 },
            { offset: 0.5, length: 1 },
            { offset: 0, length: Number.NaN }
          ]) {
            await expect(source.read('a.log', range)).rejects.toMatchObject({ code: 'INVALID_RANGE' })
          }
        }))

      it('refuses to read a folder', () =>
        withSource({ 'logs/a.log': 'a' }, async (source) => {
          await expect(source.read('logs', { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'NOT_A_FILE' })
        }))

      it('reports a file that does not exist', () =>
        withSource({ 'a.log': 'a' }, async (source) => {
          await expect(source.read('missing.log', { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }))
    })
  })
}
