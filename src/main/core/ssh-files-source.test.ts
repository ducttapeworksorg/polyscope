import { createHash, createHmac, randomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionEvent, FollowEvent, HostKey, LargeFileEvent, LargeFileSearchEvent, NewSshFilesSource, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import type { SeedTree } from './file-source-contract'
import { createSecretStore } from './secret-store'
import { generateKey, sshdTarget, startTestSshAgent, startTestSshServer, writeTree, type TestSshAgent, type TestSshServer } from './ssh-test-server'

let dir: string
let home: string
/** The servers and agents a test started, to stop after it. */
const started: (TestSshServer | TestSshAgent)[] = []

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
  await Promise.all(started.splice(0).map((server) => server.close()))
  await rm(dir, { recursive: true, force: true })
})

const startServer = async (options?: Parameters<typeof startTestSshServer>[0]) => {
  const server = await startTestSshServer(options)
  started.push(server)
  return server
}

/** Starts an SSH agent holding `keys`, which SSH_AUTH_SOCK names. */
const startAgent = async (...keys: string[]) => {
  const agent = await startTestSshAgent(...keys)
  started.push(agent)
  vi.stubEnv('SSH_AUTH_SOCK', agent.path)
  return agent
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
  it('is listed with its settings normalised, no port unless given, and only whether a passphrase is set', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ host: ' logs.internal ', user: ' ops ', path: '/var//log/app/', keyFile: ' /keys/id ' }))

    const expected = {
      id: added.id,
      type: 'sshFiles',
      name: 'Server',
      host: 'logs.internal',
      user: 'ops',
      path: '/var/log/app',
      auth: 'keyFile',
      keyFile: '/keys/id',
      passphraseSet: false,
      passwordSet: false
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

describe('an SSH Files Source’s password', () => {
  const password = (changes: Partial<NewSshFilesSource> = {}) => offline({ auth: 'password', keyFile: '', password: 'open sesame', ...changes })

  it('goes to the secret store, never into the saved registry', async () => {
    const dataDir = join(dir, 'user-data')
    const secrets = createSecretStore({ dataDir, cipher: { encrypt: (plain) => Buffer.from(plain, 'utf16le'), decrypt: (b) => b.toString('utf16le') } })
    const core = createCore({ dataDir, secrets })

    const source = await core.addSource(password())

    expect(source).toMatchObject({ auth: 'password', passwordSet: true, passphraseSet: false })
    expect(await secrets.get(source.id, 'password')).toBe('open sesame')
    expect(await readFile(join(dataDir, 'sources.json'), 'utf8')).not.toContain('open sesame')
    expect(JSON.stringify(await core.listSources())).not.toContain('open sesame')
  })

  it('is required to add a Source signing in with one', async () => {
    const core = createCore()

    await expect(core.addSource(password({ password: ' ' }))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
    await expect(core.addSource(password({ password: undefined }))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
  })

  it('is kept when an edit leaves it blank, replaced when an edit gives one, copied by Duplicate and forgotten by Delete', async () => {
    const secrets = createSecretStore({ cipher: { encrypt: (plain) => Buffer.from(plain), decrypt: (b) => b.toString() } })
    const core = createCore({ secrets })
    const source = await core.addSource(password())

    expect(await core.editSource(source.id, password({ name: 'Renamed', password: '' }))).toMatchObject({ name: 'Renamed', passwordSet: true })
    expect(await secrets.get(source.id, 'password')).toBe('open sesame')
    await core.editSource(source.id, password({ password: 'new one' }))
    const copy = await core.duplicateSource(source.id)
    await core.deleteSource(source.id)

    expect(copy).toMatchObject({ auth: 'password', passwordSet: true })
    expect(await secrets.get(copy.id, 'password')).toBe('new one')
    expect(await secrets.get(source.id, 'password')).toBeUndefined()
  })

  it('is forgotten when the Source goes on to sign in another way, as a passphrase is', async () => {
    const secrets = createSecretStore({ cipher: { encrypt: (plain) => Buffer.from(plain), decrypt: (b) => b.toString() } })
    const core = createCore({ secrets })
    const source = await core.addSource(password())

    expect(await core.editSource(source.id, offline({ passphrase: 'for the key' }))).toMatchObject({ passwordSet: false, passphraseSet: true })
    expect(await secrets.get(source.id, 'password')).toBeUndefined()
    expect(await core.editSource(source.id, offline({ auth: 'agent' }))).toMatchObject({ keyFile: '', passwordSet: false, passphraseSet: false })
    expect(await secrets.get(source.id, 'passphrase')).toBeUndefined()
    await expect(core.editSource(source.id, password({ password: '' }))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
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

  it('trusted in Polyscope is forgotten when the last Source on its server is deleted', async () => {
    const server = await startServer()
    const other = await startServer()
    const dataDir = join(dir, 'user-data')
    const core = createCore({ dataDir })
    const trustFor = async (source: { id: string }) => {
      const failure = (await core.connect(source.id).catch((error: unknown) => error)) as { hostKey: HostKey }
      await core.trustHostKey(failure.hostKey)
    }
    const first = await core.addSource(await settingsFor(server, '/'))
    const second = await core.addSource(await settingsFor(server, '/', { name: 'Same server' }))
    const elsewhere = await core.addSource(await settingsFor(other, '/'))
    await trustFor(first)
    await trustFor(elsewhere)

    // Another Source still uses the server's key.
    await core.deleteSource(first.id)
    expect(await core.connect(second.id)).toEqual([])

    await core.deleteSource(second.id)
    const restarted = createCore({ dataDir })
    await expect(restarted.testConnection(await settingsFor(server, '/'))).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
    expect(await restarted.connect(elsewhere.id)).toEqual([])
  })

  it('in ~/.ssh/known_hosts is never forgotten by deleting a Source', async () => {
    const server = await startServer()
    const line = knownHostsLine(server)
    await knownHosts(line)
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const source = await core.addSource(await settingsFor(server, '/'))

    await core.deleteSource(source.id)

    expect(await readFile(join(home, '.ssh', 'known_hosts'), 'utf8')).toBe(`${line}
`)
    await expect(core.testConnection(await settingsFor(server, '/'))).resolves.toBeUndefined()
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
    started.splice(started.indexOf(first), 1)
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

  it('says a file or folder it can’t read isn’t readable by the SSH user, which the adm group, not sudo, can fix', async () => {
    const { core, source, server, path } = await connected({ 'syslog': 'private', 'private/app.log': 'private' })
    server.deny(`${path}/syslog`)
    server.deny(`${path}/private`)
    const denied = {
      code: 'PERMISSION_DENIED',
      message: expect.stringMatching(new RegExp(`^/syslog isn't readable by ${server.user}, the SSH user\\b.*without sudo.*\\badm group\\b`))
    }

    await expect(core.openFile(source.id, 'syslog')).rejects.toMatchObject(denied)
    expect(await core.expand(source.id, 'private')).toMatchObject([{ kind: 'error', ...denied, message: expect.stringMatching(/^\/private isn't readable by .*adm group/) }])
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

/** A Follow's updates so far, as lines, marks in angle brackets. */
const updatesOf = (events: FollowEvent[], followId: string) =>
  events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [`<${e.kind}>`]))

/** Waits for `check` to pass, long enough for a few looks at a followed file. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 100 })

const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('')

describe('following a file on an SSH Files Source', () => {
  /** A Connected Source with app.log holding `content`, and a Follow of it showing its last two lines. */
  const following = async (content: string) => {
    const { core, source, server, path } = await connected({ 'app.log': content })
    const events: FollowEvent[] = []
    core.onFollowEvent((event) => events.push(event))
    const followed = await core.followFile(source.id, 'app.log', { lastNLines: 2 })
    return { core, source, server, followed, file: join(server.root, path, 'app.log'), updates: () => updatesOf(events, followed.followId) }
  }

  it('starts with its last N lines and adds lines as they are written, holding them back while paused', async () => {
    const { core, followed, file, updates } = await following(numbered(1, 5))
    expect(followed).toMatchObject({ view: 'log', of: 'file', content: 'line 4\nline 5' })

    await appendFile(file, numbered(6, 7))
    await eventually(() => expect(updates()).toEqual(['line 6', 'line 7']))
    await core.pauseFollow(followed.followId)
    await appendFile(file, 'line 8\n')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(updates()).toEqual(['line 6', 'line 7'])
    await core.resumeFollow(followed.followId)
    expect(updates()).toEqual(['line 6', 'line 7', 'line 8'])
    await core.stopFollow(followed.followId)
  })

  it('marks a file cut short and follows it from its start', async () => {
    const { file, updates } = await following(numbered(1, 5))

    await writeFile(file, 'anew\n')
    await eventually(() => expect(updates()).toEqual(['<truncated>', 'anew']))
  })

  it('marks a file rotated out for a new one, already longer, and follows the new one', async () => {
    const { file, updates } = await following(numbered(1, 5))

    // SFTP tells no inode, so it's what the new file holds where the old one ended that gives it away.
    await rename(file, `${file}.1`)
    // Written whole and then moved in, so no look catches it part-written, and so shorter, as if cut short.
    await writeFile(`${file}.new`, `${numbered(11, 19)}rotated in\n`)
    await rename(`${file}.new`, file)
    // A look between the two finds no file, which is marked as failing for a moment.
    const rotation = () => updates().filter((u) => u !== '<failed>' && u !== '<recovered>')
    await eventually(() => expect(rotation()).toEqual(['<rotated>', ...numbered(11, 19).trimEnd().split('\n'), 'rotated in']))
  }, 15_000)
})

describe('an SSH Files Source whose connection drops', () => {
  it('connects again on the next browse, and on the next read, staying Connected', async () => {
    const { core, source, server } = await connected({ 'app.log': 'a line' })

    await server.dropConnections()
    expect(names(await core.expand(source.id, ''))).toEqual(['app.log'])
    expect(server.connectionCount()).toBe(1)
    await server.dropConnections()
    expect(await core.openFile(source.id, 'app.log')).toMatchObject({ view: 'editor', content: 'a line' })
    expect(server.connectionCount()).toBe(1)
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('goes to Error when connecting again fails, failing the calls waiting on it', async () => {
    const { core, source, server } = await connected({ 'app.log': 'a line' })
    const events: ConnectionEvent[] = []
    core.onConnectionEvent((event) => events.push(event))

    await server.close()
    started.splice(started.indexOf(server), 1)
    const calls = [core.expand(source.id, ''), core.openFile(source.id, 'app.log')]
    await expect(Promise.all(calls)).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'UNREACHABLE' })
    // Told, as nothing asked to connect it: the sidebar shows the Source in Error.
    expect(events).toEqual([{ sourceId: source.id, state: 'error', code: 'UNREACHABLE', message: expect.any(String) }])
    await expect(core.expand(source.id, '')).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
  })

  it('ends a Follow over it, saying the connection dropped, and the Source can be followed again', async () => {
    const { core, source, server, path } = await connected({ 'app.log': numbered(1, 3) })
    const events: FollowEvent[] = []
    core.onFollowEvent((event) => events.push(event))
    const followed = await core.followFile(source.id, 'app.log', { lastNLines: 2 })

    await server.dropConnections()
    await eventually(() => expect(events).toEqual([{ followId: followed.followId, kind: 'ended', reason: 'connectionLost' }]))
    const again = await core.followFile(source.id, 'app.log', { lastNLines: 2 })
    await appendFile(join(server.root, path, 'app.log'), 'line 4\n')
    await eventually(() => expect(updatesOf(events, again.followId)).toEqual(['line 4']))
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
    started.splice(started.indexOf(server), 1)

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

  it('signs in with a password, and fails with a wrong one', async () => {
    const server = await startServer({ password: 'open sesame' })
    const path = await server.seed({ 'app.log': 'a' })
    const settings = await settingsFor(server, path, { auth: 'password', keyFile: '', password: 'open sesame' })

    await failsWith('SIGN_IN_REFUSED', server, { ...settings, password: 'wrong' })
    await knownHosts(knownHostsLine(server))
    const core = createCore()
    const source = await core.addSource(settings)
    expect(names(await core.connect(source.id))).toEqual(['app.log'])
  })

  it('signs in through the SSH agent, trying each of its keys', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await startAgent(generateKey().private, server.clientKey)
    await knownHosts(knownHostsLine(server))
    const core = createCore()
    const source = await core.addSource(await settingsFor(server, path, { auth: 'agent', keyFile: '' }))

    expect(source).toMatchObject({ auth: 'agent', keyFile: '', passphraseSet: false, passwordSet: false })
    expect(names(await core.connect(source.id))).toEqual(['app.log'])
  })

  it('fails when the SSH agent holds no key the server takes', async () => {
    const server = await startServer()
    await startAgent(generateKey().private)

    await failsWith('SIGN_IN_REFUSED', server, await settingsFor(server, '/', { auth: 'agent' }))
  })

  // Windows goes on to the agents that are always looked for there, which this computer may have (see ssh-agent.test.ts).
  it.skipIf(process.platform === 'win32')('fails saying so when no SSH agent answers', async () => {
    const server = await startServer()
    vi.stubEnv('SSH_AUTH_SOCK', join(dir, 'no-agent.sock'))

    await failsWith('AGENT_NOT_FOUND', server, await settingsFor(server, '/', { auth: 'agent' }))
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

/** The user's ~/.ssh/config, holding `lines`. */
const sshConfig = (...lines: string[]) => writeFile(join(home, '.ssh', 'config'), lines.map((line) => `${line}\n`).join(''))

/** Settings for a Source on an SSH config alias, leaving the rest to the config: it signs in with a key file it names. */
const aliasSettings = (host: string, path: string, changes: Partial<NewSshFilesSource> = {}): NewSshFilesSource => ({
  type: 'sshFiles',
  name: 'Server',
  host,
  user: '',
  path,
  auth: 'keyFile',
  keyFile: '',
  ...changes
})

describe('an SSH Files Source on an SSH config alias', () => {
  it('connects with the alias’s HostName, User, Port and IdentityFile', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await sshConfig('Host logs', `  HostName ${server.host}`, `  Port ${server.port}`, `  User ${server.user}`, `  IdentityFile ${await keyFile(server.clientKey)}`)
    await knownHosts(knownHostsLine(server))
    const core = createCore()

    const source = await core.addSource(aliasSettings('logs', path))

    expect(source).toMatchObject({ host: 'logs', user: '', keyFile: '' })
    expect(source).not.toHaveProperty('port')
    expect(names(await core.connect(source.id))).toEqual(['app.log'])
  })

  it('matches wildcard Host patterns, and Included files, as ssh does', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await mkdir(join(home, '.ssh', 'config.d'))
    await writeFile(join(home, '.ssh', 'config.d', 'servers'), `Host *.test\n  HostName ${server.host}\n  Port ${server.port}\n`)
    await sshConfig('Include config.d/*', 'Host *', `  User ${server.user}`, `  IdentityFile ${await keyFile(server.clientKey)}`)
    await knownHosts(knownHostsLine(server))

    await expect(createCore().testConnection(aliasSettings('web.test', path))).resolves.toBeUndefined()
  })

  it('lets settings typed in the Source win over the config’s, as ssh’s command line does', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await sshConfig('Host logs', `  HostName ${server.host}`, '  Port 1', '  User someone-else', `  IdentityFile ${join(dir, 'missing-key')}`)
    await knownHosts(knownHostsLine(server))

    const typed = aliasSettings('logs', path, { port: server.port, user: server.user, keyFile: await keyFile(server.clientKey) })
    await expect(createCore().testConnection(typed)).resolves.toBeUndefined()
  })

  it('signs in through the SSH agent as the config’s User', async () => {
    const server = await startServer()
    const path = await server.seed({ 'app.log': 'a' })
    await startAgent(server.clientKey)
    await sshConfig('Host logs', `  HostName ${server.host}`, `  Port ${server.port}`, `  User ${server.user}`)
    await knownHosts(knownHostsLine(server))

    await expect(createCore().testConnection(aliasSettings('logs', path, { auth: 'agent' }))).resolves.toBeUndefined()
  })

  it('needs a user, and a key file, from the Source or the config', async () => {
    await sshConfig('Host logs', '  HostName logs.internal')
    const core = createCore()

    await expect(core.addSource(aliasSettings('logs', '/var/log'))).rejects.toMatchObject({ code: 'USER_REQUIRED' })
    await expect(core.addSource(aliasSettings('logs', '/var/log', { user: 'ops' }))).rejects.toMatchObject({ code: 'KEY_FILE_REQUIRED' })
  })

  it('fails naming ProxyCommand when the host needs it', async () => {
    await sshConfig('Host piped', '  User ops', '  ProxyCommand nc %h %p')
    const core = createCore()
    const source = await core.addSource(aliasSettings('piped', '/var/log', { auth: 'agent' }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_SSH_OPTION', message: expect.stringContaining('ProxyCommand') })
  })

  it('is the same server as its HostName when deleting a Source forgets the host keys trusted for it', async () => {
    const server = await startServer()
    await sshConfig('Host logs', `  HostName ${server.host}`, `  Port ${server.port}`)
    const dataDir = join(dir, 'user-data')
    const core = createCore({ dataDir })
    const byAlias = await core.addSource(aliasSettings('logs', '/', { user: server.user, keyFile: await keyFile(server.clientKey) }))
    const byName = await core.addSource(await settingsFor(server, '/'))
    const failure = (await core.connect(byAlias.id).catch((error: unknown) => error)) as { hostKey: HostKey }
    await core.trustHostKey(failure.hostKey)

    await core.deleteSource(byName.id)
    expect(await core.connect(byAlias.id)).toEqual([])

    await core.deleteSource(byAlias.id)
    await expect(createCore({ dataDir }).testConnection(await settingsFor(server, '/'))).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
  })

  it('is suggested, with what the config says about it', async () => {
    await sshConfig('Host logs db', '  HostName %h.internal', '  Port 2222', 'Host *.prod', '  User deploy', 'Host *', '  User ops')

    expect(await createCore().listSshHosts()).toEqual([
      { alias: 'logs', hostName: 'logs.internal', user: 'ops', port: 2222 },
      { alias: 'db', hostName: 'db.internal', user: 'ops', port: 2222 }
    ])
  })
})

describe('an SSH Files Source through ProxyJump', () => {
  /**
   * A server reachable only through two bastions, `first` and `second`, as ~/.ssh/config's `logs` alias says, each
   * signing in with a key of its own the config names. The second bastion and the server are under .invalid, which
   * only the bastion before them resolves.
   */
  async function behindBastions() {
    const [first, second, server] = [await startServer(), await startServer(), await startServer()]
    const path = await server.seed({ 'app.log': 'a' })
    await sshConfig(
      'Host logs',
      '  HostName logs.invalid',
      `  Port ${server.port}`,
      '  ProxyJump first,second',
      `  IdentityFile ${await keyFile(server.clientKey)}`,
      'Host first',
      `  HostName ${first.host}`,
      `  Port ${first.port}`,
      `  IdentityFile ${await keyFile(first.clientKey)}`,
      'Host second',
      '  HostName second.invalid',
      `  Port ${second.port}`,
      `  IdentityFile ${await keyFile(second.clientKey)}`,
      'Host *',
      `  User ${server.user}`
    )
    const known = {
      first: knownHostsLine(first),
      second: knownHostsLine({ host: 'second.invalid', port: second.port, hostKey: second.hostKey }),
      server: knownHostsLine({ host: 'logs.invalid', port: server.port, hostKey: server.hostKey })
    }
    return { first, second, server, path, known }
  }

  it('goes through each bastion in turn, signing in to each with its own IdentityFile', async () => {
    const { first, second, server, path, known } = await behindBastions()
    await knownHosts(known.first, known.second, known.server)
    const core = createCore()
    const source = await core.addSource(aliasSettings('logs', path))

    expect(names(await core.connect(source.id))).toEqual(['app.log'])
    expect(first.forwarded()).toEqual([`second.invalid:${second.port}`])
    expect(second.forwarded()).toEqual([`logs.invalid:${server.port}`])
  })

  it('offers each server’s unknown host key to trust in turn, bastions first', async () => {
    const { first, second, server, path } = await behindBastions()
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const settings = aliasSettings('logs', path)
    const offered: HostKey[] = []

    for (let attempt = 0; attempt < 3; attempt++) {
      const failure = (await core.testConnection(settings).catch((error: unknown) => error)) as { code: string; hostKey: HostKey }
      expect(failure.code).toBe('HOST_KEY_UNKNOWN')
      offered.push(failure.hostKey)
      await core.trustHostKey(failure.hostKey)
    }

    expect(offered).toEqual([
      { host: first.host, port: first.port, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(first.hostKey) },
      { host: 'second.invalid', port: second.port, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(second.hostKey) },
      { host: 'logs.invalid', port: server.port, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(server.hostKey) }
    ])
    await expect(core.testConnection(settings)).resolves.toBeUndefined()
  })

  it('refuses a bastion whose host key isn’t the one known for it', async () => {
    const { second, path, known } = await behindBastions()
    await knownHosts(known.first, knownHostsLine({ host: 'second.invalid', port: second.port, hostKey: generateKey().public }), known.server)

    await expect(createCore().testConnection(aliasSettings('logs', path))).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
  })

  it('signs in to the bastions through the SSH agent too, and disconnecting closes every connection', async () => {
    const { first, second, server, path, known } = await behindBastions()
    await knownHosts(known.first, known.second, known.server)
    await startAgent(first.clientKey, second.clientKey, server.clientKey)
    const core = createCore()
    const source = await core.addSource(aliasSettings('logs', path, { auth: 'agent' }))

    expect(names(await core.connect(source.id))).toEqual(['app.log'])
    expect([first, second, server].map((s) => s.connectionCount())).toEqual([1, 1, 1])
    await core.disconnect(source.id)
    await vi.waitFor(() => expect([first, second, server].map((s) => s.connectionCount())).toEqual([0, 0, 0]))
  })

  it('takes a bastion’s user and port from the ProxyJump itself', async () => {
    const { first, server, path, known } = await behindBastions()
    await knownHosts(known.first, known.server)
    await sshConfig(
      'Host logs',
      '  HostName logs.invalid',
      `  Port ${server.port}`,
      `  ProxyJump ${server.user}@${first.host}:${first.port}`,
      `  IdentityFile ${await keyFile(server.clientKey)}`,
      `  User ${server.user}`
    )

    // The bastion has no IdentityFile of its own here, so it's signed into with the agent, as the server is.
    await startAgent(first.clientKey, server.clientKey)
    await expect(createCore().testConnection(aliasSettings('logs', path, { auth: 'agent' }))).resolves.toBeUndefined()
  })

  it('fails naming ProxyCommand when a bastion needs it', async () => {
    await sshConfig('Host logs', '  ProxyJump bastion', '  User ops', 'Host bastion', '  ProxyCommand ssh -W %h:%p gateway')
    const core = createCore()

    await expect(core.testConnection(aliasSettings('logs', '/var/log', { auth: 'agent' }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_SSH_OPTION',
      message: expect.stringMatching(/bastion.*ProxyCommand/)
    })
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
