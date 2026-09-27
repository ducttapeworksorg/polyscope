import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogNode, NewKubernetesLogsSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { counterLines, hasTestCluster, testKubernetesLogsSource } from './kubernetes-test-cluster'

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
        { kind: 'workload', workloadKind: 'Deployment', name: 'crasher', path: 'deployments/crasher' },
        { kind: 'workload', workloadKind: 'Deployment', name: 'web', path: 'deployments/web' }
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

      expect(await core.expand(sourceId, 'pods')).toEqual([{ kind: 'pod', name: 'counter', path: 'pods/counter' }])
      expect(await core.expand(sourceId, 'pods/counter')).toEqual([
        { kind: 'container', name: 'counter', path: 'pods/counter/counter' }
      ])
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
        path: 'pods/counter/counter',
        name: 'counter',
        pod: 'counter',
        lastNLines: 10,
        content: counterLines.slice(-10).join('\n')
      })
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
