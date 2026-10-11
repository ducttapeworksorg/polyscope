import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostKey, LargeFileEvent, LargeFileSearchEvent, NewSshFilesSource, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import type { SeedTree } from './file-source-contract'
import { createSecretStore } from './secret-store'
import { generateKey, sshdTarget, startTestSshServer, writeTree, type TestSshServer } from './ssh-test-server'

let dir: string
let home: string
const servers: TestSshServer[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-ssh-files-'))
  // A home of the test's own, so the user's real ~/.ssh is never read.
  home = join(dir, 'home')
  await mkdir(join(home, '.ssh'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await rm(dir, { recursive: true, force: true })
})

const startServer = async (options?: Parameters<typeof startTestSshServer>[0]) => {
  const server = await startTestSshServer(options)
  servers.push(server)
  return server
}

/** Writes a key file into the test's folder, returning its path. */
async function keyFile(key: string, name = `key-${randomBytes(4).toString('hex')}`) {
  const file = join(dir, name)
  await writeFile(file, key)
  return file
}

/** How known_hosts names a server: its host alone on port 22, `[host]:port` on any other. */
const knownHostsName = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`)

/** The user's ~/.ssh/known_hosts, holding `lines`. */
const knownHosts = (...lines: string[]) => writeFile(join(home, '.ssh', 'known_hosts'), lines.map((line) => `${line}\n`).join(''))

/** A known_hosts line for a server's host key, its name in the clear or hashed as `HashKnownHosts` writes it. */
function knownHostsLine({ host, port, hostKey }: { host: string; port: number; hostKey: string }, { hashed = false } = {}) {
  const name = knownHostsName(host, port)
  if (!hashed) return `${name} ${hostKey.trim()}`
  const salt = randomBytes(20)
  const hash = createHmac('sha1', salt).update(name).digest()
  return `|1|${salt.toString('base64')}|${hash.toString('base64')} ${hostKey.trim()}`
}

/** A host key's fingerprint as OpenSSH shows it, from its public key line. */
const fingerprintOf = (publicKey: string) =>
  `SHA256:${createHash('sha256').update(Buffer.from(publicKey.trim().split(/\s+/)[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`

/** Settings for a server that needn't exist: nothing here connects to it. */
const offline = (changes: Partial<NewSshFilesSource> = {}): NewSshFilesSource => ({
  type: 'sshFiles',
  name: 'Server',
  host: 'logs.internal',
  user: 'ops',
  path: '/var/log',
  keyFile: '/home/ops/.ssh/id_ed25519',
  ...changes
})

/** Settings for a test server, signing in with its key and browsing `path`. */
const settingsFor = async (server: TestSshServer, path: string, changes: Partial<NewSshFilesSource> = {}): Promise<NewSshFilesSource> => ({
  type: 'sshFiles',
  name: 'Server',
  host: server.host,
  port: server.port,
  user: server.user,
  path,
  keyFile: await keyFile(server.clientKey),
  ...changes
})

const names = (nodes: TreeNode[]) => nodes.map((node) => (node.kind === 'more' ? '…more' : node.kind === 'error' ? node.code : node.name))

describe('adding an SSH Files Source', () => {
  it('is listed with its settings normalised, port 22 by default, and only whether a passphrase is set', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ host: ' logs.internal ', user: ' ops ', path: '/var//log/app/', keyFile: ' /keys/id ' }))

    const expected = {
      id: added.id,
      type: 'sshFiles',
      name: 'Server',
      host: 'logs.internal',
      user: 'ops',
      port: 22,
      path: '/var/log/app',
      keyFile: '/keys/id',
      passphraseSet: false
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('keeps a port given and a path at the root', async () => {
    const core = createCore()

    expect(await core.addSource(offline({ port: 2222, path: '/' }))).toMatchObject({ port: 2222, path: '/' })
  })

  it.each([
    ['HOST_REQUIRED', { host: ' ' }],
    ['USER_REQUIRED', { user: '' }],
    ['INVALID_PORT', { port: 0 }],
    ['INVALID_PORT', { port: 65536 }],
    ['INVALID_PORT', { port: 22.5 }],
    ['INVALID_PATH', { path: 'var/log' }],
    ['INVALID_PATH', { path: '/var/../etc' }],
    ['INVALID_PATH', { path: '' }],
    ['KEY_FILE_REQUIRED', { keyFile: ' ' }]
  ] as const)('refuses settings with %s: %o', async (code, changes) => {
    const core = createCore()

    await expect(core.addSource(offline(changes))).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it('is saved without waiting for its server to be reachable', async () => {
    const core = createCore()

    const source = await core.addSource(offline())

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })

  it('takes an Environment label like any Source', async () => {
    const core = createCore()
    const [prod] = await core.listEnvironments()

    expect(await core.addSource(offline({ environmentId: prod!.id }))).toMatchObject({ environmentId: prod!.id })
  })
})

describe('an SSH Files Source’s passphrase', () => {
  const reversed = {
    encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
    decrypt: (encrypted: Buffer) => [...encrypted.toString()].reverse().join('')
  }

  it('goes to the secret store, never into the saved registry', async () => {
    const dataDir = join(dir, 'user-data')
    const secrets = createSecretStore({ dataDir, cipher: reversed })
    const core = createCore({ dataDir, secrets })

    const source = await core.addSource(offline({ passphrase: 'correct horse' }))

    expect(source).toMatchObject({ passphraseSet: true })
    expect(await secrets.get(source.id, 'passphrase')).toBe('correct horse')
    expect(await readFile(join(dataDir, 'sources.json'), 'utf8')).not.toContain('correct horse')
    expect(JSON.stringify(await core.listSources())).not.toContain('correct horse')
  })

  it('is kept when an edit leaves it blank, and replaced when an edit gives one', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ passphrase: 'first' }))

    expect(await core.editSource(source.id, offline({ name: 'Renamed', passphrase: '' }))).toMatchObject({ name: 'Renamed', passphraseSet: true })
    expect(await secrets.get(source.id, 'passphrase')).toBe('first')

    await core.editSource(source.id, offline({ passphrase: 'second' }))
    expect(await secrets.get(source.id, 'passphrase')).toBe('second')
  })

  it('goes along with a duplicate, and is forgotten when the Source is deleted', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ passphrase: 'shared' }))

    const copy = await core.duplicateSource(source.id)
    await core.deleteSource(source.id)

    expect(copy).toMatchObject({ type: 'sshFiles', passphraseSet: true })
    expect(await secrets.get(copy.id, 'passphrase')).toBe('shared')
    expect(await secrets.get(source.id, 'passphrase')).toBeUndefined()
  })
})

describe('an SSH Files Source’s host key', () => {
  it('is trusted from ~/.ssh/known_hosts, and connecting lists the folder', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'twelve bytes', 'old/x.log': 'x' })
    await knownHosts(knownHostsLine(server))
    const core = createCore()
    const source = await core.addSource(await settingsFor(server, path))

    const nodes = await core.connect(source.id)

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'old', path: 'old' },
      { kind: 'file', name: 'app.log', path: 'app.log', size: 12, icon: 'log' }
    ])
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('is trusted from a hashed known_hosts entry', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await knownHosts(knownHostsLine(server, { hashed: true }))

    await expect(createCore().testConnection(await settingsFor(server, path))).resolves.toBeUndefined()
  })

  it('that isn’t known fails with its type and fingerprint, and once trusted is trusted after a restart too', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    const dataDir = join(dir, 'user-data')
    const core = createCore({ dataDir })
    const source = await core.addSource(await settingsFor(server, path))
    const hostKey = { host: server.host, port: server.port, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(server.hostKey) }

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKey })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'HOST_KEY_UNKNOWN', hostKey })
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))

    await core.trustHostKey(hostKey)
    expect(names(await core.connect(source.id))).toEqual(['app.log'])

    const restarted = createCore({ dataDir })
    expect(names(await restarted.connect(source.id))).toEqual(['app.log'])
  })

  it('is offered by a connection test too, and trusting it never writes ~/.ssh/known_hosts', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await knownHosts('# mine')
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const settings = await settingsFor(server, path)

    const failure = (await core.testConnection(settings).catch((error: unknown) => error)) as { hostKey: HostKey }
    expect(failure).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKey: { fingerprint: fingerprintOf(server.hostKey) } })
    await core.trustHostKey(failure.hostKey)

    await expect(core.testConnection(settings)).resolves.toBeUndefined()
    expect(await readFile(join(home, '.ssh', 'known_hosts'), 'utf8')).toBe('# mine\n')
    await expect(stat(join(home, '.ssh', 'known_hosts2'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can’t be trusted unless a connection offered it', async () => {
    const madeUp = { host: '127.0.0.1', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:made-up' }

    await expect(createCore().trustHostKey(madeUp)).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
  })

  it('that differs from the one in known_hosts is refused, with nothing to trust', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await knownHosts(knownHostsLine({ ...server, hostKey: generateKey().public }))
    const core = createCore()
    const source = await core.addSource(await settingsFor(server, path))

    const failure = await core.connect(source.id).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'HOST_KEY_CHANGED', hostKey: undefined })
    expect(await core.connectionState(source.id)).not.toHaveProperty('hostKey')
    const presented = { host: server.host, port: server.port, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(server.hostKey) }
    await expect(core.trustHostKey(presented)).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
  })

  it('that differs from one trusted in Polyscope is refused', async () => {
    const first = await startServer()
    const core = createCore()
    const failure = (await core.testConnection(await settingsFor(first, '/')).catch((error: unknown) => error)) as { hostKey: HostKey }
    await core.trustHostKey(failure.hostKey)
    // Another server, with another host key, at the same address.
    const { port } = first
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const impostor = await startServer({ port })

    await expect(core.testConnection(await settingsFor(impostor, '/'))).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
  })

  it('revoked in known_hosts is refused', async () => {
    const server = await startServer()
    await knownHosts(`@revoked * ${server.hostKey.trim()}`, knownHostsLine(server))

    await expect(createCore().testConnection(await settingsFor(server, '/'))).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
  })
})

/** A server whose host key is in known_hosts, with `tree` seeded, and a core with a Connected Source browsing it. */
async function connected(tree: SeedTree) {
  const server = await startServer()
  const path = await server.seed(tree)
  await knownHosts(knownHostsLine(server))
  const core = createCore({ cacheDir: join(dir, 'cache') })
  const source = await core.addSource(await settingsFor(server, path))
  await core.connect(source.id)
  return { server, core, source, path }
}

describe('browsing and reading an SSH Files Source', () => {
  it('lists nested folders with sizes and modified times', async () => {
    const before = Date.now() - 10 * 60_000
    const { core, source } = await connected({ 'app/current/server.log': 'twelve bytes', 'app/current/old': null })

    const nodes = await core.expand(source.id, 'app/current')

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'old', path: 'app/current/old' },
      { kind: 'file', name: 'server.log', path: 'app/current/server.log', size: 12 }
    ])
    expect(nodes[1]?.kind === 'file' && nodes[1].modifiedTime).toBeGreaterThan(before)
  })

  it('opens a file as text, with its language from its name', async () => {
    const { core, source } = await connected({ 'config.json': '{ "a": 1 }' })

    expect(await core.openFile(source.id, 'config.json')).toMatchObject({ view: 'editor', content: '{ "a": 1 }', language: 'json', encoding: 'utf-8' })
  })

  it('opens gzipped and zstd-compressed files decompressed', async () => {
    const { core, source } = await connected({ 'app.log.1.gz': gzipSync('rotated line\n'), 'app.log.2.zst': zstdCompressSync('older line\n') })

    expect(await core.openFile(source.id, 'app.log.1.gz')).toMatchObject({ view: 'editor', content: 'rotated line\n', compression: 'gzip' })
    expect(await core.openFile(source.id, 'app.log.2.zst')).toMatchObject({ view: 'editor', content: 'older line\n', compression: 'zstd' })
  })

  it('opens a file over the Large File threshold in the Large File Viewer, to page through and search', async () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i}${i === 12_345 ? ' ERROR disk full' : ''}`)
    const { core, source } = await connected({ 'big.log': `${lines.join('\n')}\n` })
    await core.updateSettings({ largeFileThreshold: 256 * 1024 })
    const statuses: LargeFileEvent[] = []
    core.onLargeFileEvent((event) => statuses.push(event))

    const opened = await core.openFile(source.id, 'big.log')
    if (opened.view !== 'large') throw new Error(`Opened in the ${opened.view} view`)
    expect(opened.lastLines.at(-1)).toBe('line 29999')
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ state: 'ready', lineCount: 30_000 }), { timeout: 30_000 })

    expect(await core.readLargeFileLines(opened.largeFileId, 100, 2)).toEqual({ firstLine: 100, lines: ['line 100', 'line 101'] })
    const updates: LargeFileSearchEvent[] = []
    core.onLargeFileSearchEvent((event) => updates.push(event))
    await core.searchLargeFile(opened.largeFileId, { pattern: 'error' })
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ kind: 'done', matchedLines: 1 }), { timeout: 30_000 })
    expect(updates.flatMap((u) => (u.kind === 'progress' ? u.matches.map((m) => m.line) : []))).toEqual([12_345])
    await core.closeLargeFile(opened.largeFileId)
  })

  it('follows symlinks, and flags dangling and looping ones, as a Local Filesystem Source does', async () => {
    const { core, source, server, path } = await connected({ 'logs/a.log': 'a', 'logs/inner': null })
    const at = (p: string) => join(server.root, path, p)
    // Without privileges, Windows makes folder links as junctions, whose targets are absolute.
    const linkFolder = (target: string, link: string) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    await linkFolder(at('logs'), at('current'))
    await linkFolder(at('gone'), at('dangling'))
    await linkFolder(at('logs'), at('logs/inner/back'))

    expect(await core.expand(source.id, '')).toMatchObject([
      { kind: 'folder', name: 'current' },
      { kind: 'folder', name: 'logs' },
      { kind: 'file', name: 'dangling' }
    ])
    expect(await core.expand(source.id, 'current')).toMatchObject([{ kind: 'folder', name: 'inner' }, { kind: 'file', name: 'a.log' }])
    expect(await core.expand(source.id, 'logs/inner')).toMatchObject([{ kind: 'folder', name: 'back', problem: { code: 'SYMLINK_LOOP' } }])
  })
})

describe('connecting an SSH Files Source', () => {
  /** Expects a Source on a server whose host key is known to fail to connect, and its connection test, with `code`. */
  const failsWith = async (code: string, server: TestSshServer, settings: NewSshFilesSource) => {
    await knownHosts(knownHostsLine(server))
    const core = createCore()
    const source = await core.addSource(settings)
    await expect(core.connect(source.id)).rejects.toMatchObject({ code })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code })
    await expect(core.testConnection(settings)).rejects.toMatchObject({ code })
  }

  it('fails when the host can’t be reached', async () => {
    const server = await startServer()
    const settings = await settingsFor(server, '/')
    await server.close()
    servers.splice(servers.indexOf(server), 1)

    await failsWith('UNREACHABLE', server, settings)
  })

  it('fails when the server refuses the key, or the user', async () => {
    const server = await startServer()

    await failsWith('SIGN_IN_REFUSED', server, await settingsFor(server, '/', { keyFile: await keyFile(generateKey().private) }))
    await failsWith('SIGN_IN_REFUSED', server, await settingsFor(server, '/', { user: 'someone-else' }))
  })

  it('fails when the path doesn’t exist, or is a file', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })

    await failsWith('ROOT_NOT_FOUND', server, await settingsFor(server, `${path}/missing`))
    await failsWith('ROOT_NOT_A_FOLDER', server, await settingsFor(server, `${path}/app.log`))
  })

  it('fails when the server’s SFTP subsystem is turned off', async () => {
    const server = await startServer({ sftp: false })

    await failsWith('SFTP_UNAVAILABLE', server, await settingsFor(server, '/'))
  })

  it('fails when the key file is missing, or holds no private key', async () => {
    const server = await startServer()

    await failsWith('KEY_FILE_UNREADABLE', server, await settingsFor(server, '/', { keyFile: join(dir, 'missing') }))
    await failsWith('KEY_FILE_UNREADABLE', server, await settingsFor(server, '/', { keyFile: await keyFile(server.hostKey) }))
  })

  it('signs in with an encrypted key file and its passphrase, and fails without one or with a wrong one', async () => {
    const server = await startServer({ clientKey: generateKey('correct horse') })
    const settings = await settingsFor(server, '/')

    await failsWith('PASSPHRASE_REQUIRED', server, settings)
    await failsWith('PASSPHRASE_WRONG', server, { ...settings, passphrase: 'battery staple' })
    await expect(createCore().testConnection({ ...settings, passphrase: 'correct horse' })).resolves.toBeUndefined()
  })

  it('tests an edit with the stored passphrase when it’s left blank, and connects with it', async () => {
    const server = await startServer({ clientKey: generateKey('correct horse') })
    await knownHosts(knownHostsLine(server))
    const core = createCore()
    const settings = await settingsFor(server, '/', { passphrase: 'correct horse' })
    const source = await core.addSource(settings)

    await expect(core.testConnection({ ...settings, passphrase: '' }, source.id)).resolves.toBeUndefined()
    expect(await core.connect(source.id)).toEqual([])
  })

  it('opens one connection, which disconnecting closes, and a connection test leaves none open', async () => {
    const { core, source, server } = await connected({ 'a.log': 'a', 'b.log': 'b' })
    await core.openFile(source.id, 'a.log')
    await core.openFile(source.id, 'b.log')
    await core.expand(source.id, '')
    expect(server.connectionCount()).toBe(1)

    await core.disconnect(source.id)
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))

    await core.testConnection(await settingsFor(server, '/'))
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))
  })
})

describe.skipIf(!sshdTarget)('an SSH Files Source against sshd', () => {
  const sshd = sshdTarget!
  const hostKey = () => readFile(sshd.hostKeyFile, 'utf8')

  /** A folder of sshd's, seeded with `tree`, and settings for a Source browsing it. */
  const seeded = async (tree: SeedTree) => {
    const folder = await mkdtemp(join(sshd.root, 'facade-'))
    await writeTree(folder, tree)
    const settings: NewSshFilesSource = { type: 'sshFiles', name: 'sshd', host: sshd.host, port: sshd.port, user: sshd.user, path: folder, keyFile: sshd.keyFile }
    return { folder, settings }
  }

  it('connects when its host key is in known_hosts, then browses, reads and decompresses', async () => {
    const { folder, settings } = await seeded({ 'app.log': 'twelve bytes', 'old/app.log.1.gz': gzipSync('rotated\n') })
    await knownHosts(knownHostsLine({ host: sshd.host, port: sshd.port, hostKey: await hostKey() }, { hashed: true }))
    const core = createCore()
    const source = await core.addSource(settings)

    expect(await core.connect(source.id)).toMatchObject([
      { kind: 'folder', name: 'old' },
      { kind: 'file', name: 'app.log', size: 12 }
    ])
    expect(await core.openFile(source.id, 'app.log')).toMatchObject({ view: 'editor', content: 'twelve bytes' })
    expect(await core.openFile(source.id, 'old/app.log.1.gz')).toMatchObject({ view: 'editor', content: 'rotated\n', compression: 'gzip' })
    await core.disconnect(source.id)
    await rm(folder, { recursive: true, force: true })
  })

  it('offers an unknown host key to trust, and connects once it’s trusted', async () => {
    const { folder, settings } = await seeded({ 'app.log': 'a' })
    const core = createCore({ dataDir: join(dir, 'user-data') })

    const failure = (await core.testConnection(settings).catch((error: unknown) => error)) as { hostKey: HostKey }
    expect(failure).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKey: { fingerprint: fingerprintOf(await hostKey()) } })
    await core.trustHostKey(failure.hostKey)

    await expect(core.testConnection(settings)).resolves.toBeUndefined()
    await rm(folder, { recursive: true, force: true })
  })

  it('refuses a host key other than the one in known_hosts', async () => {
    const { folder, settings } = await seeded({})
    // Of the same type as sshd's, so it's a changed key rather than one of another type.
    await knownHosts(knownHostsLine({ host: sshd.host, port: sshd.port, hostKey: generateKey().public }))

    await expect(createCore().testConnection(settings)).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    await rm(folder, { recursive: true, force: true })
  })

  it('is refused another key, and a path that doesn’t exist', async () => {
    const { folder, settings } = await seeded({})
    await knownHosts(knownHostsLine({ host: sshd.host, port: sshd.port, hostKey: await hostKey() }))
    const core = createCore()

    await expect(core.testConnection({ ...settings, keyFile: await keyFile(generateKey().private) })).rejects.toMatchObject({ code: 'SIGN_IN_REFUSED' })
    await expect(core.testConnection({ ...settings, path: `${folder}/missing` })).rejects.toMatchObject({ code: 'ROOT_NOT_FOUND' })
    await rm(folder, { recursive: true, force: true })
  })
})
