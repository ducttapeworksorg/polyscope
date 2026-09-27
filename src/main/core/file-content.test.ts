import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from './core'
import { hexDumpLimit } from './file-content'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-content-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes each fixture into the Source's root and returns a connected core and Source. */
async function withFiles(files: Record<string, string | Uint8Array>) {
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  const core = createCore()
  const source = await core.addSource({ type: 'local', name: 'Files', rootPath: dir })
  await core.connect(source.id)
  return { core, source, open: (path: string, options?: Parameters<typeof core.openFile>[2]) => core.openFile(source.id, path, options) }
}

const utf16le = (text: string) => Buffer.from(text, 'utf16le')
const utf16be = (text: string) => utf16le(text).swap16()
const text = 'héllo — wörld\nsecond line\n'

describe('encoding detection', () => {
  it('reads UTF-8 without a BOM', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.from(text, 'utf8') })

    expect(await open('a.txt')).toMatchObject({ view: 'editor', content: text, encoding: 'utf-8' })
  })

  it('reads UTF-8 with a BOM, leaving the BOM out of the content', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) })

    expect(await open('a.txt')).toMatchObject({ view: 'editor', content: text, encoding: 'utf-8' })
  })

  it('reads UTF-16 LE with a BOM', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(text)]) })

    expect(await open('a.txt')).toMatchObject({ view: 'editor', content: text, encoding: 'utf-16le' })
  })

  it('reads UTF-16 BE with a BOM', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]) })

    expect(await open('a.txt')).toMatchObject({ view: 'editor', content: text, encoding: 'utf-16be' })
  })

  it('falls back to Latin-1 when the bytes aren’t valid UTF-8', async () => {
    const latin = 'héllo wörld - ¡olé! ©\n'
    const { open } = await withFiles({ 'a.txt': Buffer.from(latin, 'latin1') })

    expect(await open('a.txt')).toMatchObject({ view: 'editor', content: latin, encoding: 'latin1' })
  })

  it('reads an empty file as UTF-8 text', async () => {
    const { open } = await withFiles({ 'empty.log': '' })

    expect(await open('empty.log')).toMatchObject({ view: 'editor', content: '', encoding: 'utf-8', size: 0 })
  })

  it('reopens with the encoding asked for, whatever was detected', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.from(text, 'utf8') })

    const reopened = await open('a.txt', { encoding: 'latin1' })

    expect(reopened).toMatchObject({ view: 'editor', encoding: 'latin1', content: Buffer.from(text, 'utf8').toString('latin1') })
  })

  it('drops the BOM of the encoding asked for', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(text)]) })

    expect(await open('a.txt', { encoding: 'utf-16le' })).toMatchObject({ content: text, encoding: 'utf-16le' })
  })

  it('refuses an encoding it doesn’t know', async () => {
    const { open } = await withFiles({ 'a.txt': 'x' })

    // @ts-expect-error: not one of the encodings on offer
    await expect(open('a.txt', { encoding: 'ebcdic' })).rejects.toMatchObject({ code: 'INVALID_ENCODING' })
  })
})

describe('binary files', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256)

  it('are shown as binary with their size, and no content', async () => {
    const { open } = await withFiles({ 'image.bin': bytes })

    const file = await open('image.bin')

    expect(file).toEqual({ view: 'binary', path: 'image.bin', name: 'image.bin', size: 300, contentLength: 300, modifiedTime: expect.any(Number) })
  })

  it('include UTF-32, whose BOM starts like UTF-16’s', async () => {
    const { open } = await withFiles({ 'a.txt': Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]) })

    expect(await open('a.txt')).toMatchObject({ view: 'binary' })
  })

  it('are told apart from text by a NUL byte', async () => {
    const { open } = await withFiles({ 'a.log': 'plain text\0with a NUL' })

    expect(await open('a.log')).toMatchObject({ view: 'binary' })
  })

  it('can be shown as hex: offset, bytes and printable characters per 16-byte row', async () => {
    const { open } = await withFiles({ 'a.bin': Buffer.from('Hello, hex view!\0\x01\x7f') })

    const file = await open('a.bin', { hex: true })

    expect(file).toMatchObject({ view: 'hex', size: 19, contentLength: 19, shownLength: 19 })
    expect(file.view === 'hex' && file.content).toBe(
      [
        '00000000  48 65 6c 6c 6f 2c 20 68  65 78 20 76 69 65 77 21  |Hello, hex view!|',
        `00000010  ${'00 01 7f'.padEnd(48)}  |...|`
      ].join('\n')
    )
  })

  it('show only the start of a large file as hex', async () => {
    const { open } = await withFiles({ 'big.bin': Buffer.alloc(hexDumpLimit + 32) })

    const file = await open('big.bin', { hex: true })

    expect(file).toMatchObject({ view: 'hex', contentLength: hexDumpLimit + 32, shownLength: hexDumpLimit })
    expect(file.view === 'hex' && file.content.split('\n')).toHaveLength(hexDumpLimit / 16)
  })

  it('can be read as text in an encoding asked for', async () => {
    const { open } = await withFiles({ 'a.log': 'a\0b' })

    expect(await open('a.log', { encoding: 'utf-8' })).toMatchObject({ view: 'editor', content: 'a\0b', encoding: 'utf-8' })
  })
})

describe('compressed files', () => {
  const log = '2026-09-26 INFO started\n2026-09-26 WARN slow\n'

  it('are gunzipped before they’re shown, keeping the compressed size', async () => {
    const compressed = gzipSync(log)
    const { open } = await withFiles({ 'app.log.gz': compressed })

    expect(await open('app.log.gz')).toMatchObject({ view: 'editor', name: 'app.log.gz', content: log, compression: 'gzip', size: compressed.length })
  })

  it('are decompressed from zstd', async () => {
    const { open } = await withFiles({ 'app.log.zst': zstdCompressSync(Buffer.from(log)) })

    expect(await open('app.log.zst')).toMatchObject({ view: 'editor', content: log, compression: 'zstd' })
  })

  it('take their language from the name inside', async () => {
    const { open } = await withFiles({ 'data.json.gz': gzipSync('{"a": 1}'), 'app.log.gz': gzipSync(log) })

    expect(await open('data.json.gz')).toMatchObject({ language: 'json' })
    expect(await open('app.log.gz')).toMatchObject({ language: 'log' })
  })

  it('detect the encoding of what’s inside', async () => {
    const { open } = await withFiles({ 'a.txt.gz': gzipSync(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(text)])) })

    expect(await open('a.txt.gz')).toMatchObject({ content: text, encoding: 'utf-16le', compression: 'gzip' })
  })

  it('show binary content as binary, counting the decompressed bytes', async () => {
    const { open } = await withFiles({ 'a.bin.gz': gzipSync(Buffer.alloc(1000)) })

    expect(await open('a.bin.gz')).toMatchObject({ view: 'binary', contentLength: 1000, compression: 'gzip' })
  })

  it('that are corrupt are reported, not shown as garbage', async () => {
    const { open } = await withFiles({ 'broken.log.gz': 'not gzip at all', 'broken.log.zst': 'not zstd either' })

    await expect(open('broken.log.gz')).rejects.toMatchObject({ code: 'DECOMPRESSION_FAILED' })
    await expect(open('broken.log.zst')).rejects.toMatchObject({ code: 'DECOMPRESSION_FAILED' })
  })
})

describe('language detection', () => {
  it('goes by extension, ignoring case', async () => {
    const { open } = await withFiles({ 'a.ts': 'x', 'b.YAML': 'x', 'c.py': 'x', 'd.xyz123': 'x', noext: 'x' })

    expect(await open('a.ts')).toMatchObject({ language: 'typescript' })
    expect(await open('b.YAML')).toMatchObject({ language: 'yaml' })
    expect(await open('c.py')).toMatchObject({ language: 'python' })
    expect(await open('d.xyz123')).toMatchObject({ language: 'plaintext' })
    expect(await open('noext')).toMatchObject({ language: 'plaintext' })
  })

  it('knows files by their whole name', async () => {
    const { open } = await withFiles({ Dockerfile: 'x', '.gitconfig': 'x' })

    expect(await open('Dockerfile')).toMatchObject({ language: 'dockerfile' })
    expect(await open('.gitconfig')).toMatchObject({ language: 'ini' })
  })

  it('prefers the longest matching extension', async () => {
    const { open } = await withFiles({ 'page.html.liquid': 'x', 'types.d.ts': 'x' })

    expect(await open('page.html.liquid')).toMatchObject({ language: 'liquid' })
    expect(await open('types.d.ts')).toMatchObject({ language: 'typescript' })
  })

  it('sees through the number on a rotated file', async () => {
    const { open } = await withFiles({ 'app.log.1': 'x', 'app.log.2.gz': gzipSync('x'), 'app.json.10': 'x' })

    expect(await open('app.log.1')).toMatchObject({ language: 'log' })
    expect(await open('app.log.2.gz')).toMatchObject({ language: 'log' })
    expect(await open('app.json.10')).toMatchObject({ language: 'json' })
  })

  it('only names languages the editor can highlight', async () => {
    const definitions = join('node_modules', 'monaco-editor', 'esm', 'vs', 'languages')
    const known = new Set(['plaintext', 'log', 'json'])
    for (const name of await readdir(join(definitions, 'definitions'))) {
      const register = await readFile(join(definitions, 'definitions', name, 'register.js'), 'utf8').catch(() => '')
      for (const [, id] of register.matchAll(/\bid: "([^"]+)"/g)) known.add(id!)
    }
    const { languageIds } = await import('./languages')

    expect(languageIds.filter((id) => !known.has(id))).toEqual([])
  })
})
