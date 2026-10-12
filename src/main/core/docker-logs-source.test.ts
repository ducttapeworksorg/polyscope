import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, NewDockerLogsSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { writeDockerConfig } from './docker-test-config'
import { startTestDockerEngine, type TestContainer, type TestDockerEngine } from './docker-test-engine'
import { hasTestDocker, testCounter, testCrasher, testProject, testSyslog, testTicker, testTlsContext, testUnhealthy } from './docker-test-seed'
import { followTiming } from './log-follow'
import { startMutualTlsFront } from './test-network'

const settings = (changes: Partial<NewDockerLogsSource> = {}): NewDockerLogsSource => ({ type: 'dockerLogs', name: 'Laptop', ...changes })

let engine: TestDockerEngine | undefined

/** Starts a stand-in engine holding `containers`, and points DOCKER_HOST at it. */
async function engineWith(containers: TestContainer[] = []) {
  engine = await startTestDockerEngine(containers)
  vi.stubEnv('DOCKER_HOST', engine.host)
  return engine
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await engine?.close()
  engine = undefined
})

describe('adding a Docker Logs Source', () => {
  it('is listed with the default context unless it names one, signing in to an ssh:// one with the SSH agent unless told', async () => {
    const core = createCore()

    const added = await core.addSource(settings())

    const expected = { id: added.id, type: 'dockerLogs', name: 'Laptop', context: 'default', auth: 'agent', keyFile: '', passphraseSet: false, passwordSet: false }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('can be saved while its engine is away', async () => {
    vi.stubEnv('DOCKER_HOST', 'unix:///nowhere/docker.sock')

    await expect(createCore().addSource(settings())).resolves.toMatchObject({ context: 'default' })
  })

  it('tests a connection by reaching the engine, which tells its version', async () => {
    const { version } = await engineWith()

    expect(await createCore().testConnection(settings())).toEqual({ serverVersion: `Docker Engine ${version}` })
  })

  it('fails when the engine is not running', async () => {
    vi.stubEnv('DOCKER_HOST', 'unix:///nowhere/docker.sock')

    await expect(createCore().testConnection(settings())).rejects.toMatchObject({ code: 'UNREACHABLE', message: expect.stringContaining('Docker isn’t running') })
  })

  // Root may use any socket, and Windows' named pipes have no mode to take away.
  it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('says to join the docker group when its socket may not be used', async () => {
    const { host } = await engineWith()
    await chmod(host.slice('unix://'.length), 0o000)

    await expect(createCore().testConnection(settings())).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('docker group') })
  })
})

describe('Docker contexts', () => {
  it('lists the Docker CLI’s contexts by name, with their endpoints, marking its current one', async () => {
    vi.stubEnv('DOCKER_CONFIG', await writeDockerConfig({
      currentContext: 'podman',
      contexts: [
        { name: 'remote', host: 'tcp://docker.internal:2376', description: 'The build box' },
        { name: 'podman', host: 'unix:///run/user/1000/podman/podman.sock' }
      ]
    }))

    expect(await createCore().listDockerContexts()).toEqual([
      { name: 'podman', host: 'unix:///run/user/1000/podman/podman.sock', current: true },
      { name: 'remote', host: 'tcp://docker.internal:2376', current: false }
    ])
  })

  it('lists none without a Docker CLI config folder', async () => {
    vi.stubEnv('DOCKER_CONFIG', join(tmpdir(), 'polyscope-no-docker-config'))

    expect(await createCore().listDockerContexts()).toEqual([])
  })

  /** Starts a stand-in engine holding `counter`, with DOCKER_HOST unset and DOCKER_CONFIG holding `contexts`. */
  async function engineInContexts(contexts: (host: string) => Parameters<typeof writeDockerConfig>[0]) {
    engine = await startTestDockerEngine([{ name: 'counter' }])
    vi.stubEnv('DOCKER_HOST', '')
    vi.stubEnv('DOCKER_CONTEXT', '')
    vi.stubEnv('DOCKER_CONFIG', await writeDockerConfig(contexts(engine.host)))
    return engine
  }

  /** The standalone containers of the engine a Source reaches with `changes`: the stand-in's `counter` alone, if it's that one. */
  async function standaloneReached(changes: Partial<NewDockerLogsSource> = {}) {
    const core = createCore()
    const source = await core.addSource(settings(changes))
    await core.connect(source.id)
    return names(await core.expand(source.id, '_standalone'))
  }

  it('reaches the engine of the context a Source names', async () => {
    const { version } = await engineInContexts((host) => ({ contexts: [{ name: 'podman', host }] }))
    const core = createCore()

    expect(await core.testConnection(settings({ context: 'podman' }))).toEqual({ serverVersion: `Docker Engine ${version}` })
    const source = await core.addSource(settings({ context: 'podman' }))
    expect(names(await core.connect(source.id))).toEqual(['_standalone'])
  })

  it('follows the CLI’s current context by default', async () => {
    await engineInContexts((host) => ({ currentContext: 'podman', contexts: [{ name: 'podman', host }] }))

    expect(await standaloneReached()).toEqual(['counter'])
  })

  it('follows DOCKER_CONTEXT over the current context by default, as the CLI does', async () => {
    await engineInContexts((host) => ({ currentContext: 'away', contexts: [{ name: 'podman', host }, { name: 'away', host: 'unix:///nowhere/docker.sock' }] }))
    vi.stubEnv('DOCKER_CONTEXT', 'podman')

    expect(await standaloneReached()).toEqual(['counter'])
  })

  it('follows DOCKER_HOST over any context by default, as the CLI does', async () => {
    const { host } = await engineInContexts(() => ({ currentContext: 'away', contexts: [{ name: 'away', host: 'unix:///nowhere/docker.sock' }] }))
    vi.stubEnv('DOCKER_CONTEXT', 'away')
    vi.stubEnv('DOCKER_HOST', host)

    expect(await standaloneReached()).toEqual(['counter'])
  })

  it('fails for a context the CLI doesn’t know', async () => {
    await engineInContexts(() => ({}))

    await expect(createCore().testConnection(settings({ context: 'gone' }))).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND', message: expect.stringContaining('gone') })
  })

  describe('over TCP with TLS', () => {
    let front: Awaited<ReturnType<typeof startMutualTlsFront>> | undefined

    afterEach(async () => {
      await front?.close()
      front = undefined
    })

    /** The stand-in engine holding `counter` served over TLS, asking for a client certificate, as `dockerd --tlsverify` serves it. */
    async function tlsEngine(contexts: (tls: { host: string; ca: string; cert: string; key: string }) => Parameters<typeof writeDockerConfig>[0]) {
      engine = await startTestDockerEngine([{ name: 'counter' }])
      front = await startMutualTlsFront(engine.socketPath)
      const { port, ca, cert, key } = front
      vi.stubEnv('DOCKER_HOST', '')
      vi.stubEnv('DOCKER_CONTEXT', '')
      vi.stubEnv('DOCKER_CONFIG', await writeDockerConfig(contexts({ host: `tcp://127.0.0.1:${port}`, ca, cert, key })))
      return front
    }

    it('reaches a context’s engine with the context’s CA, certificate and key', async () => {
      await tlsEngine(({ host, ca, cert, key }) => ({ contexts: [{ name: 'secure', host, tls: { ca, cert, key } }] }))

      expect(await standaloneReached({ context: 'secure' })).toEqual(['counter'])
    })

    it('reaches DOCKER_HOST’s engine with DOCKER_CERT_PATH’s CA, certificate and key when DOCKER_TLS_VERIFY is set', async () => {
      const { port, ca, cert, key } = await tlsEngine(() => ({}))
      const certs = await mkdtemp(join(tmpdir(), 'polyscope-docker-certs-'))
      await Promise.all(Object.entries({ ca, cert, key }).map(([name, pem]) => writeFile(join(certs, `${name}.pem`), pem)))
      vi.stubEnv('DOCKER_HOST', `tcp://127.0.0.1:${port}`)
      vi.stubEnv('DOCKER_TLS_VERIFY', '1')
      vi.stubEnv('DOCKER_CERT_PATH', certs)

      expect(await standaloneReached()).toEqual(['counter'])
    })

    it('fails, as the CLI does, when DOCKER_TLS_VERIFY is set and DOCKER_CERT_PATH has no CA', async () => {
      const { port } = await tlsEngine(() => ({}))
      vi.stubEnv('DOCKER_HOST', `tcp://127.0.0.1:${port}`)
      vi.stubEnv('DOCKER_TLS_VERIFY', '1')
      vi.stubEnv('DOCKER_CERT_PATH', await mkdtemp(join(tmpdir(), 'polyscope-docker-certs-')))

      await expect(createCore().testConnection(settings())).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE', message: expect.stringContaining('ca.pem') })
    })

    it('says the engine’s certificate isn’t trusted when the context has no CA for it', async () => {
      await tlsEngine(({ host, cert, key }) => ({ contexts: [{ name: 'secure', host, tls: { cert, key } }] }))

      await expect(createCore().testConnection(settings({ context: 'secure' }))).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
    })

    it('fails to reach an engine that asks for a certificate the context lacks', async () => {
      await tlsEngine(({ host, ca }) => ({ contexts: [{ name: 'secure', host, tls: { ca } }] }))

      await expect(createCore().testConnection(settings({ context: 'secure' }))).rejects.toMatchObject({ code: 'UNREACHABLE', message: expect.stringContaining('client certificate') })
    })
  })

  it('reaches an engine over TCP without TLS when the context has none', async () => {
    engine = await startTestDockerEngine([{ name: 'counter' }])
    const server = createServer((socket) => socket.pipe(connect(engine!.socketPath)).pipe(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('DOCKER_CONTEXT', '')
    vi.stubEnv('DOCKER_HOST', `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`)

    try {
      expect(await standaloneReached()).toEqual(['counter'])
    } finally {
      server.close()
    }
  })

  it('cannot reach an engine through a host it doesn’t know how to reach', async () => {
    await engineInContexts(() => ({ contexts: [{ name: 'systemd', host: 'fd://' }] }))

    await expect(createCore().testConnection(settings({ context: 'systemd' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCKER_HOST', message: 'fd://' })
  })
})

const compose = (project: string, service: string) => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service })

/** A time a few seconds into the test's morning, with nanoseconds, as the engine timestamps lines. */
const at = (second: number, nanos = 0) => `2026-10-12T10:00:${String(second).padStart(2, '0')}.${String(nanos).padStart(9, '0')}Z`

/** The names of listed nodes; a node without one by its kind. */
const names = (nodes: TreeNode[]) => nodes.map((node) => ('name' in node ? node.name : node.kind))

/** Connects a Docker Logs Source to the stand-in engine, holding `containers`. */
async function connected(containers: TestContainer[]) {
  await engineWith(containers)
  const core = createCore()
  const source = await core.addSource(settings())
  const root = await core.connect(source.id)
  return { core, sourceId: source.id, root }
}

describe('the tree of a Docker Logs Source', () => {
  const shop: TestContainer[] = [
    { name: 'shop-worker-2', labels: compose('shop', 'worker'), state: 'exited' },
    { name: 'shop-web-1', labels: compose('shop', 'web') },
    { name: 'shop-worker-1', labels: compose('shop', 'worker') },
    { name: 'blog-app-1', labels: compose('blog', 'app') },
    { name: 'redis' },
    { name: 'scratch', state: 'exited' }
  ]

  it('has a group per Compose project, then one for the containers outside Compose, which never folds', async () => {
    const { root } = await connected(shop)

    expect(root.map((node) => [names([node])[0], node.kind === 'group' && node.docker?.kind])).toEqual([
      ['blog', 'project'],
      ['shop', 'project'],
      ['_standalone', 'standalone']
    ])
    expect(root[2]).toMatchObject({ path: '_standalone', unfoldable: true })
    expect(root[2]).not.toHaveProperty('folded')
  })

  it('lists a project’s services, then a service’s containers, stopped ones too', async () => {
    const { core, sourceId } = await connected(shop)

    expect((await core.expand(sourceId, 'shop')).map((node) => node.path)).toEqual(['shop/web', 'shop/worker'])
    expect(await core.expand(sourceId, 'shop/worker')).toMatchObject([
      { kind: 'logStream', name: 'shop-worker-1', path: 'shop/worker/shop-worker-1', status: { reason: 'Running' }, docker: { kind: 'container' } },
      { kind: 'logStream', name: 'shop-worker-2', path: 'shop/worker/shop-worker-2', status: { reason: 'Exited (0)' }, docker: { kind: 'container' } }
    ])
    expect(names(await core.expand(sourceId, '_standalone'))).toEqual(['redis', 'scratch'])
  })

  it('folds a service’s only container into it, and a project’s only service, the paths kept whole', async () => {
    const { core, sourceId, root } = await connected(shop)

    const container = { kind: 'logStream', name: 'blog-app-1', path: 'blog/app/blog-app-1', status: expect.anything(), docker: expect.objectContaining({ kind: 'container' }) }
    expect(root[0]).toEqual({
      kind: 'group',
      name: 'blog',
      path: 'blog',
      docker: { kind: 'project' },
      folded: { kind: 'group', name: 'app', path: 'blog/app', docker: { kind: 'service' }, folded: container }
    })
    const [web, worker] = await core.expand(sourceId, 'shop')
    expect(web).toMatchObject({ folded: { path: 'shop/web/shop-web-1' } })
    expect(worker).not.toHaveProperty('folded')
  })

  it('puts a container under Standalone when its Compose labels could not be a path', async () => {
    const { core, sourceId, root } = await connected([{ name: 'odd', labels: compose('a/b', 'web') }])

    expect(root.map((node) => node.path)).toEqual(['_standalone'])
    expect(names(await core.expand(sourceId, '_standalone'))).toEqual(['odd'])
  })

  it('shows new containers when a group is expanded again', async () => {
    const { core, sourceId } = await connected(shop)

    engine!.add({ name: 'shop-worker-3', labels: compose('shop', 'worker') })

    expect(names(await core.expand(sourceId, 'shop/worker'))).toEqual(['shop-worker-1', 'shop-worker-2', 'shop-worker-3'])
  })

  it('has an empty root when the engine has no containers', async () => {
    const { root } = await connected([])

    expect(root).toEqual([])
  })
})

describe('Container Status in the tree', () => {
  it('shows how each container is doing, its restarts once it has restarted, its image, and when it started or exited', async () => {
    const { core, sourceId } = await connected([
      { name: 'api', image: 'nginx:1.27', startedAt: at(1) },
      { name: 'crasher', state: 'restarting', exitCode: 1, restartCount: 3, startedAt: at(2), finishedAt: at(3) },
      { name: 'done', state: 'exited', exitCode: 2, startedAt: at(1), finishedAt: at(4) },
      { name: 'sick', health: 'unhealthy', startedAt: at(1) }
    ])

    expect(await core.expand(sourceId, '_standalone')).toEqual([
      {
        kind: 'logStream',
        name: 'api',
        path: '_standalone/api',
        status: { reason: 'Running', health: 'healthy', restarts: 0 },
        docker: { kind: 'container', image: 'nginx:1.27', startedAt: Date.parse(at(1)) }
      },
      {
        kind: 'logStream',
        name: 'crasher',
        path: '_standalone/crasher',
        restarts: 3,
        status: { reason: 'Restarting', health: 'failing', restarts: 3, lastRestart: Date.parse(at(3)) },
        docker: { kind: 'container', image: 'busybox:1.36', startedAt: Date.parse(at(2)) }
      },
      {
        kind: 'logStream',
        name: 'done',
        path: '_standalone/done',
        status: { reason: 'Exited (2)', health: 'failing', restarts: 0 },
        docker: { kind: 'container', image: 'busybox:1.36', startedAt: Date.parse(at(1)), finishedAt: Date.parse(at(4)) }
      },
      {
        kind: 'logStream',
        name: 'sick',
        path: '_standalone/sick',
        status: { reason: 'Unhealthy', health: 'failing', restarts: 0 },
        docker: { kind: 'container', image: 'busybox:1.36', startedAt: Date.parse(at(1)) }
      }
    ])
  })

  it('carries a folded container’s Container Status into the row standing in for it', async () => {
    const { root } = await connected([{ name: 'blog-app-1', labels: compose('blog', 'app'), state: 'exited', exitCode: 1 }])

    expect(root[0]).toMatchObject({ folded: { folded: { name: 'blog-app-1', status: { reason: 'Exited (1)', health: 'failing' } } } })
  })
})

describe('opening a container’s log', () => {
  const app: TestContainer = {
    name: 'app',
    logs: [
      { stream: 'stdout', time: at(1), text: 'starting' },
      { stream: 'stderr', time: at(2), text: 'warning: no config' },
      { stream: 'stdout', time: at(3), text: 'listening on :8080' },
      { stream: 'stderr', time: at(4, 500), text: 'error: bad request' }
    ]
  }

  it('shows stdout and stderr together, in the order they were written, with no Previous Log to switch to', async () => {
    const { core, sourceId } = await connected([app])

    expect(await core.openLog(sourceId, '_standalone/app')).toEqual({
      view: 'log',
      of: 'logStream',
      path: '_standalone/app',
      name: 'app',
      offersPreviousLog: false,
      previous: false,
      restarted: false,
      lastNLines: 10_000,
      timestamps: false,
      content: 'starting\nwarning: no config\nlistening on :8080\nerror: bad request'
    })
  })

  it('shows only the last N lines, with when each was logged when asked', async () => {
    const { core, sourceId } = await connected([app])

    const log = await core.openLog(sourceId, '_standalone/app', { lastNLines: 2, timestamps: true })

    expect(log.content).toBe(`${at(3)} listening on :8080\n${at(4, 500)} error: bad request`)
  })

  it('reads the whole log', async () => {
    const { core, sourceId } = await connected([app])

    expect((await core.openLog(sourceId, '_standalone/app', { lastNLines: 'all' })).content.split('\n')).toHaveLength(4)
  })

  it('reads a TTY container’s log as it was written', async () => {
    const { core, sourceId } = await connected([{ ...app, name: 'shell', tty: true }])

    expect((await core.openLog(sourceId, '_standalone/shell')).content).toBe('starting\nwarning: no config\nlistening on :8080\nerror: bad request')
  })

  it('reads a stopped container’s log', async () => {
    const { core, sourceId } = await connected([{ ...app, state: 'exited' }])

    expect((await core.openLog(sourceId, '_standalone/app')).content).toContain('error: bad request')
  })

  it('has no Previous Log to open', async () => {
    const { core, sourceId } = await connected([app])

    await expect(core.openLog(sourceId, '_standalone/app', { previous: true })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
  })

  it('says the log can’t be read back when its log driver sends it elsewhere, naming the driver', async () => {
    const { core, sourceId } = await connected([{ ...app, name: 'shipped', logDriver: 'syslog' }])

    const unavailable = { code: 'LOG_UNAVAILABLE', message: expect.stringContaining('syslog') }
    await expect(core.openLog(sourceId, '_standalone/shipped')).rejects.toMatchObject(unavailable)
    await expect(core.followLog(sourceId, '_standalone/shipped')).rejects.toMatchObject(unavailable)
  })

  it('reports a container removed since it was listed', async () => {
    const { core, sourceId } = await connected([app])

    await expect(core.openLog(sourceId, '_standalone/gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

/** Collects every Follow update the core sends, by followId. */
function followUpdates(core: Core) {
  const events: FollowEvent[] = []
  const unsubscribe = core.onFollowEvent((event) => events.push(event))
  const of = (followId: string) => events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [e.kind]))
  return { events, of, unsubscribe }
}

describe('following a container’s log', () => {
  // Looks at a container between runs often, so a restart or exit is noticed at once.
  const { pollInterval } = followTiming
  beforeEach(() => void (followTiming.pollInterval = 20))
  afterEach(() => void (followTiming.pollInterval = pollInterval))

  const app: TestContainer = { name: 'app', logs: [1, 2, 3].map((i) => ({ stream: 'stdout' as const, time: at(i), text: `line ${i}` })) }

  it('starts from the last N lines, then adds lines as they are written, stdout and stderr alike', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)

    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 2 })
    engine!.log('app', 'line 4')
    engine!.log('app', 'oops', 'stderr')

    expect(followed).toMatchObject({ content: 'line 2\nline 3', offersPreviousLog: false })
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['line 4', 'oops']))
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })

  it('holds lines back while paused, and sends them once resumed', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    await core.pauseFollow(followed.followId)
    engine!.log('app', 'line 4')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(updates.of(followed.followId)).toEqual([])

    await core.resumeFollow(followed.followId)
    expect(updates.of(followed.followId)).toEqual(['line 4'])
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })

  it('ends when the container stops', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    engine!.log('app', 'bye')
    engine!.stop('app')

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['bye', 'ended']))
    expect(updates.events.at(-1)).toMatchObject({ kind: 'ended', reason: 'exited' })
    updates.unsubscribe()
  })

  it('marks a restart, then follows the new run from its start', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    engine!.log('app', 'last words')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['last words']))
    engine!.restart('app')
    engine!.log('app', 'back up')

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['last words', 'restarted', 'back up']))
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })

  it('waits while the engine restarts a crashed container, then follows its next run', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    engine!.log('app', 'last words')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['last words']))
    engine!.crash('app')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['last words', 'restarted']))
    await new Promise((resolve) => setTimeout(resolve, 100))
    engine!.start('app')
    engine!.log('app', 'back up')

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['last words', 'restarted', 'back up']))
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })

  it('marks no restart from before it was followed, and ends when the container exits for good', async () => {
    const { core, sourceId } = await connected([{ ...app, restartCount: 2 }])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    engine!.stop('app', 1)

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['ended']))
    expect(followed).toMatchObject({ offersPreviousLog: false, restarted: false })
    updates.unsubscribe()
  })

  it('ends, saying the container is gone, when it is removed', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    engine!.log('app', 'bye')
    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['bye']))
    engine!.remove('app')

    await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['bye', 'ended']))
    expect(updates.events.at(-1)).toMatchObject({ kind: 'ended', reason: 'gone' })
    await expect(core.openLog(sourceId, '_standalone/app')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    updates.unsubscribe()
  })

  it('ends when the Source is disconnected', async () => {
    const { core, sourceId } = await connected([app])
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, '_standalone/app', { lastNLines: 1 })

    await core.disconnect(sourceId)

    expect(updates.events).toEqual([{ followId: followed.followId, kind: 'ended', reason: 'disconnected' }])
    updates.unsubscribe()
  })
})

describe.skipIf(!hasTestDocker)('Docker Logs against the test engine', () => {
  let core: Core
  let sourceId: string
  let root: TreeNode[]

  beforeEach(async () => {
    core = createCore()
    sourceId = (await core.addSource(settings())).id
    root = await core.connect(sourceId)
  })

  afterEach(() => core.disconnect(sourceId))

  it('tests a connection, telling the engine’s version', async () => {
    expect(await core.testConnection(settings())).toEqual({ serverVersion: expect.stringMatching(/^Docker Engine \d+\.\d+/) })
  })

  it('lists the Compose project’s services, folding the one of one container, and the standalone containers, stopped ones too', async () => {
    expect(names(root)).toEqual(expect.arrayContaining([testProject, '_standalone']))
    const services = await core.expand(sourceId, testProject)
    expect(names(services)).toEqual(['console', 'web', 'worker'])
    expect(services[1]).toMatchObject({ folded: { kind: 'logStream', path: `${testProject}/web/${testProject}-web-1` } })
    expect(names(await core.expand(sourceId, `${testProject}/worker`))).toEqual([`${testProject}-worker-1`, `${testProject}-worker-2`])
    expect(names(await core.expand(sourceId, '_standalone'))).toEqual(expect.arrayContaining(['polyscope-counter', 'polyscope-done', 'polyscope-ticker']))
  })

  it('shows stdout and stderr together, in the order they were written', async () => {
    const log = await core.openLog(sourceId, `${testProject}/worker/${testProject}-worker-1`)

    expect(log.content).toBe('out 1\nerr 1\nout 2\nerr 2\nout 3\nerr 3')
  })

  it('reads a TTY container’s log as it was written', async () => {
    const log = await core.openLog(sourceId, `${testProject}/console/${testProject}-console-1`)

    expect(log.content).toBe('console ready\r')
  })

  it('reads the last N lines of a stopped container’s log', async () => {
    expect((await core.openLog(sourceId, '_standalone/polyscope-done', { lastNLines: 1 })).content).toBe('all done')
  })

  it('reads the last N lines with timestamps', async () => {
    const log = await core.openLog(sourceId, testCounter, { lastNLines: 2, timestamps: true })

    expect(log.content).toMatch(/^\S+Z line 99\n\S+Z line 100$/)
  })

  it('shows each container’s Container Status: an exited one’s exit code, a failing healthcheck, a crash loop’s restarts', async () => {
    const containers = await core.expand(sourceId, '_standalone')
    const statusOf = (path: string) => containers.find((node) => node.path === path)

    expect(statusOf('_standalone/polyscope-done')).toMatchObject({ status: { reason: 'Exited (0)' }, docker: { image: 'busybox:1.36', finishedAt: expect.any(Number) } })
    expect(statusOf(testUnhealthy)).toMatchObject({ status: { reason: 'Unhealthy', health: 'failing' } })
    expect(statusOf(testCounter)).toMatchObject({ status: { reason: 'Running', health: 'healthy', restarts: 0 }, docker: { startedAt: expect.any(Number) } })
    expect(statusOf(testCounter)).not.toHaveProperty('restarts')
    expect(statusOf(testCrasher)).toMatchObject({ restarts: expect.any(Number), status: { reason: expect.stringMatching(/^(Running|Restarting)$/) } })
  })

  it('says the log can’t be read back from a container logging to syslog', async () => {
    await expect(core.openLog(sourceId, testSyslog)).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE', message: expect.stringContaining('syslog') })
  })

  it('marks a crash-looping container’s restart, then follows its next run', async () => {
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, testCrasher, { lastNLines: 1 })

    await vi.waitFor(() => expect(updates.of(followed.followId).join('\n')).toMatch(/restarted\n(.*\n)*run started/), { timeout: 40_000, interval: 500 })
    updates.unsubscribe()
  }, 45_000)

  it('follows a log as lines are written', async () => {
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, testTicker, { lastNLines: 1 })

    const tick = Number(/tick (\d+)/.exec(followed.content)![1])
    await vi.waitFor(() => expect(updates.of(followed.followId)).toContain(`tick ${tick + 2}`), { timeout: 10_000 })
    expect(updates.of(followed.followId).slice(0, 2)).toEqual([`tick ${tick + 1}`, `tick ${tick + 2}`])
    updates.unsubscribe()
  })
})

describe.skipIf(!hasTestDocker || !testTlsContext)('Docker Logs against the test engine through a TLS context', () => {
  it('tests a connection and reads a log through the context’s TLS front', async () => {
    const core = createCore()
    const tls = settings({ context: testTlsContext })
    expect(await core.testConnection(tls)).toEqual({ serverVersion: expect.stringMatching(/^Docker Engine \d+\.\d+/) })
    const { id } = await core.addSource(tls)
    await core.connect(id)

    expect((await core.openLog(id, testCounter, { lastNLines: 1 })).content).toBe('line 100')
    await core.disconnect(id)
  })
})
