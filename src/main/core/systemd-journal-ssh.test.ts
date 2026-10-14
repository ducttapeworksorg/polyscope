import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, NewSystemdJournalSource, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { argsOf, standInJournal } from './journal-test-host'
import { startTestSshServer, type TestCommand, type TestSshServer } from './ssh-test-server'

let dir: string
let home: string
/** The servers a test started, to stop after it. */
const started: TestSshServer[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-journal-ssh-'))
  // A home of the test's own, so the user's real ~/.ssh is never read.
  home = join(dir, 'home')
  await mkdir(join(home, '.ssh'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(started.splice(0).map((server) => server.close()))
  await rm(dir, { recursive: true, force: true })
})

/** Settings for a host that needn't exist: nothing here connects to it. */
const offline = (changes: Partial<NewSystemdJournalSource> = {}): NewSystemdJournalSource => ({
  type: 'systemdJournal',
  name: 'Web',
  target: 'ssh',
  host: 'web.internal',
  user: 'ops',
  auth: 'keyFile',
  keyFile: '/home/ops/.ssh/id_ed25519',
  ...changes
})

const plainSecrets = () => createSecretStore({ cipher: { encrypt: (plain) => Buffer.from(plain), decrypt: (b) => b.toString() } })

describe('adding a systemd Journal Source on a host over SSH', () => {
  it('is listed with its SSH settings, as an SSH Files Source’s, on any OS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const core = createCore()

    const added = await core.addSource(offline({ host: ' web.internal ', user: ' ops ', port: 2222, keyFile: ' /keys/id ' }))

    const expected = {
      id: added.id,
      type: 'systemdJournal',
      name: 'Web',
      target: 'ssh',
      host: 'web.internal',
      user: 'ops',
      port: 2222,
      auth: 'keyFile',
      keyFile: '/keys/id',
      passphraseSet: false,
      passwordSet: false
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
    expect(await core.connectionState(added.id)).toEqual({ state: 'disconnected' })
  })

  it.each([
    ['HOST_REQUIRED', { host: ' ' }],
    ['USER_REQUIRED', { user: '' }],
    ['INVALID_PORT', { port: 0 }],
    ['KEY_FILE_REQUIRED', { keyFile: ' ' }],
    ['PASSWORD_REQUIRED', { auth: 'password', password: ' ' }]
  ] as const)('refuses settings with %s: %o', async (code, changes) => {
    await expect(createCore().addSource(offline(changes))).rejects.toMatchObject({ code })
  })

  it('takes its user, port and key file from an ~/.ssh/config alias', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host web\n  HostName web.internal\n  User ops\n  IdentityFile /keys/id\n')

    expect(await createCore().addSource(offline({ host: 'web', user: '', keyFile: '' }))).toMatchObject({ host: 'web', user: '', keyFile: '' })
  })

  it('keeps its password as an SSH Files Source does: kept by an edit leaving it blank, copied by Duplicate, forgotten by Delete', async () => {
    const dataDir = join(dir, 'user-data')
    const secrets = createSecretStore({ dataDir, cipher: { encrypt: (plain) => Buffer.from(plain, 'utf16le'), decrypt: (b) => b.toString('utf16le') } })
    const core = createCore({ dataDir, secrets })
    const password = (changes: Partial<NewSystemdJournalSource> = {}) => offline({ auth: 'password', keyFile: '', password: 'open sesame', ...changes })

    const source = await core.addSource(password())
    expect(source).toMatchObject({ passwordSet: true, passphraseSet: false })
    expect(await readFile(join(dataDir, 'sources.json'), 'utf8')).not.toContain('open sesame')
    expect(await core.editSource(source.id, password({ name: 'Renamed', password: '' }))).toMatchObject({ passwordSet: true })
    expect(await secrets.get(source.id, 'password')).toBe('open sesame')
    const copy = await core.duplicateSource(source.id)
    await core.deleteSource(source.id)

    expect(await secrets.get(copy.id, 'password')).toBe('open sesame')
    expect(await secrets.get(source.id, 'password')).toBeUndefined()
  })

  it('keeps a key file’s passphrase, and forgets its secret when it goes on to read this machine’s journal', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const secrets = plainSecrets()
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ passphrase: 'for the key' }))
    expect(source).toMatchObject({ passphraseSet: true })

    const edited = await core.editSource(source.id, { type: 'systemdJournal', name: 'Web', target: 'thisMachine' })

    expect(edited).toMatchObject({ target: 'thisMachine', passphraseSet: false, passwordSet: false })
    expect(await secrets.get(source.id, 'passphrase')).toBeUndefined()
  })
})

/** A hashed known_hosts line for a server's host key, as `HashKnownHosts` writes it. */
function knownHostsLine({ host, port, hostKey }: { host: string; port: number; hostKey: string }) {
  const salt = randomBytes(20)
  const hash = createHmac('sha1', salt).update(port === 22 ? host : `[${host}]:${port}`).digest()
  return `|1|${salt.toString('base64')}|${hash.toString('base64')} ${hostKey.trim()}\n`
}

const names = (nodes: TreeNode[]) => nodes.map((node) => ('name' in node ? node.name : node.kind))

/** Settings for a test server, signing in with its key. */
async function settingsFor(server: TestSshServer): Promise<NewSystemdJournalSource> {
  const keyFile = join(dir, `key-${randomBytes(4).toString('hex')}`)
  await writeFile(keyFile, server.clientKey)
  return { type: 'systemdJournal', name: 'Web', target: 'ssh', host: server.host, port: server.port, user: server.user, auth: 'keyFile', keyFile }
}

/** A test server whose host key is in known_hosts, running `exec`'s commands. */
async function trustedServer(exec?: (command: string) => TestCommand | undefined) {
  const server = await startTestSshServer(exec && { exec })
  started.push(server)
  await writeFile(join(home, '.ssh', 'known_hosts'), knownHostsLine(server))
  return server
}

/** A Connected systemd Journal Source on a test server with the stand-in journal. */
async function connected() {
  const journal = standInJournal()
  const server = await trustedServer(journal.exec)
  const core = createCore()
  const source = await core.addSource(await settingsFor(server))
  const root = await core.connect(source.id)
  return { core, source, server, journal, root }
}

const updatesOf = (events: FollowEvent[], followId: string) =>
  events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [e.kind === 'ended' ? `<ended: ${e.reason}>` : `<${e.kind}>`]))

describe('a systemd Journal Source on a host over SSH', () => {
  it('lists the host’s units with their states, failed first, and reads a unit’s journal', async () => {
    const { core, source, root } = await connected()

    expect(root).toEqual([
      { kind: 'logStream', name: 'backup.service', path: 'backup.service', status: { reason: 'failed', health: 'failing', restarts: 0 }, systemd: { kind: 'unit', description: 'Nightly backup' } },
      { kind: 'logStream', name: 'nginx.service', path: 'nginx.service', status: { reason: 'active', health: 'healthy', restarts: 0 }, systemd: { kind: 'unit', description: 'A high performance web server' } }
    ])
    expect(await core.openLog(source.id, 'nginx.service', { lastNLines: 2 })).toMatchObject({ content: 'GET /\nERROR upstream timed out' })
    expect((await core.openLog(source.id, 'backup.service', { timestamps: true })).content).toBe('2026-10-13T10:00:04.000000Z CRIT giving up')
  })

  it('tests a connection by reading the journal, and offers an unknown host key to trust', async () => {
    const journal = standInJournal()
    const server = await startTestSshServer({ exec: journal.exec })
    started.push(server)
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const settings = await settingsFor(server)

    const failure = (await core.testConnection(settings).catch((error: unknown) => error)) as { code: string; hostKey: never }
    expect(failure).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKey: { host: server.host, port: server.port } })
    await core.trustHostKey(failure.hostKey)

    await expect(core.testConnection(settings)).resolves.toEqual({})
  })

  it('shares the host keys trusted for SSH Files, kept until the last Source on its host is deleted', async () => {
    const journal = standInJournal()
    const server = await startTestSshServer({ exec: journal.exec })
    started.push(server)
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const settings = await settingsFor(server)
    const files = await core.addSource({ type: 'sshFiles', name: 'Files', host: server.host, port: server.port, user: server.user, path: '/', keyFile: settings.keyFile })
    const failure = (await core.connect(files.id).catch((error: unknown) => error)) as { hostKey: never }
    await core.trustHostKey(failure.hostKey)
    const source = await core.addSource(settings)

    await core.deleteSource(files.id)
    expect(names(await core.connect(source.id))).toEqual(['backup.service', 'nginx.service'])
    await core.deleteSource(source.id)

    await expect(core.testConnection(settings)).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
  })

  it('says there’s no journal on a host without journalctl', async () => {
    const server = await trustedServer()

    await expect(createCore().testConnection(await settingsFor(server))).rejects.toMatchObject({ code: 'NO_JOURNAL', message: expect.stringContaining(server.host) })
  })

  it.each([
    ['csh', 'journalctl: Command not found.\n'],
    ['fish', 'fish: Unknown command: journalctl\n']
  ])('says there’s no journal when %s, the user’s shell, can’t find journalctl', async (_shell, stderr) => {
    const server = await trustedServer(() => ({ exitCode: 1, stderr }))

    await expect(createCore().testConnection(await settingsFor(server))).rejects.toMatchObject({ code: 'NO_JOURNAL' })
  })

  it('says to join the systemd-journal or adm group when the journal may not be read', async () => {
    const stderr = 'Hint: You are currently not seeing messages from other users and the system.\nNo journal files were opened due to insufficient permissions.\n'
    const server = await trustedServer((command) => ({ exitCode: argsOf(command)[0] === 'journalctl' ? 1 : 0, stderr }))

    await expect(createCore().testConnection(await settingsFor(server))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringMatching(/systemd-journal.*adm/)
    })
  })

  it('refuses a unit’s name that isn’t one before running anything with it', async () => {
    const { core, source, server } = await connected()
    const before = server.commands().length

    for (const path of ["nginx.service'; reboot; '", 'nginx.service $(reboot)', '--since=yesterday', 'nginx']) {
      await expect(core.openLog(source.id, path), path).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(server.commands().slice(before).filter((command) => !command.includes('_SYSTEMD_UNIT'))).toEqual([])
  })

  it('lists, reads and follows several units over one connection, which disconnecting closes, ending its Follows', async () => {
    const { core, source, server, journal } = await connected()
    const events: FollowEvent[] = []
    core.onFollowEvent((event) => events.push(event))

    const nginx = await core.followLog(source.id, 'nginx.service', { lastNLines: 1 })
    const backup = await core.followLog(source.id, 'backup.service', { lastNLines: 1 })
    await core.openLog(source.id, 'nginx.service')
    await core.expand(source.id, '')
    expect(nginx.content).toBe('ERROR upstream timed out')
    await vi.waitFor(() => expect(journal.following('nginx.service')).toBe(true))
    journal.log('nginx.service', 10, 'GET /health')
    await vi.waitFor(() => expect(updatesOf(events, nginx.followId)).toEqual(['GET /health']))
    expect(server.connectionCount()).toBe(1)

    await core.disconnect(source.id)

    expect(updatesOf(events, backup.followId)).toEqual(['<ended: disconnected>'])
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))
  })

  it('stops a unit’s journalctl when its Follow is stopped', async () => {
    const { core, source, journal } = await connected()
    const followed = await core.followLog(source.id, 'nginx.service', { lastNLines: 1 })
    await vi.waitFor(() => expect(journal.following('nginx.service')).toBe(true))

    await core.stopFollow(followed.followId)

    await vi.waitFor(() => expect(journal.following('nginx.service')).toBe(false))
  })
})

describe('a systemd Journal Source whose SSH connection drops', () => {
  it('connects again on the next action, staying Connected', async () => {
    const { core, source, server } = await connected()

    await server.dropConnections()
    expect(names(await core.expand(source.id, ''))).toEqual(['backup.service', 'nginx.service'])
    await server.dropConnections()
    expect(await core.openLog(source.id, 'nginx.service', { lastNLines: 1 })).toMatchObject({ content: 'ERROR upstream timed out' })
    expect(server.connectionCount()).toBe(1)
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('reads a unit’s journal again, connected afresh, when the connection drops partway through reading it', async () => {
    const { core, source, server, journal } = await connected()
    const stalled = journal.stallNextRead()

    const read = core.openLog(source.id, 'nginx.service')
    await stalled
    await server.dropConnections()

    expect(await read).toMatchObject({ content: 'started\nGET /\nERROR upstream timed out' })
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('ends a Follow over it, saying the connection dropped, and the unit can be followed again', async () => {
    const { core, source, server, journal } = await connected()
    const events: FollowEvent[] = []
    core.onFollowEvent((event) => events.push(event))
    const followed = await core.followLog(source.id, 'nginx.service', { lastNLines: 1 })

    await server.dropConnections()
    await vi.waitFor(() => expect(updatesOf(events, followed.followId)).toEqual(['<ended: connectionLost>']))
    const again = await core.followLog(source.id, 'nginx.service', { lastNLines: 1 })
    await vi.waitFor(() => expect(journal.following('nginx.service')).toBe(true))
    journal.log('nginx.service', 11, 'back again')
    await vi.waitFor(() => expect(updatesOf(events, again.followId)).toEqual(['back again']))
  })

  it('goes to Error when connecting again fails', async () => {
    const { core, source, server } = await connected()

    await server.close()
    started.splice(started.indexOf(server), 1)

    await expect(core.expand(source.id, '')).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'UNREACHABLE' })
  })
})
