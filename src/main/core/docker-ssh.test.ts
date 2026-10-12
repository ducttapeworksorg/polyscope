import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { FollowEvent, NewDockerLogsSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { dockerConfigDir } from './docker-contexts'
import { writeDockerConfig } from './docker-test-config'
import { hasTestDocker, testCounter, testSshContext, testTicker } from './docker-test-seed'
import { startTestDockerEngine, type TestContainer, type TestDockerEngine } from './docker-test-engine'
import { followTiming } from './log-follow'
import { startTestSshAgent, startTestSshServer, type TestCommand, type TestSshAgent, type TestSshServer } from './ssh-test-server'

/** The Docker CLI's own config folder, which holds the test engine's contexts, from before the tests' own HOME is set. */
const realDockerConfig = dockerConfigDir(process.env)

let dir: string
let home: string
/** What a test started, to stop after it. */
const started: (TestSshServer | TestSshAgent | TestDockerEngine)[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-docker-ssh-'))
  // A home of the test's own, so the user's real ~/.ssh is never read.
  home = join(dir, 'home')
  await mkdir(join(home, '.ssh'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('DOCKER_HOST', '')
  vi.stubEnv('DOCKER_CONTEXT', '')
  vi.stubEnv('SSH_AUTH_SOCK', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(started.splice(0).map((s) => s.close()))
  await rm(dir, { recursive: true, force: true })
})

/** The command the Docker CLI runs on an `ssh://` context's host to reach its engine. */
const dialStdio = 'docker system dial-stdio'

/**
 * A stand-in engine holding `containers`, on a host reached over SSH whose `docker system dial-stdio` reaches it (unless
 * `docker` says otherwise), and a Docker context, `box`, for it. The host's key is known, in ~/.ssh/known_hosts, unless not `known`.
 */
async function engineOverSsh(
  containers: TestContainer[] = [],
  { docker, known = true, password }: { docker?: TestCommand; known?: boolean; password?: string } = {}
) {
  const engine = await startTestDockerEngine(containers)
  started.push(engine)
  const server = await startTestSshServer({
    ...(password && { password }),
    exec: (command) => (command === dialStdio ? (docker ?? { socketPath: engine.socketPath }) : undefined)
  })
  started.push(server)
  if (known) await writeFile(join(home, '.ssh', 'known_hosts'), `[${server.host}]:${server.port} ${server.hostKey}\n`)
  vi.stubEnv('DOCKER_CONFIG', await writeDockerConfig({ contexts: [{ name: 'box', host: `ssh://${server.user}@${server.host}:${server.port}` }] }))
  const keyFile = join(dir, 'id_ed25519')
  await writeFile(keyFile, server.clientKey)
  return { engine, server, keyFile }
}

/** Settings for a Docker Logs Source reaching `box`, signing in with `keyFile`. */
const settings = (keyFile: string, changes: Partial<NewDockerLogsSource> = {}): NewDockerLogsSource => ({
  type: 'dockerLogs',
  name: 'Box',
  context: 'box',
  auth: 'keyFile',
  keyFile,
  ...changes
})

const names = (nodes: TreeNode[]) => nodes.map((node) => ('name' in node ? node.name : node.kind))

/** A time a few seconds into the test's morning, with nanoseconds, as the engine timestamps lines. */
const at = (second: number) => `2026-10-12T10:00:${String(second).padStart(2, '0')}.000000000Z`

const app: TestContainer = { name: 'app', logs: [1, 2, 3].map((i) => ({ stream: 'stdout' as const, time: at(i), text: `line ${i}` })) }

/** A Docker Logs Source on `box`, connected, with the stand-in engine behind it holding `containers`. */
async function connected(containers: TestContainer[]) {
  const reached = await engineOverSsh(containers)
  const core = createCore()
  const source = await core.addSource(settings(reached.keyFile))
  const root = await core.connect(source.id)
  return { ...reached, core, sourceId: source.id, root }
}

/** Collects every Follow update the core sends, by followId. */
function followUpdates(core: Core) {
  const events: FollowEvent[] = []
  const unsubscribe = core.onFollowEvent((event) => events.push(event))
  const of = (followId: string) => events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [e.kind]))
  return { events, of, unsubscribe }
}

describe('a Docker Logs Source on an ssh:// context', () => {
  it('tests a connection by reaching the engine through the host, which tells its version', async () => {
    const { engine, keyFile } = await engineOverSsh()

    expect(await createCore().testConnection(settings(keyFile))).toEqual({ serverVersion: `Docker Engine ${engine.version}` })
  })

  it('is listed with how it signs in, and only whether a passphrase or password is stored', async () => {
    const core = createCore()

    const added = await core.addSource(settings('/keys/id', { passphrase: 'open sesame' }))

    expect(added).toEqual({
      id: added.id,
      type: 'dockerLogs',
      name: 'Box',
      context: 'box',
      auth: 'keyFile',
      keyFile: '/keys/id',
      passphraseSet: true,
      passwordSet: false
    })
  })

  it('lists the engine’s containers, Container Status and all, and reads their logs', async () => {
    const { core, sourceId, root } = await connected([app, { name: 'done', state: 'exited', exitCode: 2 }])

    expect(names(root)).toEqual(['_standalone'])
    expect(await core.expand(sourceId, '_standalone')).toMatchObject([
      { name: 'app', status: { reason: 'Running' } },
      { name: 'done', status: { reason: 'Exited (2)' } }
    ])
    expect((await core.openLog(sourceId, '_standalone/app', { lastNLines: 2 })).content).toBe('line 2\nline 3')
  })

  it('follows a log, across a restart, until the container exits for good', async () => {
    // Looks at the container between runs often, so its restart and exit are noticed at once.
    const { pollInterval } = followTiming
    followTiming.pollInterval = 20
    onTestFinished(() => void (followTiming.pollInterval = pollInterval))
    const { core, sourceId, engine } = await connected([app])
    const updates = followUpdates(core)

    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })
    engine.log('app', 'line 4')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['line 4']))
    engine.restart('app')
    engine.log('app', 'back up')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['line 4', 'restarted', 'back up']))
    engine.stop('app', 1)

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['line 4', 'restarted', 'back up', 'ended']))
    expect(updates.events.at(-1)).toMatchObject({ kind: 'ended', reason: 'exited' })
    updates.unsubscribe()
  })

  it('lists many containers at once over the one connection', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` }))
    const { core, sourceId, server } = await connected(many)

    expect(await core.expand(sourceId, '_standalone')).toHaveLength(30)
    expect(server.connectionCount()).toBe(1)
  })

  it('signs in with the SSH agent, and with a password', async () => {
    const { server, keyFile } = await engineOverSsh([app], { password: 'hunter2' })
    const agent = await startTestSshAgent(server.clientKey)
    started.push(agent)
    vi.stubEnv('SSH_AUTH_SOCK', agent.path)
    const core = createCore()

    await expect(core.testConnection(settings(keyFile, { auth: 'agent' }))).resolves.toMatchObject({ serverVersion: expect.any(String) })
    const source = await core.addSource(settings('', { auth: 'password', password: 'hunter2' }))
    expect(names(await core.connect(source.id))).toEqual(['_standalone'])
  })

  it('signs in as ~/.ssh/config says for the host the context names', async () => {
    const { server, keyFile } = await engineOverSsh([app])
    await writeFile(join(home, '.ssh', 'config'), `Host box.example\n  HostName ${server.host}\n  Port ${server.port}\n  User ${server.user}\n  IdentityFile ${keyFile}\n`)
    await writeFile(join(home, '.ssh', 'known_hosts'), `[box.example]:${server.port} ${server.hostKey}\n[${server.host}]:${server.port} ${server.hostKey}\n`)
    vi.stubEnv('DOCKER_CONFIG', await writeDockerConfig({ contexts: [{ name: 'box', host: 'ssh://box.example' }] }))

    await expect(createCore().testConnection(settings('', { auth: 'keyFile' }))).resolves.toMatchObject({ serverVersion: expect.any(String) })
  })

  it('offers an unknown host key to trust, then connects once it’s trusted', async () => {
    const { server, keyFile } = await engineOverSsh([app], { known: false })
    const core = createCore({ dataDir: join(dir, 'user-data') })
    const source = await core.addSource(settings(keyFile))

    const failure = await core.connect(source.id).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKey: { host: server.host, port: server.port, keyType: 'ssh-ed25519' } })
    await core.trustHostKey((failure as { hostKey: Parameters<Core['trustHostKey']>[0] }).hostKey)

    expect(names(await core.connect(source.id))).toEqual(['_standalone'])
  })

  it('keeps the host key trusted for its host while it or an SSH Files Source still reaches it, and forgets it after', async () => {
    const { server, keyFile } = await engineOverSsh([app], { known: false })
    const dataDir = join(dir, 'user-data')
    const core = createCore({ dataDir })
    const docker = await core.addSource(settings(keyFile))
    const files = await core.addSource({ type: 'sshFiles', name: 'Files', host: server.host, port: server.port, user: server.user, path: '/', keyFile })
    const failure = (await core.connect(docker.id).catch((error: unknown) => error)) as { hostKey: Parameters<Core['trustHostKey']>[0] }
    await core.trustHostKey(failure.hostKey)

    await core.deleteSource(files.id)
    expect(names(await createCore({ dataDir }).connect(docker.id))).toEqual(['_standalone'])

    await core.deleteSource(docker.id)
    await expect(createCore({ dataDir }).testConnection(settings(keyFile))).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
  })

  it('says so when the host has no docker command', async () => {
    const { keyFile } = await engineOverSsh([], { docker: { exitCode: 127, stderr: 'bash: line 1: docker: command not found\n' } })

    await expect(createCore().testConnection(settings(keyFile))).rejects.toMatchObject({ code: 'DOCKER_NOT_FOUND', message: expect.stringContaining('127.0.0.1') })
  })

  it('says to join the docker group there when the user may not use the engine’s socket', async () => {
    const stderr = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied\n'
    const { keyFile } = await engineOverSsh([], { docker: { exitCode: 1, stderr } })

    await expect(createCore().testConnection(settings(keyFile))).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('docker group') })
  })

  it('says so when the host’s engine isn’t running', async () => {
    const stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'
    const { keyFile } = await engineOverSsh([], { docker: { exitCode: 1, stderr } })

    await expect(createCore().testConnection(settings(keyFile))).rejects.toMatchObject({ code: 'UNREACHABLE', message: expect.stringContaining('isn\'t running') })
  })

  it('connects again after its connection drops, ending its Follows', async () => {
    const { core, sourceId, server } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    await server.dropConnections()

    await vi.waitFor(() => expect(updates.events.at(-1)).toMatchObject({ followId: followed.followId, kind: 'ended', reason: 'connectionLost' }))
    expect(names(await core.expand(sourceId, '_standalone'))).toEqual(['app'])
    expect(await core.connectionState(sourceId)).toEqual({ state: 'connected' })
    updates.unsubscribe()
  })

  it('closes its SSH connection when disconnected', async () => {
    const { core, sourceId, server } = await connected([app])

    await core.disconnect(sourceId)

    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))
  })
})

// Each connection to the engine runs the docker command on the host, slow while the other test files keep the engine busy.
describe.skipIf(!hasTestDocker || !testSshContext)('a Docker Logs Source on an ssh:// context, against the test engine through OpenSSH', { timeout: 20_000 }, () => {
  /** A connected Source on the test's ssh:// context, signing in with its key, whose host key is known. */
  async function connectedToTestEngine() {
    const { name, dir: sshDir } = testSshContext!
    await writeFile(join(home, '.ssh', 'known_hosts'), await readFile(join(sshDir, 'known_hosts')))
    vi.stubEnv('DOCKER_CONFIG', realDockerConfig)
    const core = createCore()
    const source = await core.addSource(settings(join(sshDir, 'client_key'), { context: name }))
    return { core, sourceId: source.id, root: await core.connect(source.id) }
  }

  it('lists the seeded containers, and reads and follows their logs', async () => {
    const { core, sourceId, root } = await connectedToTestEngine()
    const updates = followUpdates(core)

    expect(names(root)).toContain('_standalone')
    expect((await core.openLog(sourceId, testCounter, { lastNLines: 1 })).content).toBe('line 100')
    const followed = await core.followLog(sourceId, testTicker, { lastNLines: 1 })
    await vi.waitFor(() => expect(updates.of(followed.followId).some((line) => line.startsWith('tick '))).toBe(true), { timeout: 5000 })
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })
})
