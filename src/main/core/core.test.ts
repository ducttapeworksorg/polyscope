import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntryNode, LocalSourceInfo, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import { createSecretStore, type SecretCipher } from './secret-store'

let dir: string

const localSource = (name: string, rootPath = dir) => ({ type: 'local' as const, name, rootPath })
const dataDir = () => join(dir, 'user-data')
const errorNode = (path: string, code: string) => ({ kind: 'error', path, code, message: expect.any(String) })
/** Nodes without their icon and metadata, for tests about what's listed rather than how it's shown. */
const entries = (nodes: TreeNode[]) =>
  nodes.map((node) => {
    if (node.kind !== 'folder' && node.kind !== 'file') return node
    const { icon: _, size: __, modifiedTime: ___, ...rest } = node
    return rest
  })

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

    expect(await core.listSources()).toEqual([{ id: added.id, type: 'local', name: 'Logs', rootPath: dir, showHidden: true }])
  })

  it('expands its root into folders first, then files, each sorted by name', async () => {
    await writeFile(join(dir, 'b.log'), '')
    await writeFile(join(dir, 'A.txt'), '')
    await mkdir(join(dir, 'zeta'))
    await mkdir(join(dir, 'alpha'))
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })

    expect(entries(await core.connect(source.id))).toEqual([
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
    await core.connect(source.id)

    expect(entries(await core.expand(source.id, 'app/current'))).toEqual([
      { kind: 'file', name: 'server.log', path: 'app/current/server.log' }
    ])
  })

  it('opens a file with its text content, encoding, size and modified time', async () => {
    const text = 'first line\nsecond line — ünïcode\n'
    await mkdir(join(dir, 'app'))
    await writeFile(join(dir, 'app', 'server.log'), text)
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })
    await core.connect(source.id)
    const before = Date.now()

    const file = await core.openFile(source.id, 'app/server.log')

    expect(file).toMatchObject({ path: 'app/server.log', name: 'server.log', view: 'editor', content: text, encoding: 'utf-8', language: 'log', size: 37 })
    expect(file.modifiedTime).toBeGreaterThan(before - 60_000)
    expect(file.modifiedTime).toBeLessThanOrEqual(Date.now())
  })

  it('reads a file afresh each time it is opened, so a reload shows what it holds now', async () => {
    await writeFile(join(dir, 'app.log'), 'one\n')
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })
    await core.connect(source.id)
    await core.openFile(source.id, 'app.log')

    await writeFile(join(dir, 'app.log'), 'one\ntwo\n')

    expect(await core.openFile(source.id, 'app.log')).toMatchObject({ content: 'one\ntwo\n', size: 8 })
  })
})

describe('tree metadata and icons', () => {
  const connected = async (rootPath = dir) => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs', rootPath))
    // A Local Filesystem Source's tree holds nothing but entries, error and more nodes.
    return { core, source, nodes: (await core.connect(source.id)) as EntryNode[] }
  }
  const recently = () => ({ before: Date.now() - 60_000 })
  // Times carry fractions of a millisecond, Date.now() doesn't: one taken in the same millisecond isn't in the future.
  const isRecent = (time: number | undefined, { before }: { before: number }) =>
    time !== undefined && time > before && Math.floor(time) <= Date.now()

  it('gives files their size and modified time', async () => {
    const since = recently()
    await writeFile(join(dir, 'app.log'), 'twelve bytes')

    const [file] = (await connected()).nodes

    expect(file).toMatchObject({ kind: 'file', name: 'app.log', size: 12 })
    expect(isRecent(file?.modifiedTime, since)).toBe(true)
  })

  it('gives folders the modified time their backend reports, but never a size', async () => {
    const since = recently()
    await mkdir(join(dir, 'app'))

    const [folder] = (await connected()).nodes

    expect(folder).not.toHaveProperty('size')
    expect(isRecent(folder?.modifiedTime, since)).toBe(true)
  })

  it('gives nested entries their metadata too', async () => {
    await mkdir(join(dir, 'app'))
    await writeFile(join(dir, 'app', 'server.log'), 'abc')
    const { core, source } = await connected()

    expect(await core.expand(source.id, 'app')).toEqual([
      { kind: 'file', name: 'server.log', path: 'app/server.log', icon: 'log', size: 3, modifiedTime: expect.any(Number) }
    ])
  })

  it('leaves out metadata it can’t read rather than make it up', async () => {
    await mkdir(join(dir, 'gone'))
    await symlink(join(dir, 'gone'), join(dir, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    await rm(join(dir, 'gone'), { recursive: true })

    const [dangling] = (await connected()).nodes

    expect(dangling).toEqual({ kind: 'file', name: 'dangling', path: 'dangling', icon: 'file' })
  })

  it('gives files the Material Icon Theme icon for their name or extension', async () => {
    for (const name of ['package.json', 'server.log', 'APP.LOG', 'types.d.ts', 'notes.md', 'Dockerfile', 'data.xyz123', 'noextension']) {
      await writeFile(join(dir, name), '')
    }

    const icons = Object.fromEntries((await connected()).nodes.map((n) => [n.name, n.icon]))

    expect(icons).toEqual({
      'package.json': 'nodejs',
      'server.log': 'log',
      'APP.LOG': 'log',
      'types.d.ts': 'typescript-def',
      'notes.md': 'markdown',
      Dockerfile: 'docker',
      'data.xyz123': 'file',
      noextension: 'file'
    })
  })

  it('gives folders the Material Icon Theme icon for their name', async () => {
    for (const name of ['src', 'Logs', '.git', 'somewhere']) await mkdir(join(dir, name))

    const icons = Object.fromEntries((await connected()).nodes.map((n) => [n.name, n.icon]))

    expect(icons).toEqual({ src: 'folder-src', Logs: 'folder-log', '.git': 'folder-git', somewhere: 'folder' })
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
    await core.connect(source.id)
    return { core, source }
  }

  it.each(['..', 'app/../..', '../secret.txt'])('refuses the path %s that leaves the root', async (path) => {
    const { core, source } = await sourceWithSecretSibling()

    expect(await core.expand(source.id, path)).toEqual([errorNode(path, 'PATH_OUTSIDE_SOURCE')])
    await expect(core.openFile(source.id, path)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SOURCE' })
  })

  it('browses entries whose names merely start with two dots', async () => {
    const { core, source } = await sourceWithSecretSibling()
    await mkdir(join(dir, 'root', '..data'))
    await writeFile(join(dir, 'root', '..data', 'x.log'), 'inside')

    expect(entries(await core.expand(source.id, '..data'))).toEqual([{ kind: 'file', name: 'x.log', path: '..data/x.log' }])
    expect(await core.openFile(source.id, '..data/x.log')).toMatchObject({ content: 'inside' })
  })

  it('reports an unknown Source', async () => {
    const core = createCore()

    await expect(core.expand('nope', '')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(core.openFile('nope', 'a.txt')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })

  it('reports paths that do not exist', async () => {
    const { core, source } = await sourceWithSecretSibling()

    expect(await core.expand(source.id, 'gone')).toEqual([errorNode('gone', 'NOT_FOUND')])
    await expect(core.openFile(source.id, 'app/gone.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('shows a failed expansion as an error node that can be retried, leaving the Source Connected', async () => {
    const { core, source } = await sourceWithSecretSibling()
    expect(await core.expand(source.id, 'later')).toEqual([errorNode('later', 'NOT_FOUND')])

    await mkdir(join(dir, 'root', 'later'))

    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
    expect(await core.expand(source.id, 'later')).toEqual([])
    expect(entries(await core.expand(source.id, ''))).toEqual([{ kind: 'folder', name: 'app', path: 'app' }, { kind: 'folder', name: 'later', path: 'later' }])
  })

  it('refuses to expand a file or open a folder', async () => {
    const { core, source } = await sourceWithSecretSibling()

    expect(await core.expand(source.id, 'app/server.log')).toEqual([errorNode('app/server.log', 'NOT_A_FOLDER')])
    await expect(core.openFile(source.id, 'app')).rejects.toMatchObject({ code: 'NOT_A_FILE' })
  })
})

describe('Local Filesystem Sources in real-world folders', () => {
  const windows = process.platform === 'win32'
  // Permission bits are neither enforced on Windows nor against root.
  const permissionsEnforced = !windows && process.getuid?.() !== 0
  const locked: string[] = []

  afterEach(async () => {
    // Put permissions back so the temp directory can be removed.
    await Promise.all(locked.splice(0).map((path) => chmod(path, 0o755)))
  })

  const lock = async (path: string) => {
    locked.push(path)
    await chmod(path, 0o000)
  }

  /** Links `path` to the folder `target`; Windows uses a junction, which needs no special privilege. */
  const linkFolder = (target: string, path: string) => symlink(target, path, windows ? 'junction' : 'dir')

  const connected = async (rootPath: string, options: { showHidden?: boolean } = {}) => {
    const core = createCore()
    const source = await core.addSource({ type: 'local', name: 'Logs', rootPath, ...options })
    return { core, source: source as LocalSourceInfo, nodes: (await core.connect(source.id)) as EntryNode[] }
  }

  const names = (nodes: TreeNode[]) => nodes.map((n) => ('name' in n ? n.name : n.kind))
  const loop = { code: 'SYMLINK_LOOP', message: expect.any(String) }

  describe('hidden files', () => {
    beforeEach(async () => {
      await writeFile(join(dir, '.env'), '')
      await mkdir(join(dir, '.git'))
      await writeFile(join(dir, 'app.log'), '')
    })

    it('are listed by default', async () => {
      const { source, nodes } = await connected(dir)

      expect(source.showHidden).toBe(true)
      expect(names(nodes)).toEqual(['.git', '.env', 'app.log'])
    })

    it('are left out, dotfiles and dot-folders alike, when show hidden is off', async () => {
      const { source, nodes } = await connected(dir, { showHidden: false })

      expect(source.showHidden).toBe(false)
      expect(names(nodes)).toEqual(['app.log'])
    })

    it.runIf(windows)('include files and folders with the Windows hidden attribute', async () => {
      await writeFile(join(dir, 'thumbs.db'), '')
      await mkdir(join(dir, 'cache'))
      await promisify(execFile)('attrib', ['+h', join(dir, 'thumbs.db')])
      await promisify(execFile)('attrib', ['+h', join(dir, 'cache')])

      expect(names((await connected(dir)).nodes)).toEqual(['.git', 'cache', '.env', 'app.log', 'thumbs.db'])
      expect(names((await connected(dir, { showHidden: false })).nodes)).toEqual(['app.log'])
    })

    it.runIf(windows)('are found by attribute in folders whose names cmd would otherwise misread', async () => {
      const root = join(dir, '%PATH% & co')
      await mkdir(root)
      await writeFile(join(root, 'hidden.log'), '')
      await writeFile(join(root, 'shown.log'), '')
      await promisify(execFile)('attrib', ['+h', join(root, 'hidden.log')])

      expect(names((await connected(root, { showHidden: false })).nodes)).toEqual(['shown.log'])
    })

    it('are listed again once show hidden is turned back on', async () => {
      const { core, source } = await connected(dir, { showHidden: false })

      await core.editSource(source.id, { type: 'local', name: 'Logs', rootPath: dir, showHidden: true })

      expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
      expect(names(await core.connect(source.id))).toEqual(['.git', '.env', 'app.log'])
    })

    it('are shown for Sources saved before show hidden existed', async () => {
      await mkdir(dataDir())
      const saved = { version: 1, sources: [{ id: 'old', type: 'local', name: 'Old', rootPath: dir }], groupOrder: ['local'] }
      await writeFile(join(dataDir(), 'sources.json'), JSON.stringify(saved))
      const core = createCore({ dataDir: dataDir() })

      expect(await core.listSources()).toEqual([{ id: 'old', type: 'local', name: 'Old', rootPath: dir, showHidden: true }])
      expect(names(await core.connect('old'))).toContain('.env')
    })
  })

  describe('symlinks', () => {
    it('are followed into linked folders', async () => {
      const root = join(dir, 'root')
      await mkdir(root)
      await mkdir(join(dir, 'elsewhere'))
      await writeFile(join(dir, 'elsewhere', 'app.log'), 'linked')
      await linkFolder(join(dir, 'elsewhere'), join(root, 'linked'))

      const { core, source, nodes } = await connected(root)

      expect(entries(nodes)).toEqual([{ kind: 'folder', name: 'linked', path: 'linked' }])
      expect(entries(await core.expand(source.id, 'linked'))).toEqual([{ kind: 'file', name: 'app.log', path: 'linked/app.log' }])
      expect(await core.openFile(source.id, 'linked/app.log')).toMatchObject({ content: 'linked' })
    })

    it('are followed to linked files', async (ctx) => {
      const root = join(dir, 'root')
      await mkdir(root)
      await writeFile(join(dir, 'target.log'), 'linked')
      // Windows only lets privileged users (or Developer Mode) create file symlinks.
      const linked = await symlink(join(dir, 'target.log'), join(root, 'app.log'), 'file').then(
        () => true,
        () => false
      )
      if (!linked) return ctx.skip()

      const { core, source, nodes } = await connected(root)

      expect(entries(nodes)).toEqual([{ kind: 'file', name: 'app.log', path: 'app.log' }])
      expect(await core.openFile(source.id, 'app.log')).toMatchObject({ content: 'linked' })
    })

    it('that lead back to a folder containing them are shown as loops', async () => {
      await mkdir(join(dir, 'app'))
      await linkFolder(dir, join(dir, 'app', 'up'))
      await linkFolder(join(dir, 'app'), join(dir, 'app', 'self'))
      const { core, source } = await connected(dir)

      expect(entries(await core.expand(source.id, 'app'))).toEqual([
        { kind: 'folder', name: 'self', path: 'app/self', problem: loop },
        { kind: 'folder', name: 'up', path: 'app/up', problem: loop }
      ])
    })

    it('that loop back through another link are shown as loops', async () => {
      const root = join(dir, 'root')
      await mkdir(root)
      await mkdir(join(dir, 'elsewhere'))
      await linkFolder(join(dir, 'elsewhere'), join(root, 'out'))
      await linkFolder(root, join(dir, 'elsewhere', 'back'))
      const { core, source, nodes } = await connected(root)

      expect(entries(nodes)).toEqual([{ kind: 'folder', name: 'out', path: 'out' }])
      expect(entries(await core.expand(source.id, 'out'))).toEqual([{ kind: 'folder', name: 'back', path: 'out/back', problem: loop }])
    })

    it('to a sibling folder are not mistaken for loops', async () => {
      await mkdir(join(dir, 'a'))
      await mkdir(join(dir, 'b'))
      await linkFolder(join(dir, 'b'), join(dir, 'a', 'to-b'))
      const { core, source } = await connected(dir)

      expect(entries(await core.expand(source.id, 'a'))).toEqual([{ kind: 'folder', name: 'to-b', path: 'a/to-b' }])
    })

    it.skipIf(windows)('that only point at each other are shown as loops', async () => {
      await symlink('b', join(dir, 'a'))
      await symlink('a', join(dir, 'b'))

      expect(entries((await connected(dir)).nodes)).toEqual([
        { kind: 'file', name: 'a', path: 'a', problem: loop },
        { kind: 'file', name: 'b', path: 'b', problem: loop }
      ])
    })

    it('whose target is missing are still listed', async () => {
      await mkdir(join(dir, 'gone'))
      await linkFolder(join(dir, 'gone'), join(dir, 'dangling'))
      await rm(join(dir, 'gone'), { recursive: true })
      const { core, source, nodes } = await connected(dir)

      expect(entries(nodes)).toEqual([{ kind: 'file', name: 'dangling', path: 'dangling' }])
      await expect(core.openFile(source.id, 'dangling')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe.runIf(permissionsEnforced)('unreadable entries', () => {
    const denied = { code: 'PERMISSION_DENIED', message: expect.any(String) }

    it('are listed with a permission error, alongside readable ones', async () => {
      await mkdir(join(dir, 'private'))
      await writeFile(join(dir, 'secret.log'), 'secret')
      await writeFile(join(dir, 'app.log'), 'app')
      await lock(join(dir, 'private'))
      await lock(join(dir, 'secret.log'))

      expect(entries((await connected(dir)).nodes)).toEqual([
        { kind: 'folder', name: 'private', path: 'private', problem: denied },
        { kind: 'file', name: 'app.log', path: 'app.log' },
        { kind: 'file', name: 'secret.log', path: 'secret.log', problem: denied }
      ])
    })

    it('can’t be expanded or opened, leaving the Source Connected', async () => {
      await mkdir(join(dir, 'private'))
      await writeFile(join(dir, 'secret.log'), 'secret')
      const { core, source } = await connected(dir)
      await lock(join(dir, 'private'))
      await lock(join(dir, 'secret.log'))

      expect(await core.expand(source.id, 'private')).toEqual([errorNode('private', 'PERMISSION_DENIED')])
      await expect(core.openFile(source.id, 'secret.log')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
    })
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

  it('trims the name and root path', async () => {
    const core = createCore()

    const source = await core.addSource({ type: 'local', name: '  Logs ', rootPath: ` ${dir}  ` })

    expect(source).toMatchObject({ name: 'Logs', rootPath: dir })
  })
})

describe('the Source registry', () => {

  it('edits a Source’s settings, keeping its id and place', async () => {
    const other = join(dir, 'other')
    await mkdir(other)
    const core = createCore()
    const first = await core.addSource(localSource('First'))
    const second = await core.addSource(localSource('Second'))

    const edited = await core.editSource(first.id, localSource(' Renamed ', other))

    expect(edited).toEqual({ id: first.id, type: 'local', name: 'Renamed', rootPath: other, showHidden: true })
    expect(await core.listSources()).toEqual([edited, second])
  })

  it('validates edits like new Sources and leaves the Source unchanged when they fail', async () => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))

    await expect(core.editSource(source.id, localSource(''))).rejects.toMatchObject({ code: 'NAME_REQUIRED' })
    await expect(core.editSource(source.id, localSource('Logs', join(dir, 'missing')))).rejects.toMatchObject({
      code: 'ROOT_NOT_FOUND'
    })
    await expect(core.editSource('nope', localSource('Logs'))).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    expect(await core.listSources()).toEqual([source])
  })

  it('browses the new root after an edit', async () => {
    const other = join(dir, 'other')
    await mkdir(other)
    await writeFile(join(other, 'moved.log'), '')
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))
    await core.connect(source.id)

    await core.editSource(source.id, localSource('Logs', other))

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
    expect(entries(await core.connect(source.id))).toEqual([{ kind: 'file', name: 'moved.log', path: 'moved.log' }])
  })

  it('duplicates a Source under a distinct name, right after the original', async () => {
    const core = createCore()
    const logs = await core.addSource(localSource('Logs'))
    const other = await core.addSource(localSource('Other'))

    const copy = await core.duplicateSource(logs.id)

    expect(copy).toEqual({ id: expect.any(String), type: 'local', name: 'Logs copy', rootPath: dir, showHidden: true })
    expect(copy.id).not.toBe(logs.id)
    expect(await core.listSources()).toEqual([logs, copy, other])
  })

  it('numbers further duplicates until the name is free', async () => {
    const core = createCore()
    const logs = await core.addSource(localSource('Logs'))
    await core.addSource(localSource('Logs copy 2'))

    const names = []
    for (let i = 0; i < 3; i++) names.push((await core.duplicateSource(logs.id)).name)

    expect(names).toEqual(['Logs copy', 'Logs copy 3', 'Logs copy 4'])
  })

  it('browses a duplicate independently of the original', async () => {
    await writeFile(join(dir, 'a.log'), '')
    const core = createCore()
    const logs = await core.addSource(localSource('Logs'))

    const copy = await core.duplicateSource(logs.id)

    expect(entries(await core.connect(copy.id))).toEqual([{ kind: 'file', name: 'a.log', path: 'a.log' }])
    await expect(core.duplicateSource('nope')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })

  it('deletes a Source so it can no longer be listed or browsed', async () => {
    const core = createCore()
    const logs = await core.addSource(localSource('Logs'))
    const other = await core.addSource(localSource('Other'))

    await core.deleteSource(logs.id)

    expect(await core.listSources()).toEqual([other])
    await expect(core.expand(logs.id, '')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(core.deleteSource(logs.id)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })

  it('moves a Source to a new position within its group', async () => {
    const core = createCore()
    const [a, b, c] = [
      await core.addSource(localSource('A')),
      await core.addSource(localSource('B')),
      await core.addSource(localSource('C'))
    ]

    await core.moveSource(c.id, 0)
    expect(await core.listSources()).toEqual([c, a, b])

    await core.moveSource(c.id, 2)
    expect(await core.listSources()).toEqual([a, b, c])
  })

  it.each([-1, 2, 0.5])('refuses to move a Source to position %s', async (index) => {
    const core = createCore()
    const a = await core.addSource(localSource('A'))
    const b = await core.addSource(localSource('B'))

    await expect(core.moveSource(a.id, index)).rejects.toMatchObject({ code: 'INVALID_ORDER' })
    expect(await core.listSources()).toEqual([a, b])
  })

  it('moves a Source Type group among the groups that have Sources', async () => {
    const core = createCore()
    const a = await core.addSource(localSource('A'))

    await core.moveSourceGroup('local', 0)

    expect(await core.listSources()).toEqual([a])
    await expect(core.moveSourceGroup('local', 1)).rejects.toMatchObject({ code: 'INVALID_ORDER' })
  })
})

describe('Source registry persistence', () => {

  it('starts empty when nothing has been saved yet', async () => {
    const core = createCore({ dataDir: dataDir() })

    expect(await core.listSources()).toEqual([])
  })

  it('restores Sources, their settings and their order in a later launch', async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    await writeFile(join(root, 'a.log'), '')
    const before = createCore({ dataDir: dataDir() })
    const a = await before.addSource(localSource('A', root))
    const b = await before.addSource(localSource('B'))
    const gone = await before.duplicateSource(a.id)
    await before.editSource(b.id, localSource('Renamed'))
    await before.moveSource(b.id, 0)
    await before.moveSourceGroup('local', 0)
    await before.deleteSource(gone.id)
    const saved = await before.listSources()

    const after = createCore({ dataDir: dataDir() })

    expect(saved.map((s) => s.name)).toEqual(['Renamed', 'A'])
    expect(await after.listSources()).toEqual(saved)
    expect(entries(await after.connect(a.id))).toEqual([{ kind: 'file', name: 'a.log', path: 'a.log' }])
  })

  it('restores a Source whose root has since disappeared', async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    const before = createCore({ dataDir: dataDir() })
    const source = await before.addSource(localSource('Logs', root))
    await rm(root, { recursive: true })

    const after = createCore({ dataDir: dataDir() })

    expect(await after.listSources()).toEqual([source])
    await expect(after.connect(source.id)).rejects.toMatchObject({ code: 'ROOT_NOT_FOUND' })
  })

  it('sets an unreadable registry aside and starts afresh', async () => {
    await mkdir(dataDir())
    await writeFile(join(dataDir(), 'sources.json'), '{ not json')

    const core = createCore({ dataDir: dataDir() })

    expect(await core.listSources()).toEqual([])
    const source = await core.addSource(localSource('Logs'))
    expect(await createCore({ dataDir: dataDir() }).listSources()).toEqual([source])
    const setAside = (await readdir(dataDir())).filter((f) => f.startsWith('sources.json.unreadable-'))
    expect(await Promise.all(setAside.map((f) => readFile(join(dataDir(), f), 'utf8')))).toEqual(['{ not json'])
  })

  it('keeps Sources of Source Types it doesn’t know when saving', async () => {
    const future = { id: 'f1', type: 'from-a-later-version', name: 'Future', endpoint: 'x' }
    await mkdir(dataDir())
    await writeFile(join(dataDir(), 'sources.json'), JSON.stringify({ sources: [future], groupOrder: [] }))
    const core = createCore({ dataDir: dataDir() })

    await core.addSource(localSource('Logs'))

    expect((await core.listSources()).map((s) => s.name)).toEqual(['Logs'])
    const saved = JSON.parse(await readFile(join(dataDir(), 'sources.json'), 'utf8'))
    expect(saved.sources).toContainEqual(future)
  })

  it('leaves the registry unchanged when a change can’t be saved', async () => {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file where the data directory should be')
    const core = createCore({ dataDir: blocked })

    await expect(core.addSource(localSource('Logs'))).rejects.toThrow()

    expect(await core.listSources()).toEqual([])
  })

  it('keeps registries in different data directories apart', async () => {
    await createCore({ dataDir: dataDir() }).addSource(localSource('Logs'))

    expect(await createCore({ dataDir: join(dir, 'elsewhere') }).listSources()).toEqual([])
    expect(await createCore().listSources()).toEqual([])
  })
})

describe('secrets stored for a Source', () => {
  // Stands in for the OS keychain: reversible, but never the plain text.
  const reversed: SecretCipher = {
    encrypt: (plain) => Buffer.from([...plain].reverse().join('')),
    decrypt: (encrypted) => [...encrypted.toString()].reverse().join('')
  }

  it('are removed when the Source is deleted', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets })
    const source = await core.addSource(localSource('Bucket'))
    const kept = await core.addSource(localSource('Other'))
    await secrets.set(source.id, 'secretKey', 's3cr3t')
    await secrets.set(kept.id, 'secretKey', 'k3pt')

    await core.deleteSource(source.id)

    const later = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    expect(await later.get(source.id, 'secretKey')).toBeUndefined()
    expect(await later.get(kept.id, 'secretKey')).toBe('k3pt')
  })

  it('are copied to a duplicate', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets })
    const source = await core.addSource(localSource('Bucket'))
    await secrets.set(source.id, 'secretKey', 's3cr3t')

    const copy = await core.duplicateSource(source.id)

    expect(await createSecretStore({ dataDir: dataDir(), cipher: reversed }).get(copy.id, 'secretKey')).toBe('s3cr3t')
  })

  it('are never saved as plain text', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    await secrets.set('source-id', 'secretKey', 's3cr3t')

    const files = await readdir(dataDir())
    const saved = await Promise.all(files.map((f) => readFile(join(dataDir(), f), 'utf8')))
    expect(saved.join('')).not.toContain('s3cr3t')
  })
})

describe('connecting a Source', () => {
  it('starts Disconnected and becomes Connected, returning its root', async () => {
    await writeFile(join(dir, 'a.log'), '')
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
    expect(entries(await core.connect(source.id))).toEqual([{ kind: 'file', name: 'a.log', path: 'a.log' }])
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('goes into Error with the reason when its root can’t be reached, and retries on the next connect', async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    const core = createCore()
    const source = await core.addSource(localSource('Logs', root))
    await rm(root, { recursive: true })

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'ROOT_NOT_FOUND' })
    expect(await core.connectionState(source.id)).toEqual({
      state: 'error',
      code: 'ROOT_NOT_FOUND',
      message: expect.stringContaining(root)
    })
    await expect(core.expand(source.id, '')).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })

    await mkdir(root)
    expect(await core.connect(source.id)).toEqual([])
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('stops browsing once Disconnected, until connected again', async () => {
    await writeFile(join(dir, 'a.log'), 'text')
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))
    await core.connect(source.id)

    await core.disconnect(source.id)

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
    await expect(core.expand(source.id, '')).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
    await expect(core.openFile(source.id, 'a.log')).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
    await core.connect(source.id)
    expect(await core.openFile(source.id, 'a.log')).toMatchObject({ content: 'text' })
  })

  it('clears an Error on disconnect', async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    const core = createCore()
    const source = await core.addSource(localSource('Logs', root))
    await rm(root, { recursive: true })
    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'ROOT_NOT_FOUND' })

    await core.disconnect(source.id)

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })

  it('stays Disconnected when disconnected while still connecting', async () => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))

    const connecting = core.connect(source.id)
    expect(await core.connectionState(source.id)).toEqual({ state: 'connecting' })
    await core.disconnect(source.id)

    await expect(connecting).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })

  it('keeps only a name change from disconnecting a Source', async () => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))
    await core.connect(source.id)

    await core.editSource(source.id, localSource('Renamed'))

    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('reports connection state and connects only for known Sources', async () => {
    const core = createCore()

    await expect(core.connectionState('nope')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(core.connect('nope')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(core.disconnect('nope')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })

  it('starts every Source Disconnected in a later launch', async () => {
    const before = createCore({ dataDir: dataDir() })
    const source = await before.addSource(localSource('Logs'))
    await before.connect(source.id)

    const after = createCore({ dataDir: dataDir() })

    expect(await after.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})

describe('testing a connection', () => {
  it('succeeds for settings that can be reached, without adding a Source', async () => {
    const core = createCore()

    await expect(core.testConnection(localSource('', ` ${dir} `))).resolves.toBeUndefined()

    expect(await core.listSources()).toEqual([])
  })

  it.each([
    ['a root that does not exist', () => join(dir, 'missing'), 'ROOT_NOT_FOUND'],
    ['a root that is a file', () => join(dir, 'file.txt'), 'ROOT_NOT_A_FOLDER']
  ])('reports the error for %s', async (_, rootPath, code) => {
    await writeFile(join(dir, 'file.txt'), '')
    const core = createCore()

    await expect(core.testConnection(localSource('Logs', rootPath()))).rejects.toMatchObject({ code })
  })
})

describe('Environments', () => {
  const seeded = [
    { id: expect.any(String), name: 'prod', color: expect.stringMatching(/^#[0-9a-f]{6}$/), protected: true },
    { id: expect.any(String), name: 'staging', color: expect.stringMatching(/^#[0-9a-f]{6}$/), protected: false },
    { id: expect.any(String), name: 'qa', color: expect.stringMatching(/^#[0-9a-f]{6}$/), protected: false },
    { id: expect.any(String), name: 'dev', color: expect.stringMatching(/^#[0-9a-f]{6}$/), protected: false }
  ]
  const environmentsFile = () => join(dataDir(), 'environments.json')
  const named = async (core: ReturnType<typeof createCore>, name: string) =>
    (await core.listEnvironments()).find((e) => e.name === name)!

  it('start as prod (Protected), staging, qa and dev, each with a colour of its own', async () => {
    const environments = await createCore({ dataDir: dataDir() }).listEnvironments()

    expect(environments).toEqual(seeded)
    expect(new Set(environments.map((e) => e.color)).size).toBe(4)
    expect(await createCore().listEnvironments()).toEqual(seeded)
  })

  it('are created with a trimmed name, a colour and the Protected flag, after the others', async () => {
    const core = createCore()

    const uat = await core.addEnvironment({ name: ' uat ', color: '#8E4EC6', protected: true })
    const perf = await core.addEnvironment({ name: 'perf', color: '#0090ff' })

    expect(uat).toEqual({ id: expect.any(String), name: 'uat', color: '#8e4ec6', protected: true })
    expect(perf).toMatchObject({ name: 'perf', protected: false })
    expect(await core.listEnvironments()).toEqual([...seeded, uat, perf])
  })

  it('are renamed, recoloured and have Protected toggled, keeping their id and place', async () => {
    const core = createCore()
    const qa = await named(core, 'qa')

    const edited = await core.editEnvironment(qa.id, { name: 'test', color: '#123abc', protected: true })

    expect(edited).toEqual({ id: qa.id, name: 'test', color: '#123abc', protected: true })
    expect((await core.listEnvironments()).map((e) => e.name)).toEqual(['prod', 'staging', 'test', 'dev'])
  })

  it.each([
    ['a blank name', { name: '  ', color: '#ff0000' }, 'ENVIRONMENT_NAME_REQUIRED'],
    ['a name already taken, whatever its case', { name: 'PROD', color: '#ff0000' }, 'ENVIRONMENT_NAME_TAKEN'],
    ['a colour that is not #rrggbb', { name: 'uat', color: 'red' }, 'INVALID_COLOR'],
    ['a Protected flag that is not true or false', { name: 'uat', color: '#ff0000', protected: 'yes' as never }, 'INVALID_ENVIRONMENT']
  ])('refuse %s, changing nothing', async (_, input, code) => {
    const core = createCore()
    const dev = await named(core, 'dev')

    await expect(core.addEnvironment(input)).rejects.toMatchObject({ code })
    await expect(core.editEnvironment(dev.id, input)).rejects.toMatchObject({ code })
    expect(await core.listEnvironments()).toEqual(seeded)
  })

  it('may keep their own name when edited', async () => {
    const core = createCore()
    const prod = await named(core, 'prod')

    expect(await core.editEnvironment(prod.id, { name: 'Prod', color: prod.color, protected: false })).toMatchObject({ name: 'Prod' })
  })

  it('report an unknown Environment', async () => {
    const core = createCore()

    await expect(core.editEnvironment('nope', { name: 'x', color: '#ff0000' })).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
    await expect(core.deleteEnvironment('nope')).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
  })

  it('label Sources, optionally, when added, edited or duplicated', async () => {
    const core = createCore()
    const prod = await named(core, 'prod')
    const dev = await named(core, 'dev')

    const labelled = await core.addSource({ ...localSource('Prod logs'), environmentId: prod.id })
    const plain = await core.addSource(localSource('Scratch'))
    const relabelled = await core.editSource(plain.id, { ...localSource('Scratch'), environmentId: dev.id })
    const copy = await core.duplicateSource(labelled.id)
    const unlabelled = await core.editSource(labelled.id, localSource('Prod logs'))

    expect(plain).not.toHaveProperty('environmentId')
    expect(relabelled.environmentId).toBe(dev.id)
    expect(copy.environmentId).toBe(prod.id)
    expect(unlabelled).not.toHaveProperty('environmentId')
    expect((await core.listSources()).map((s) => s.environmentId)).toEqual([undefined, prod.id, dev.id])
  })

  it('must exist to label a Source', async () => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))

    await expect(core.addSource({ ...localSource('Other'), environmentId: 'nope' })).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
    await expect(core.editSource(source.id, { ...localSource('Logs'), environmentId: 'nope' })).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
    expect(await core.listSources()).toEqual([source])
  })

  it('can be changed on a Source without disconnecting it', async () => {
    const core = createCore()
    const source = await core.addSource(localSource('Logs'))
    await core.connect(source.id)

    await core.editSource(source.id, { ...localSource('Logs'), environmentId: (await named(core, 'prod')).id })

    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('leave the Sources using them unlabelled when deleted', async () => {
    const core = createCore({ dataDir: dataDir() })
    const staging = await named(core, 'staging')
    const dev = await named(core, 'dev')
    const a = await core.addSource({ ...localSource('A'), environmentId: staging.id })
    const b = await core.addSource({ ...localSource('B'), environmentId: dev.id })

    await core.deleteEnvironment(staging.id)

    expect((await core.listEnvironments()).map((e) => e.name)).toEqual(['prod', 'qa', 'dev'])
    for (const listed of [await core.listSources(), await createCore({ dataDir: dataDir() }).listSources()]) {
      expect(listed.find((s) => s.id === a.id)).not.toHaveProperty('environmentId')
      expect(listed.find((s) => s.id === b.id)?.environmentId).toBe(dev.id)
    }
  })

  it('are restored in a later launch, including deletions, without seeding the defaults again', async () => {
    const before = createCore({ dataDir: dataDir() })
    const uat = await before.addEnvironment({ name: 'uat', color: '#8e4ec6' })
    await before.editEnvironment((await named(before, 'prod')).id, { name: 'production', color: '#aa0000', protected: true })
    for (const name of ['staging', 'qa', 'dev']) await before.deleteEnvironment((await named(before, name)).id)
    const source = await before.addSource({ ...localSource('Logs'), environmentId: uat.id })
    const saved = await before.listEnvironments()

    const after = createCore({ dataDir: dataDir() })

    expect(saved.map((e) => e.name)).toEqual(['production', 'uat'])
    expect(await after.listEnvironments()).toEqual(saved)
    expect(await after.listSources()).toEqual([source])
  })

  it('stay empty in a later launch once all are deleted', async () => {
    const before = createCore({ dataDir: dataDir() })
    for (const { id } of await before.listEnvironments()) await before.deleteEnvironment(id)

    expect(await createCore({ dataDir: dataDir() }).listEnvironments()).toEqual([])
  })

  it('set an unreadable file aside, start from the defaults, and unlabel Sources whose Environment is gone', async () => {
    const before = createCore({ dataDir: dataDir() })
    const uat = await before.addEnvironment({ name: 'uat', color: '#8e4ec6' })
    const labelled = await before.addSource({ ...localSource('Logs'), environmentId: uat.id })
    const { environmentId: _, ...source } = labelled
    const saved = await readFile(environmentsFile(), 'utf8')
    await writeFile(environmentsFile(), '{ not json')

    const after = createCore({ dataDir: dataDir() })

    expect(await after.listEnvironments()).toEqual(seeded)
    expect(await after.listSources()).toEqual([source])
    expect((await readdir(dataDir())).filter((f) => f.startsWith('environments.json.unreadable-'))).toHaveLength(1)

    // The label itself is kept, so putting the Environments back (say, from the set-aside file) restores it.
    await after.addSource(localSource('Other'))
    await writeFile(environmentsFile(), saved)
    expect((await createCore({ dataDir: dataDir() }).listSources())[0]).toEqual(labelled)
  })

  it('are left unchanged when a change can’t be saved', async () => {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file where the data directory should be')
    const core = createCore({ dataDir: blocked })
    const prod = await named(core, 'prod')

    await expect(core.addEnvironment({ name: 'uat', color: '#8e4ec6' })).rejects.toThrow()
    await expect(core.editEnvironment(prod.id, { name: 'x', color: '#000000' })).rejects.toThrow()
    await expect(core.deleteEnvironment(prod.id)).rejects.toThrow()

    expect(await core.listEnvironments()).toEqual(seeded)
  })

  it('hand out copies that can’t change the core’s Environments', async () => {
    const core = createCore()

    const [prod] = await core.listEnvironments()
    prod!.name = 'changed'

    expect((await core.listEnvironments())[0]?.name).toBe('prod')
  })
})

describe('settings', () => {
  const MB = 1024 * 1024
  const defaults = {
    largeFileThreshold: 50 * MB,
    openAnywayLimit: 200 * MB,
    cacheSizeCap: 2048 * MB,
    defaultLastNLines: 10_000,
    theme: 'dark',
    showTreeDetails: true,
    showMinimap: true
  }
  const settingsFile = () => join(dataDir(), 'settings.json')

  it('start with the defaults', async () => {
    expect(await createCore().getSettings()).toEqual(defaults)
    expect(await createCore({ dataDir: dataDir() }).getSettings()).toEqual(defaults)
  })

  it('change only what is given, returning the new settings', async () => {
    const core = createCore()

    const changed = await core.updateSettings({ theme: 'light', defaultLastNLines: 50_000 })

    expect(changed).toEqual({ ...defaults, theme: 'light', defaultLastNLines: 50_000 })
    expect(await core.getSettings()).toEqual(changed)
  })

  it.each([
    ['a zero threshold', { largeFileThreshold: 0 }, 'largeFileThreshold'],
    ['a fractional line count', { defaultLastNLines: 10.5 }, 'defaultLastNLines'],
    ['a negative cache size', { cacheSizeCap: -1 }, 'cacheSizeCap'],
    ['a line count that is not a number', { defaultLastNLines: '10' as unknown as number }, 'defaultLastNLines'],
    ['an unknown theme', { theme: 'sepia' as 'dark' }, 'theme'],
    ['tree details shown as neither true nor false', { showTreeDetails: 'no' as unknown as boolean }, 'showTreeDetails'],
    ['a minimap shown as neither true nor false', { showMinimap: 'no' as unknown as boolean }, 'showMinimap'],
    ['an "open anyway" limit below the threshold', { openAnywayLimit: 40 * MB }, 'openAnywayLimit'],
    ['a threshold above the "open anyway" limit', { largeFileThreshold: 300 * MB }, 'openAnywayLimit'],
    ['a cache too small for the "open anyway" limit', { cacheSizeCap: 100 * MB }, 'cacheSizeCap']
  ])('refuse %s, naming the setting and changing nothing', async (_, change, setting) => {
    const core = createCore()

    const failure = core.updateSettings(change)

    await expect(failure).rejects.toMatchObject({ code: 'INVALID_SETTINGS' })
    await expect(failure).rejects.toThrow(setting)
    expect(await core.getSettings()).toEqual(defaults)
  })

  it('accept limits that are all raised together', async () => {
    const core = createCore()
    const raised = { largeFileThreshold: 300 * MB, openAnywayLimit: 1024 * MB, cacheSizeCap: 4096 * MB }

    expect(await core.updateSettings(raised)).toEqual({ ...defaults, ...raised })
  })

  it('ignore keys that are not settings', async () => {
    const core = createCore()

    await core.updateSettings({ theme: 'light', bogus: 1 } as Partial<typeof defaults> as never)

    expect(await core.getSettings()).toEqual({ ...defaults, theme: 'light' })
  })

  it('are restored in a later launch', async () => {
    const changes = { theme: 'light' as const, largeFileThreshold: 20 * MB, showTreeDetails: false, showMinimap: false }
    await createCore({ dataDir: dataDir() }).updateSettings(changes)

    expect(await createCore({ dataDir: dataDir() }).getSettings()).toEqual({ ...defaults, ...changes })
  })

  it('fall back to the default for each saved value that is invalid, keeping the rest', async () => {
    await mkdir(dataDir())
    const saved = { theme: 'sepia', defaultLastNLines: 500, cacheSizeCap: 'lots', openAnywayLimit: 10 * MB, showTreeDetails: 1, showMinimap: 'yes' }
    await writeFile(settingsFile(), JSON.stringify(saved))

    expect(await createCore({ dataDir: dataDir() }).getSettings()).toEqual({ ...defaults, defaultLastNLines: 500 })
  })

  it('keep the other saved values when the saved limits conflict with the defaults', async () => {
    await mkdir(dataDir())
    await writeFile(settingsFile(), JSON.stringify({ theme: 'light', defaultLastNLines: 500, largeFileThreshold: 300 * MB }))

    expect(await createCore({ dataDir: dataDir() }).getSettings()).toEqual({ ...defaults, theme: 'light', defaultLastNLines: 500 })
  })

  it('start from the defaults when the settings file can’t be read at all', async () => {
    await mkdir(settingsFile(), { recursive: true })
    const core = createCore({ dataDir: dataDir() })

    expect(await core.getSettings()).toEqual(defaults)
    expect(await core.listSources()).toEqual([])
  })

  it.each([null, 'light', 42])('refuse a change that isn’t an object of settings (%s)', async (change) => {
    await expect(createCore().updateSettings(change as never)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' })
  })

  it('set an unreadable settings file aside and start from the defaults', async () => {
    await mkdir(dataDir())
    await writeFile(settingsFile(), '{ not json')

    expect(await createCore({ dataDir: dataDir() }).getSettings()).toEqual(defaults)
    const setAside = (await readdir(dataDir())).filter((f) => f.startsWith('settings.json.unreadable-'))
    expect(setAside).toHaveLength(1)
  })

  it('keep settings it doesn’t know when saving', async () => {
    await mkdir(dataDir())
    await writeFile(settingsFile(), JSON.stringify({ fromALaterVersion: { x: 1 } }))

    await createCore({ dataDir: dataDir() }).updateSettings({ theme: 'light' })

    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toMatchObject({ theme: 'light', fromALaterVersion: { x: 1 } })
  })

  it('are left unchanged, and nobody told, when a change can’t be saved', async () => {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file where the data directory should be')
    const core = createCore({ dataDir: blocked })
    const heard: unknown[] = []
    core.onSettingsChanged((settings) => heard.push(settings))

    await expect(core.updateSettings({ theme: 'light' })).rejects.toThrow()

    expect(await core.getSettings()).toEqual(defaults)
    expect(heard).toEqual([])
  })

  it('tell every listener about each change until it unsubscribes', async () => {
    const core = createCore()
    const first: unknown[] = []
    const second: unknown[] = []
    const unsubscribe = core.onSettingsChanged((settings) => first.push(settings))
    core.onSettingsChanged((settings) => second.push(settings))

    const light = await core.updateSettings({ theme: 'light' })
    const fewerLines = await core.updateSettings({ defaultLastNLines: 1 })
    unsubscribe()
    const dark = await core.updateSettings({ theme: 'dark' })

    expect(first).toEqual([light, fewerLines])
    expect(second).toEqual([light, fewerLines, dark])
  })

  it('hand out copies that can’t change the core’s settings', async () => {
    const core = createCore()

    const settings = await core.getSettings()
    settings.theme = 'light'

    expect((await core.getSettings()).theme).toBe('dark')
  })
})
