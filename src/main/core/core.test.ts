import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from './core'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-core-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Local Filesystem Source', () => {
  it('is listed after being added', async () => {
    const core = createCore()

    const added = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })

    expect(await core.listSources()).toEqual([{ id: added.id, type: 'local', name: 'Logs', rootPath: dir }])
  })

  it('expands its root into folders first, then files, each sorted by name', async () => {
    await writeFile(join(dir, 'b.log'), '')
    await writeFile(join(dir, 'A.txt'), '')
    await mkdir(join(dir, 'zeta'))
    await mkdir(join(dir, 'alpha'))
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })

    expect(await core.expand(source.id, '')).toEqual([
      { kind: 'folder', name: 'alpha', path: 'alpha' },
      { kind: 'folder', name: 'zeta', path: 'zeta' },
      { kind: 'file', name: 'A.txt', path: 'A.txt' },
      { kind: 'file', name: 'b.log', path: 'b.log' }
    ])
  })

  it('expands a nested folder into children with Source-relative paths', async () => {
    await mkdir(join(dir, 'app', 'current'), { recursive: true })
    await writeFile(join(dir, 'app', 'current', 'server.log'), '')
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })

    expect(await core.expand(source.id, 'app/current')).toEqual([
      { kind: 'file', name: 'server.log', path: 'app/current/server.log' }
    ])
  })

  it('opens a file with its text content, size and modified time', async () => {
    const text = 'first line\nsecond line — ünïcode\n'
    await mkdir(join(dir, 'app'))
    await writeFile(join(dir, 'app', 'server.log'), text)
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })
    const before = Date.now()

    const file = await core.openFile(source.id, 'app/server.log')

    expect(file).toMatchObject({ path: 'app/server.log', name: 'server.log', content: text, size: 37 })
    expect(file.modifiedTime).toBeGreaterThan(before - 60_000)
    expect(file.modifiedTime).toBeLessThanOrEqual(Date.now())
  })
})

describe('browsing a Local Filesystem Source', () => {
  async function sourceWithSecretSibling() {
    const root = join(dir, 'root')
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app', 'server.log'), 'log')
    await writeFile(join(dir, 'secret.txt'), 'secret')
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: root })
    return { core, source }
  }

  it.each(['..', 'app/../..', '../secret.txt'])('refuses the path %s that leaves the root', async (path) => {
    const { core, source } = await sourceWithSecretSibling()

    await expect(core.expand(source.id, path)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SOURCE' })
    await expect(core.openFile(source.id, path)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SOURCE' })
  })

  it('browses entries whose names merely start with two dots', async () => {
    const { core, source } = await sourceWithSecretSibling()
    await mkdir(join(dir, 'root', '..data'))
    await writeFile(join(dir, 'root', '..data', 'x.log'), 'inside')

    expect(await core.expand(source.id, '..data')).toEqual([{ kind: 'file', name: 'x.log', path: '..data/x.log' }])
    expect((await core.openFile(source.id, '..data/x.log')).content).toBe('inside')
  })

  it('reports an unknown Source', async () => {
    const core = createCore()

    await expect(core.expand('nope', '')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(core.openFile('nope', 'a.txt')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })

  it('reports paths that do not exist', async () => {
    const { core, source } = await sourceWithSecretSibling()

    await expect(core.expand(source.id, 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(core.openFile(source.id, 'app/gone.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to expand a file or open a folder', async () => {
    const { core, source } = await sourceWithSecretSibling()

    await expect(core.expand(source.id, 'app/server.log')).rejects.toMatchObject({ code: 'NOT_A_FOLDER' })
    await expect(core.openFile(source.id, 'app')).rejects.toMatchObject({ code: 'NOT_A_FILE' })
  })
})

describe('adding a Local Filesystem Source', () => {
  it.each([
    ['a blank name', () => ({ name: '  ', rootPath: dir }), 'NAME_REQUIRED'],
    ['a root that does not exist', () => ({ name: 'Logs', rootPath: join(dir, 'missing') }), 'ROOT_NOT_FOUND'],
    ['a root that is a file', () => ({ name: 'Logs', rootPath: join(dir, 'file.txt') }), 'ROOT_NOT_A_FOLDER']
  ])('is rejected for %s', async (_, input, code) => {
    await writeFile(join(dir, 'file.txt'), '')
    const core = createCore()

    await expect(core.addSource({ type: 'local', ...input() })).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it('trims the name', async () => {
    const core = createCore()

    const source = await core.addSource({ type: 'local', name: '  Logs ', rootPath: dir })

    expect(source.name).toBe('Logs')
  })
})
