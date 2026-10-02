import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, LogNode, NewKubernetesLogsSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { kubeConfigFor } from './kubeconfig'
import { createKubernetesLogSource } from './kubernetes-log-source'
import { startTestApiServer } from './kubernetes-test-api-server'
import {
  counterLines,
  hasRestrictedContext,
  hasTestCluster,
  restrictedKubernetesLogsSource,
  testKubernetesLogsSource,
  tickerNamespace
} from './kubernetes-test-cluster'
import { startProxy } from './test-network'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-kube-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

/** A kubeconfig with a context per entry, each pointing at `server` with a token. */
function kubeconfig(contexts: { name: string; namespace?: string }[], { current = '', server = 'https://cluster.invalid' } = {}) {
  const lines = ['apiVersion: v1', 'kind: Config', `current-context: "${current}"`, 'clusters:']
  for (const { name } of contexts) lines.push(`- name: ${name}-cluster`, '  cluster:', `    server: ${server}`)
  lines.push('users:')
  for (const { name } of contexts) lines.push(`- name: ${name}-user`, '  user:', '    token: not-a-real-token')
  lines.push('contexts:')
  for (const { name, namespace } of contexts) {
    lines.push(`- name: ${name}`, '  context:', `    cluster: ${name}-cluster`, `    user: ${name}-user`)
    if (namespace) lines.push(`    namespace: ${namespace}`)
  }
  return lines.join('\n')
}

/** Points KUBECONFIG at files of the test's own, one per content given. */
async function kubeconfigFiles(...contents: string[]) {
  const files = await Promise.all(
    contents.map(async (content, i) => {
      const file = join(dir, `kubeconfig-${i}`)
      await writeFile(file, content)
      return file
    })
  )
  vi.stubEnv('KUBECONFIG', files.join(delimiter))
}

/** A local port nothing listens on. */
async function closedPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

const offline = (changes: Partial<NewKubernetesLogsSource> = {}): NewKubernetesLogsSource => ({
  type: 'kubernetesLogs',
  name: 'Cluster',
  context: 'dev',
  namespace: 'shop',
  ...changes
})

describe('kubeconfig contexts', () => {
  it('lists the contexts by name, with their namespace and which is current', async () => {
    await kubeconfigFiles(kubeconfig([{ name: 'prod', namespace: 'shop' }, { name: 'dev' }], { current: 'prod' }))

    expect(await createCore().listKubeContexts()).toEqual([
      { name: 'dev', current: false },
      { name: 'prod', namespace: 'shop', current: true }
    ])
  })

  it('merges the files KUBECONFIG names, the first to name a context or the current one winning', async () => {
    await kubeconfigFiles(
      kubeconfig([{ name: 'dev', namespace: 'first' }], { current: 'dev' }),
      kubeconfig([{ name: 'dev', namespace: 'second' }, { name: 'staging' }], { current: 'staging' })
    )

    expect(await createCore().listKubeContexts()).toEqual([
      { name: 'dev', namespace: 'first', current: true },
      { name: 'staging', current: false }
    ])
  })

  it('skips files KUBECONFIG names that are not there', async () => {
    const file = join(dir, 'kubeconfig')
    await writeFile(file, kubeconfig([{ name: 'dev' }]))
    vi.stubEnv('KUBECONFIG', [join(dir, 'missing'), file].join(delimiter))

    expect(await createCore().listKubeContexts()).toEqual([{ name: 'dev', current: false }])
  })

  it('lists none without a kubeconfig', async () => {
    vi.stubEnv('KUBECONFIG', join(dir, 'missing'))

    expect(await createCore().listKubeContexts()).toEqual([])
  })

  it('reports a kubeconfig it cannot read', async () => {
    await kubeconfigFiles('clusters: [unclosed')

    await expect(createCore().listKubeContexts()).rejects.toMatchObject({ code: 'KUBECONFIG_UNREADABLE' })
  })
})

describe('adding a Kubernetes Logs Source', () => {
  it('is listed with its context and namespace, trimmed', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ context: ' dev ', namespace: ' shop ' }))

    const expected = { id: added.id, type: 'kubernetesLogs', name: 'Cluster', context: 'dev', namespace: 'shop' }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('can be saved while its cluster is away or its context not yet in the kubeconfig', async () => {
    vi.stubEnv('KUBECONFIG', join(dir, 'missing'))

    await expect(createCore().addSource(offline({ context: 'later' }))).resolves.toMatchObject({ context: 'later' })
  })

  it('needs a context', async () => {
    await expect(createCore().addSource(offline({ context: ' ' }))).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' })
  })

  it('needs a namespace that could exist', async () => {
    const core = createCore()
    for (const namespace of ['', 'Shop', 'shop_1', '-shop', 'a'.repeat(64)]) {
      await expect(core.addSource(offline({ namespace }))).rejects.toMatchObject({ code: 'INVALID_NAMESPACE' })
    }
  })

  it('keeps the context and namespace when edited, and its group after the others', async () => {
    const core = createCore()
    const logs = await core.addSource(offline())
    await core.addSource({ type: 'local', name: 'Disk', rootPath: dir })

    await core.editSource(logs.id, offline({ name: 'Shop', namespace: 'orders' }))

    expect((await core.listSources()).map((s) => s.name)).toEqual(['Disk', 'Shop'])
    expect((await core.listSources())[1]).toMatchObject({ context: 'dev', namespace: 'orders' })
  })
})

describe('connecting a Kubernetes Logs Source', () => {
  it('fails when its context is not in the kubeconfig', async () => {
    await kubeconfigFiles(kubeconfig([{ name: 'prod' }]))
    const core = createCore()
    const source = await core.addSource(offline({ context: 'dev' }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'CONTEXT_NOT_FOUND' })
  })

  it('fails when the cluster cannot be reached', async () => {
    await kubeconfigFiles(kubeconfig([{ name: 'dev' }], { server: `https://127.0.0.1:${await closedPort()}` }))
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('tests a connection the same way, without saving anything', async () => {
    await kubeconfigFiles(kubeconfig([{ name: 'prod' }]))
    const core = createCore()

    await expect(core.testConnection(offline({ context: 'dev' }))).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' })
    expect(await core.listSources()).toEqual([])
  })
})

describe('Last N lines', () => {
  it('is left out until the user picks one', async () => {
    const source = await createCore().addSource(offline())

    expect(source).not.toHaveProperty('lastNLines')
  })

  it('is remembered per Source, across launches', async () => {
    const dataDir = join(dir, 'user-data')
    const core = createCore({ dataDir })
    const one = await core.addSource(offline({ name: 'One' }))
    const two = await core.addSource(offline({ name: 'Two' }))

    await core.rememberLastNLines(one.id, 50_000)
    await core.rememberLastNLines(two.id, 'all')

    const relaunched = await createCore({ dataDir }).listSources()
    expect(relaunched.map((s) => s.lastNLines)).toEqual([50_000, 'all'])
  })

  it('is forgotten with null, going back to the Settings default', async () => {
    const core = createCore()
    const source = await core.addSource(offline())
    await core.rememberLastNLines(source.id, 1_000)

    await core.rememberLastNLines(source.id, null)

    expect((await core.listSources())[0]).not.toHaveProperty('lastNLines')
  })

  it('outlives editing the Source, and comes along when it is duplicated', async () => {
    const core = createCore()
    const source = await core.addSource(offline())
    await core.rememberLastNLines(source.id, 1_000)

    await core.editSource(source.id, offline({ namespace: 'orders' }))
    await core.duplicateSource(source.id)

    expect((await core.listSources()).map((s) => s.lastNLines)).toEqual([1_000, 1_000])
  })

  it('does not disconnect the Source', async () => {
    const core = createCore()
    const local = await core.addSource({ type: 'local', name: 'Disk', rootPath: dir })
    await core.connect(local.id)

    await core.rememberLastNLines(local.id, 1_000)

    expect(await core.connectionState(local.id)).toEqual({ state: 'connected' })
  })

  it('must be a whole number of lines greater than zero, or all', async () => {
    const core = createCore()
    const source = await core.addSource(offline())
    for (const lines of [0, -5, 1.5, Number.NaN, 'some' as 'all']) {
      await expect(core.rememberLastNLines(source.id, lines)).rejects.toMatchObject({ code: 'INVALID_LINE_COUNT' })
    }
  })
})

describe('opening across Source kinds', () => {
  it('opens no log from a File Source', async () => {
    await writeFile(join(dir, 'a.log'), 'a')
    const core = createCore()
    const local = await core.addSource({ type: 'local', name: 'Disk', rootPath: dir })
    await core.connect(local.id)

    await expect(core.openLog(local.id, 'a.log')).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
  })

  it('opens no log from a Source that is not connected', async () => {
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.openLog(source.id, 'pods/counter/counter')).rejects.toMatchObject({ code: 'SOURCE_DISCONNECTED' })
  })
})

describe('a cluster behind a proxy', () => {
  // Only the proxy knows this name, so whatever reaches the cluster went through it.
  const host = 'kube.polyscope.test'
  let apiServer: Awaited<ReturnType<typeof startTestApiServer>>
  let proxy: Awaited<ReturnType<typeof startProxy>>
  let server: string

  beforeEach(async () => {
    apiServer = await startTestApiServer()
    proxy = await startProxy({ hosts: { [host]: '127.0.0.1' } })
    server = `https://${host}:${new URL(apiServer.url).port}`
    // Left alone by the proxy settings of wherever the tests run.
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(name, '')
  })

  afterEach(async () => {
    await proxy.close()
    await apiServer.close()
  })

  /** A kubeconfig whose context `fake` points at the stand-in API server by its made-up name, through `proxyUrl` if given. */
  const fakeCluster = (proxyUrl?: string) =>
    [
      'apiVersion: v1',
      'kind: Config',
      'current-context: fake',
      'clusters:',
      '- name: fake',
      '  cluster:',
      `    server: ${server}`,
      `    certificate-authority: ${JSON.stringify(apiServer.caPath)}`,
      // The stand-in's certificate is for localhost.
      '    tls-server-name: localhost',
      ...(proxyUrl ? [`    proxy-url: ${proxyUrl}`] : []),
      'users:',
      '- name: fake',
      '  user:',
      '    token: not-a-real-token',
      'contexts:',
      '- name: fake',
      '  context:',
      '    cluster: fake',
      '    user: fake'
    ].join('\n')

  const shop = offline({ context: 'fake', namespace: 'shop' })

  /** Connects to `shop`, opens counter's log and follows it until a new line comes, all of which has to get to the cluster. */
  async function reachesTheCluster() {
    const core = createCore()
    const source = await core.addSource(shop)
    const updates = followUpdates(core)
    try {
      expect(await core.connect(source.id)).toEqual([{ kind: 'group', workloadKind: 'Pod', name: 'pods', path: 'pods' }])
      expect((await core.openLog(source.id, 'pods/counter/counter')).content).toBe('line 1\nline 2\nline 3')
      const followed = await core.followLog(source.id, 'pods/counter/counter', { lastNLines: 1 })
      expect(followed.content).toBe('line 3')
      await vi.waitFor(() => expect(updates.of(followed.followId)).toEqual(['line 4']))
    } finally {
      await core.disconnect(source.id)
      updates.unsubscribe()
    }
    expect(proxy.tunnels).toContain(`${host}:${new URL(server).port}`)
  }

  it('is reached through the kubeconfig’s proxy-url', async () => {
    await kubeconfigFiles(fakeCluster(proxy.url))

    await reachesTheCluster()
  })

  it('is reached through the proxy-url over HTTPS_PROXY', async () => {
    await kubeconfigFiles(fakeCluster(proxy.url))
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${await closedPort()}`)

    await reachesTheCluster()
  })

  it('is reached through HTTPS_PROXY when the kubeconfig names no proxy', async () => {
    await kubeconfigFiles(fakeCluster())
    vi.stubEnv('HTTPS_PROXY', proxy.url)

    await reachesTheCluster()
  })

  it('is not reached through HTTPS_PROXY when NO_PROXY covers it', async () => {
    await kubeconfigFiles(fakeCluster())
    vi.stubEnv('HTTPS_PROXY', proxy.url)
    vi.stubEnv('NO_PROXY', 'localhost,.polyscope.test')
    const core = createCore()
    const source = await core.addSource(shop)

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(proxy.tunnels).toEqual([])
  })

  it('says which permission the user is missing when the cluster denies a request', async () => {
    await kubeconfigFiles(fakeCluster(proxy.url))
    const core = createCore()
    const source = await core.addSource(offline({ context: 'fake', namespace: 'locked' }))
    const missing = { code: 'MISSING_PERMISSION', message: 'list pods in namespace locked' }

    await expect(core.connect(source.id)).rejects.toMatchObject(missing)
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', ...missing })
  })
})

/** Nodes as `kind name`, with a container's role after it, e.g. `container proxy (sidecar)`. */
const described = (nodes: TreeNode[]) =>
  nodes.map((node) => {
    if (node.kind === 'error' || node.kind === 'more') return node.kind
    if (node.kind === 'container' && node.role) return `container ${node.name} (${node.role})`
    return node.kind === 'folder' || node.kind === 'file' ? node.name : `${node.kind} ${node.name}`
  })

/** The only pod under a path, e.g. a Workload with one replica. */
async function onlyPod(core: Core, sourceId: string, path: string) {
  const pods = (await core.expand(sourceId, path)) as LogNode[]
  expect(pods).toHaveLength(1)
  expect(pods[0]).toMatchObject({ kind: 'pod', path: `${path}/${pods[0]!.name}` })
  return pods[0]!
}

describe.skipIf(!hasTestCluster)('Kubernetes Logs against the test cluster', () => {
  let core: Core
  let sourceId: string

  beforeEach(async () => {
    core = createCore()
    sourceId = (await core.addSource(testKubernetesLogsSource())).id
  })

  describe('the tree', () => {
    it('groups the namespace by kind of Workload', async () => {
      const root = await core.connect(sourceId)

      expect(root).toEqual([
        { kind: 'group', workloadKind: 'Deployment', name: 'deployments', path: 'deployments' },
        { kind: 'group', workloadKind: 'StatefulSet', name: 'statefulsets', path: 'statefulsets' },
        { kind: 'group', workloadKind: 'DaemonSet', name: 'daemonsets', path: 'daemonsets' },
        { kind: 'group', workloadKind: 'CronJob', name: 'cronjobs', path: 'cronjobs' },
        { kind: 'group', workloadKind: 'Job', name: 'jobs', path: 'jobs' },
        { kind: 'group', workloadKind: 'Pod', name: 'pods', path: 'pods' }
      ])
    })

    it('lists Workloads by name, with no ReplicaSets anywhere', async () => {
      await core.connect(sourceId)

      expect(await core.expand(sourceId, 'deployments')).toEqual([
        { kind: 'workload', workloadKind: 'Deployment', name: 'crasher', path: 'deployments/crasher', readyCount: { ready: 0, desired: 1 } },
        { kind: 'workload', workloadKind: 'Deployment', name: 'web', path: 'deployments/web', readyCount: { ready: 1, desired: 1 } }
      ])
      expect(described(await core.expand(sourceId, 'statefulsets'))).toEqual(['workload db'])
      expect(described(await core.expand(sourceId, 'daemonsets'))).toEqual(['workload agent'])
    })

    it('lists a Deployment’s pods, and their init and sidecar containers labelled, in the pod’s order', async () => {
      await core.connect(sourceId)
      const pod = await onlyPod(core, sourceId, 'deployments/web')

      expect(pod.name).toMatch(/^web-/)
      expect(await core.expand(sourceId, pod.path)).toEqual([
        { kind: 'container', name: 'setup', path: `${pod.path}/setup`, role: 'init' },
        { kind: 'container', name: 'proxy', path: `${pod.path}/proxy`, role: 'sidecar' },
        { kind: 'container', name: 'app', path: `${pod.path}/app` }
      ])
    })

    it('lists each container of a multi-container pod', async () => {
      await core.connect(sourceId)
      const pod = await onlyPod(core, sourceId, 'statefulsets/db')

      expect(pod.name).toBe('db-0')
      expect(described(await core.expand(sourceId, pod.path))).toEqual(['container db', 'container backup'])
    })

    it('lists a DaemonSet’s pods', async () => {
      await core.connect(sourceId)
      const pod = await onlyPod(core, sourceId, 'daemonsets/agent')

      expect(described(await core.expand(sourceId, pod.path))).toEqual(['container agent'])
    })

    it('lists a CronJob’s Jobs, then their pods', async () => {
      await core.connect(sourceId)

      expect(await core.expand(sourceId, 'cronjobs')).toEqual([
        { kind: 'workload', workloadKind: 'CronJob', name: 'nightly', path: 'cronjobs/nightly' }
      ])
      expect(await core.expand(sourceId, 'cronjobs/nightly')).toEqual([
        { kind: 'workload', workloadKind: 'Job', name: 'nightly-manual', path: 'cronjobs/nightly/nightly-manual' }
      ])
      const pod = await onlyPod(core, sourceId, 'cronjobs/nightly/nightly-manual')
      expect(described(await core.expand(sourceId, pod.path))).toEqual(['container report'])
    })

    it('lists only the Jobs no CronJob owns under Jobs', async () => {
      await core.connect(sourceId)

      expect(described(await core.expand(sourceId, 'jobs'))).toEqual(['workload migrate'])
      const pod = await onlyPod(core, sourceId, 'jobs/migrate')
      expect(described(await core.expand(sourceId, pod.path))).toEqual(['container migrate'])
    })

    it('lists only the pods no Workload owns under Pods', async () => {
      await core.connect(sourceId)

      expect(await core.expand(sourceId, 'pods')).toEqual([
        { kind: 'pod', name: 'counter', path: 'pods/counter', status: { reason: 'Running', health: 'healthy', restarts: 0 }, containerCount: 1 }
      ])
      expect(await core.expand(sourceId, 'pods/counter')).toEqual([
        { kind: 'container', name: 'counter', path: 'pods/counter/counter' }
      ])
    })

    it('gives each of the other Workloads a Ready Count, but not Jobs or CronJobs', async () => {
      await core.connect(sourceId)

      const workloads = (await Promise.all(['statefulsets', 'daemonsets', 'cronjobs', 'jobs'].map((g) => core.expand(sourceId, g)))).flat()
      expect(workloads.map((node) => [node.kind === 'workload' && node.name, node.kind === 'workload' && node.readyCount])).toEqual([
        ['db', { ready: 1, desired: 1 }],
        ['agent', { ready: 1, desired: 1 }],
        ['nightly', undefined],
        ['migrate', undefined]
      ])
    })

    it('gives each pod its Pod Status and how many containers it has', async () => {
      await core.connect(sourceId)

      expect(await onlyPod(core, sourceId, 'deployments/web')).toMatchObject({
        status: { reason: 'Running', health: 'healthy', restarts: 0 },
        containerCount: 3
      })
      expect(await onlyPod(core, sourceId, 'statefulsets/db')).toMatchObject({ containerCount: 2 })
      expect(await onlyPod(core, sourceId, 'jobs/migrate')).toMatchObject({ status: { reason: 'Completed', health: 'healthy' } })
    })

    it('shows the crash-looping pod failing, with its restarts and why its container last ended', async () => {
      await core.connect(sourceId)

      // The seed doesn't wait for the crasher: give it time to crash and restart, and to be caught between runs.
      const pod = await vi.waitFor(
        async () => {
          const found = await onlyPod(core, sourceId, 'deployments/crasher')
          if (found.kind !== 'pod' || found.status.restarts < 1 || found.status.health !== 'failing') throw new Error('not crash-looping yet')
          return found
        },
        { timeout: 90_000, interval: 2_000 }
      )

      expect(pod.status).toMatchObject({ lastTerminationReason: 'Error', lastRestart: expect.any(Number) })
      expect(['CrashLoopBackOff', 'Error']).toContain(pod.status.reason)
      expect(pod.status.lastRestart).toBeLessThanOrEqual(Date.now())
      const [container] = await core.expand(sourceId, pod.path)
      expect(container).toMatchObject({ kind: 'container', name: 'crash', restarts: expect.any(Number) })
      expect(container?.kind === 'container' && container.restarts).toBeGreaterThanOrEqual(1)
    }, 120_000)

    it('leaves out the restarts of containers that have not restarted', async () => {
      await core.connect(sourceId)
      const db = await onlyPod(core, sourceId, 'statefulsets/db')

      for (const container of await core.expand(sourceId, db.path)) expect(container).not.toHaveProperty('restarts')
    })

    it('shows an error node for what is not there, or is not where the path says', async () => {
      await core.connect(sourceId)
      const web = await onlyPod(core, sourceId, 'deployments/web')

      for (const path of ['nodes', 'deployments/missing', 'jobs/nightly-manual', `statefulsets/db/${web.name}`, 'pods/db-0']) {
        expect(await core.expand(sourceId, path)).toEqual([{ kind: 'error', path, code: 'NOT_FOUND', message: expect.any(String) }])
      }
    })

    it('fails to connect to a namespace that does not exist', async () => {
      const missing = await core.addSource(testKubernetesLogsSource('Missing', 'polyscope-no-such-namespace'))

      await expect(core.connect(missing.id)).rejects.toMatchObject({ code: 'NAMESPACE_NOT_FOUND' })
    })

    it('tests a connection by listing the namespace', async () => {
      await expect(core.testConnection(testKubernetesLogsSource())).resolves.toBeUndefined()
    })
  })

  describe('opening a Log Stream', () => {
    it('fetches the last N lines as a snapshot', async () => {
      await core.connect(sourceId)

      expect(await core.openLog(sourceId, 'pods/counter/counter', { lastNLines: 10 })).toEqual({
        view: 'log',
        of: 'logStream',
        path: 'pods/counter/counter',
        name: 'counter',
        pod: 'counter',
        previous: false,
        lastNLines: 10,
        timestamps: false,
        content: counterLines.slice(-10).join('\n')
      })
    })

    it('starts each line with when it was logged, when asked', async () => {
      await core.connect(sourceId)

      const log = await core.openLog(sourceId, 'pods/counter/counter', { lastNLines: 2, timestamps: true })

      expect(log.timestamps).toBe(true)
      expect(log.content.split('\n')).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z line 99$/), expect.stringMatching(/Z line 100$/)])
    })

    it('fetches all of it', async () => {
      await core.connect(sourceId)

      const log = await core.openLog(sourceId, 'pods/counter/counter', { lastNLines: 'all' })

      expect(log.content).toBe(counterLines.join('\n'))
    })

    it('goes by the Source’s remembered number, or else the Settings default', async () => {
      await core.connect(sourceId)
      await core.updateSettings({ defaultLastNLines: 3 })

      expect((await core.openLog(sourceId, 'pods/counter/counter')).content).toBe('line 98\nline 99\nline 100')

      await core.rememberLastNLines(sourceId, 2)
      expect(await core.openLog(sourceId, 'pods/counter/counter')).toMatchObject({ lastNLines: 2, content: 'line 99\nline 100' })
    })

    it('refuses all of a log larger than the Large File threshold, unless told to go ahead', async () => {
      await core.connect(sourceId)
      await core.updateSettings({ largeFileThreshold: 100 })

      await expect(core.openLog(sourceId, 'pods/counter/counter', { lastNLines: 'all' })).rejects.toMatchObject({
        code: 'LOG_TOO_LARGE'
      })
      const log = await core.openLog(sourceId, 'pods/counter/counter', { lastNLines: 'all', allowLarge: true })
      expect(log.content).toBe(counterLines.join('\n'))
    })

    it('reads any container in the tree, init and sidecar containers included', async () => {
      await core.connect(sourceId)
      const web = await onlyPod(core, sourceId, 'deployments/web')
      const db = await onlyPod(core, sourceId, 'statefulsets/db')
      const report = await onlyPod(core, sourceId, 'cronjobs/nightly/nightly-manual')

      const read = async (path: string) => (await core.openLog(sourceId, path, { lastNLines: 1_000 })).content
      expect(await read(`${web.path}/setup`)).toBe('setup done')
      expect(await read(`${web.path}/proxy`)).toBe('proxy up')
      expect(await read(`${web.path}/app`)).toBe('web ready')
      expect(await read(`${db.path}/backup`)).toBe('backup idle')
      expect(await read(`${report.path}/report`)).toBe('report done')
      expect(await core.openLog(sourceId, `${web.path}/app`)).toMatchObject({ name: 'app', pod: web.name })
    })

    it('opens only containers', async () => {
      await core.connect(sourceId)

      await expect(core.openLog(sourceId, 'pods/counter')).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
      await expect(core.openLog(sourceId, 'pods/counter/missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(core.openFile(sourceId, 'pods/counter/counter')).rejects.toMatchObject({ code: 'NOT_A_FILE' })
    })
  })
})

/** Every Follow update the core sends, and a way to read those of one Follow as lines, marks in angle brackets. */
function followUpdates(core: Core) {
  const events: FollowEvent[] = []
  const unsubscribe = core.onFollowEvent((event) => events.push(event))
  const of = (followId: string) =>
    events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [`<${e.kind}>`]))
  return { events, of, unsubscribe }
}

/** The crash-looping pod, once its container has restarted. */
async function crashedPod(core: Core, sourceId: string) {
  return vi.waitFor(
    async () => {
      const pod = await onlyPod(core, sourceId, 'deployments/crasher')
      if (pod.kind !== 'pod' || pod.status.restarts < 1) throw new Error('not restarted yet')
      return pod
    },
    { timeout: 90_000, interval: 2_000 }
  )
}

describe.skipIf(!hasTestCluster)('Previous Logs against the test cluster', () => {
  let core: Core
  let sourceId: string

  beforeEach(async () => {
    core = createCore()
    sourceId = (await core.addSource(testKubernetesLogsSource())).id
    await core.connect(sourceId)
  })

  it('lists a restarted container’s Previous Log right after it, and opens the run before the current one', async () => {
    const pod = await crashedPod(core, sourceId)

    const [container, previous] = await core.expand(sourceId, pod.path)
    expect(container).toMatchObject({ kind: 'container', name: 'crash' })
    expect(previous).toEqual({ kind: 'previousLog', name: 'previous', path: `${pod.path}/crash/previous`, container: 'crash' })
    // Between restarts the kubelet can briefly answer with "unable to retrieve container logs" instead.
    await vi.waitFor(
      async () =>
        expect(await core.openLog(sourceId, `${pod.path}/crash/previous`)).toMatchObject({
          name: 'crash',
          pod: pod.name,
          previous: true,
          content: 'crashing'
        }),
      { timeout: 20_000, interval: 1_000 }
    )
  }, 120_000)

  it('lists none for a container that has not restarted', async () => {
    expect(described(await core.expand(sourceId, 'pods/counter'))).toEqual(['container counter'])
  })

  it('cannot be followed', async () => {
    const pod = await crashedPod(core, sourceId)

    await expect(core.followLog(sourceId, `${pod.path}/crash/previous`)).rejects.toMatchObject({ code: 'NOT_FOLLOWABLE' })
  }, 120_000)
})

describe.skipIf(!hasTestCluster)('Following a Log Stream against the test cluster', () => {
  let core: Core
  let sourceId: string
  let updates: ReturnType<typeof followUpdates>

  beforeEach(async () => {
    core = createCore()
    sourceId = (await core.addSource(testKubernetesLogsSource())).id
    await core.connect(sourceId)
    updates = followUpdates(core)
  })

  afterEach(async () => {
    await core.disconnect(sourceId)
    updates.unsubscribe()
  })

  it('starts from the last N lines, and keeps that many of them', async () => {
    const log = await core.followLog(sourceId, 'pods/counter/counter', { lastNLines: 2 })

    expect(log).toMatchObject({ view: 'log', lastNLines: 2, content: 'line 99\nline 100', followId: expect.any(String) })
  })

  it('ends every Follow of a Source when it is disconnected', async () => {
    const one = await core.followLog(sourceId, 'pods/counter/counter', { lastNLines: 1 })
    const two = await core.followLog(sourceId, 'pods/counter/counter', { lastNLines: 1 })

    await core.disconnect(sourceId)

    expect(updates.events).toEqual([
      { followId: one.followId, kind: 'ended', reason: 'disconnected' },
      { followId: two.followId, kind: 'ended', reason: 'disconnected' }
    ])
  })

  it('follows nothing once stopped', async () => {
    const log = await core.followLog(sourceId, 'pods/counter/counter', { lastNLines: 1 })

    await core.stopFollow(log.followId)
    await core.disconnect(sourceId)

    expect(updates.of(log.followId)).toEqual([])
  })

  describe('a container that keeps logging, then crashes and restarts', () => {
    // One each: a deleted namespace takes a while to go, and its name can't be used again until it has.
    let runs = 0
    let tickerSource: string
    let remove: () => Promise<void>
    const ticker = 'pods/ticker/ticker'

    beforeEach(async () => {
      const namespace = `polyscope-test-follow-${process.pid}-${++runs}`
      ;({ remove } = await tickerNamespace(namespace, 6))
      tickerSource = (await core.addSource(testKubernetesLogsSource('Ticker', namespace))).id
      await core.connect(tickerSource)
    }, 150_000)

    afterEach(async () => {
      await core.disconnect(tickerSource)
      await remove()
    })

    it('receives the lines logged after its snapshot, each once', async () => {
      const log = await core.followLog(tickerSource, ticker, { lastNLines: 1_000 })

      await vi.waitFor(() => expect(updates.of(log.followId).length).toBeGreaterThanOrEqual(2), { timeout: 15_000 })
      const shown = [...log.content.split('\n'), ...updates.of(log.followId)].filter(Boolean).slice(0, 6)
      expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => `tick ${i + 1}`))
    }, 30_000)

    it('marks the restart, then follows the new run from its start', async () => {
      const log = await core.followLog(tickerSource, ticker, { lastNLines: 1_000 })

      await vi.waitFor(() => expect(updates.of(log.followId)).toContain('<restarted>'), { timeout: 90_000, interval: 1_000 })
      await vi.waitFor(() => expect(updates.of(log.followId).slice(-2)).not.toContain('<restarted>'), { timeout: 15_000 })

      const lines = updates.of(log.followId)
      expect(lines.slice(lines.indexOf('<restarted>'), lines.indexOf('<restarted>') + 2)).toEqual(['<restarted>', 'tick 1'])
    }, 120_000)

    it('holds back at most the last N lines while paused', async () => {
      const log = await core.followLog(tickerSource, ticker, { lastNLines: 2 })
      await core.pauseFollow(log.followId)

      await new Promise((resolve) => setTimeout(resolve, 5_000))
      expect(updates.of(log.followId)).toEqual([])
      await core.resumeFollow(log.followId)

      const held = updates.of(log.followId).filter((line) => !line.startsWith('<'))
      expect(held).toHaveLength(2)
      expect(held.map((line) => Number(line.slice('tick '.length)))).toEqual([expect.any(Number), expect.any(Number)])
    }, 30_000)
  })
})

describe.skipIf(!hasRestrictedContext)('permission errors against the test cluster', () => {
  let core: Core
  let sourceId: string

  beforeEach(async () => {
    core = createCore()
    sourceId = (await core.addSource(restrictedKubernetesLogsSource())).id
  })

  afterEach(() => core.disconnect(sourceId))

  const missing = (permission: string | RegExp) => ({ code: 'MISSING_PERMISSION', message: permission })

  it('puts a Source in its Error state with the permission it is missing', async () => {
    const elsewhere = await core.addSource(restrictedKubernetesLogsSource('Elsewhere', 'default'))
    // Every group is listed at once; whichever is refused first is the one named.
    const denied = missing(/^list \S+ in namespace default$/)

    await expect(core.connect(elsewhere.id)).rejects.toMatchObject(denied)
    expect(await core.connectionState(elsewhere.id)).toMatchObject({ state: 'error', ...denied })
  })

  it('shows an error node with the permission it is missing', async () => {
    await core.connect(sourceId)

    expect(await core.expand(sourceId, 'statefulsets/db')).toEqual([
      { kind: 'error', path: 'statefulsets/db', ...missing('get statefulsets.apps in namespace polyscope-test') }
    ])
  })

  it('refuses to open or follow a log with the permission it is missing', async () => {
    await core.connect(sourceId)
    const denied = missing('get pods/log in namespace polyscope-test')

    await expect(core.openLog(sourceId, 'pods/counter/counter')).rejects.toMatchObject(denied)
    await expect(core.followLog(sourceId, 'pods/counter/counter')).rejects.toMatchObject(denied)
  })

  it('refuses a Follow’s connection with the permission it is missing', async () => {
    const { context, namespace } = restrictedKubernetesLogsSource()
    const logSource = createKubernetesLogSource(kubeConfigFor(context), namespace)

    await expect(logSource.followLog('pods/counter/counter', {}, () => undefined)).rejects.toMatchObject(
      missing('get pods/log in namespace polyscope-test')
    )
  })
})
