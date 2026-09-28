import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreV1Api } from '@kubernetes/client-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryNode, NewKubernetesFilesSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { kubeConfigFor } from './kubeconfig'
import {
  hasRestrictedContext,
  hasTestCluster,
  podsNamed,
  restrictedKubernetesFilesSource,
  testFilesNamespace,
  testKubernetesFilesSource,
  testNamespace
} from './kubernetes-test-cluster'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-kube-files-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

const offline = (changes: Partial<NewKubernetesFilesSource> = {}): NewKubernetesFilesSource => ({
  type: 'kubernetesFiles',
  name: 'Files',
  context: 'dev',
  namespace: 'shop',
  workloadKind: 'Deployment',
  workloadName: 'web',
  path: '/var/log',
  ...changes
})

describe('adding a Kubernetes Files Source', () => {
  it('is listed with its context, namespace, Workload and path, trimmed', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ context: ' dev ', namespace: ' shop ', workloadName: ' web ', path: ' /var//log/ ' }))

    const expected = {
      id: added.id,
      type: 'kubernetesFiles',
      name: 'Files',
      context: 'dev',
      namespace: 'shop',
      workloadKind: 'Deployment',
      workloadName: 'web',
      path: '/var/log'
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('keeps / as the path for the whole filesystem', async () => {
    expect(await createCore().addSource(offline({ path: '/' }))).toMatchObject({ path: '/' })
  })

  it('can be saved while its cluster is away', async () => {
    vi.stubEnv('KUBECONFIG', join(dir, 'missing'))

    await expect(createCore().addSource(offline())).resolves.toMatchObject({ workloadName: 'web' })
  })

  it('needs a context and a namespace that could exist', async () => {
    const core = createCore()

    await expect(core.addSource(offline({ context: '' }))).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' })
    await expect(core.addSource(offline({ namespace: 'Shop' }))).rejects.toMatchObject({ code: 'INVALID_NAMESPACE' })
  })

  it('needs a Deployment, StatefulSet or DaemonSet, by name', async () => {
    const core = createCore()

    for (const workloadKind of ['CronJob', 'Job', 'Pod', ''] as const) {
      await expect(core.addSource(offline({ workloadKind: workloadKind as 'Deployment' }))).rejects.toMatchObject({ code: 'INVALID_WORKLOAD_KIND' })
    }
    await expect(core.addSource(offline({ workloadName: ' ' }))).rejects.toMatchObject({ code: 'WORKLOAD_REQUIRED' })
  })

  it('needs an absolute path that does not climb', async () => {
    const core = createCore()

    for (const path of ['', 'var/log', '/var/../etc', '/./x']) {
      await expect(core.addSource(offline({ path }))).rejects.toMatchObject({ code: 'INVALID_CONTAINER_PATH' })
    }
  })

  it('gets a group of its own, between S3 and Kubernetes Logs', async () => {
    const core = createCore()
    await core.addSource({ type: 'kubernetesLogs', name: 'Logs', context: 'dev', namespace: 'shop' })
    await core.addSource(offline())
    await core.addSource({ type: 'local', name: 'Disk', rootPath: dir })

    expect((await core.listSources()).map((s) => s.type)).toEqual(['local', 'kubernetesFiles', 'kubernetesLogs'])
  })
})

describe('connecting a Kubernetes Files Source', () => {
  it('fails when its context is not in the kubeconfig', async () => {
    const file = join(dir, 'kubeconfig')
    await writeFile(file, 'apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\n')
    vi.stubEnv('KUBECONFIG', file)
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' })
    await expect(core.testConnection(offline())).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' })
  })
})

/** What a listing shows, as `kind name`, in its order. */
const described = (nodes: TreeNode[]) => nodes.map((node) => `${node.kind} ${'name' in node ? node.name : ''}`)

/** The pod folders at the root of a connected Source. */
const podFolders = async (core: Core, sourceId: string) => (await core.expand(sourceId, '')) as EntryNode[]

describe.skipIf(!hasTestCluster)('Kubernetes Files against the test cluster', () => {
  let core: Core

  beforeEach(() => {
    core = createCore()
  })

  const connected = async (changes: Partial<NewKubernetesFilesSource> = {}) => {
    const { id } = await core.addSource(testKubernetesFilesSource(changes))
    const root = await core.connect(id)
    return { id, root }
  }

  describe('the Source dialog’s choices', () => {
    it('lists the cluster’s namespaces', async () => {
      const { context } = testKubernetesFilesSource()

      expect(await core.listKubeNamespaces(context)).toEqual(expect.arrayContaining([testFilesNamespace, 'default']))
    })

    it('lists a namespace’s Workloads of each kind, by name', async () => {
      const { context, namespace } = testKubernetesFilesSource()

      expect(await core.listKubeWorkloads(context, namespace, 'Deployment')).toEqual(['files-busybox', 'files-pair', 'files-rollout', 'files-shellless'])
      expect(await core.listKubeWorkloads(context, namespace, 'StatefulSet')).toEqual(['files-coreutils'])
      expect(await core.listKubeWorkloads(context, namespace, 'DaemonSet')).toEqual([])
    })
  })

  describe('the tree', () => {
    it('shows a folder for each pod, with its Pod Status', async () => {
      const { root } = await connected({ workloadKind: 'StatefulSet', workloadName: 'files-coreutils' })

      expect(root).toEqual(
        ['files-coreutils-0', 'files-coreutils-1'].map((name) => ({
          kind: 'folder',
          name,
          path: name,
          icon: expect.any(String),
          kubernetes: { kind: 'pod', status: { reason: 'Running', health: 'healthy', restarts: 0 }, containerCount: 1 }
        }))
      )
    })

    it('shows the path’s contents right inside the pod when it has one container', async () => {
      const { id, root } = await connected()
      const [pod] = root as EntryNode[]

      expect(described(await core.expand(id, pod!.path))).toEqual(['folder empty', 'folder logs', 'file app.log'])
      expect(described(await core.expand(id, `${pod!.path}/logs`))).toEqual(['file old.log'])
      expect(await core.expand(id, `${pod!.path}/empty`)).toEqual([])
    })

    it('lists files with their size and modified time', async () => {
      const { id, root } = await connected()
      const [pod] = root as EntryNode[]

      const [, , file] = (await core.expand(id, pod!.path)) as EntryNode[]
      expect(file).toMatchObject({ kind: 'file', name: 'app.log', path: `${pod!.path}/app.log`, size: 8, icon: 'log' })
      expect(file!.modifiedTime).toBeLessThanOrEqual(Date.now())
    })

    it('shows a container level, sidecars labelled, when the pod has several containers', async () => {
      const { id, root } = await connected({ workloadName: 'files-pair' })
      const [pod] = root as EntryNode[]

      expect(pod).toMatchObject({ kubernetes: { kind: 'pod', containerCount: 2 } })
      expect(await core.expand(id, pod!.path)).toEqual([
        { kind: 'folder', name: 'app', path: `${pod!.path}/app`, icon: expect.any(String), kubernetes: { kind: 'container' } },
        { kind: 'folder', name: 'proxy', path: `${pod!.path}/proxy`, icon: expect.any(String), kubernetes: { kind: 'container', role: 'sidecar' } }
      ])
      expect(await core.openFile(id, `${pod!.path}/proxy/whoami`)).toMatchObject({ content: 'proxy\n' })
      expect(await core.openFile(id, `${pod!.path}/app/whoami`)).toMatchObject({ content: 'app\n' })
    })

    it('shows an error node for a container with no shell', async () => {
      const { id, root } = await connected({ workloadName: 'files-shellless' })
      const [pod] = root as EntryNode[]

      expect(await core.expand(id, pod!.path)).toEqual([{ kind: 'error', path: pod!.path, code: 'NO_SHELL', message: expect.stringContaining('sh') }])
    })

    it('shows an error node for a path that is not there', async () => {
      const { id, root } = await connected({ path: '/nowhere' })
      const [pod] = root as EntryNode[]

      expect(await core.expand(id, pod!.path)).toEqual([expect.objectContaining({ kind: 'error', code: 'NOT_FOUND' })])
    })

    it('fails to connect to a Workload that is not there', async () => {
      const { id } = await core.addSource(testKubernetesFilesSource({ workloadName: 'missing' }))

      await expect(core.connect(id)).rejects.toMatchObject({ code: 'WORKLOAD_NOT_FOUND' })
    })
  })

  describe('opening a file', () => {
    it.each([
      ['busybox', { workloadName: 'files-busybox' }],
      ['coreutils', { workloadKind: 'StatefulSet', workloadName: 'files-coreutils' }]
    ] as const)('reads it from a %s image', async (_image, changes) => {
      const { id, root } = await connected(changes)
      const [pod] = root as EntryNode[]

      expect(await core.openFile(id, `${pod!.path}/logs/old.log`)).toMatchObject({ view: 'editor', content: 'one\ntwo\n', size: 8 })
    })

    it('reports a pod that no longer exists', async () => {
      const [before] = await podsNamed('files-rollout')
      const { id } = await connected({ workloadName: 'files-rollout' })
      const api = kubeConfigFor(testKubernetesFilesSource().context).makeApiClient(CoreV1Api)

      await api.deleteNamespacedPod({ name: before!, namespace: testFilesNamespace, gracePeriodSeconds: 0 })

      await vi.waitFor(() => expect(core.openFile(id, `${before}/app.log`)).rejects.toMatchObject({ code: 'POD_GONE' }), { timeout: 60_000, interval: 1_000 })
      // Its replacement is there to browse instead.
      await vi.waitFor(async () => expect((await podFolders(core, id)).map((pod) => pod.name)).not.toContain(before), { timeout: 60_000, interval: 1_000 })
    }, 150_000)
  })
})

describe.skipIf(!hasRestrictedContext)('Kubernetes Files permission errors against the test cluster', () => {
  it('says exec is the permission missing', async () => {
    const core = createCore()
    // The restricted ServiceAccount may list the Logs namespace's Deployments and pods, but not exec into them.
    const { id } = await core.addSource(restrictedKubernetesFilesSource({ namespace: testNamespace, workloadName: 'web', path: '/' }))
    const [pod] = (await core.connect(id)) as EntryNode[]

    expect(await core.expand(id, `${pod!.path}/app`)).toEqual([
      { kind: 'error', path: `${pod!.path}/app`, code: 'MISSING_PERMISSION', message: `create pods/exec in namespace ${testNamespace}` }
    ])
  })
})
