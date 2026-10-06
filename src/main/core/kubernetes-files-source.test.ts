import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreV1Api } from '@kubernetes/client-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryNode, FoldedNode, FollowEvent, NewKubernetesFilesSource, TreeNode } from '@shared/core-api'
import { MB } from '@shared/settings'
import { createCore, type Core } from './core'
import { kubeConfigFor } from './kubeconfig'
import { execInPod } from './kubernetes-exec'
import { filesDeployments, ignoreAmbientProxy, standInCluster, startTestApiServer } from './kubernetes-test-api-server'
import {
  hasRestrictedContext,
  hasTestCluster,
  podsNamed,
  restrictedKubernetesFilesSource,
  seedContainerFolder,
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

// The stand-in can't exec into its pods, so only shows what the tree makes of them.
describe('a Kubernetes Files Source’s pods, on a stand-in API server', () => {
  let apiServer: Awaited<ReturnType<typeof startTestApiServer>>
  let core: Core

  beforeEach(async () => {
    apiServer = await startTestApiServer()
    ignoreAmbientProxy()
    const file = join(dir, 'kubeconfig')
    await writeFile(file, standInCluster(apiServer.url, apiServer.caPath))
    vi.stubEnv('KUBECONFIG', file)
    core = createCore()
  })

  afterEach(async () => {
    await apiServer.close()
  })

  const connected = async (workloadName: keyof typeof filesDeployments) => {
    const { id } = await core.addSource(offline({ context: 'fake', namespace: 'files', workloadName }))
    return { id, root: await core.connect(id) }
  }

  it('shows a folder for each pod when there are several', async () => {
    const { root } = await connected('duo')

    expect(root).toEqual(
      ['duo-6a2e-klmno', 'duo-6a2e-pqrst'].map((name) => ({
        kind: 'folder',
        name,
        path: name,
        icon: expect.any(String),
        kubernetes: { kind: 'pod', status: { reason: 'Running', health: 'healthy', restarts: 0 }, containerCount: 1 }
      }))
    )
  })

  it('folds a single pod into the root, which lists its containers, their paths keeping the pod', async () => {
    const { id, root } = await connected('pair')
    const pod = 'pair-5c4b-fghij'

    expect(root).toEqual([
      { kind: 'folded', name: pod, path: pod, kubernetes: { kind: 'pod', status: { reason: 'Running', health: 'healthy', restarts: 0 }, containerCount: 2 } },
      { kind: 'folder', name: 'app', path: `${pod}/app`, icon: expect.any(String), kubernetes: { kind: 'container' } },
      { kind: 'folder', name: 'proxy', path: `${pod}/proxy`, icon: expect.any(String), kubernetes: { kind: 'container', role: 'sidecar' } }
    ])
    expect(await core.expand(id, '')).toEqual(root)
  })

  it('connects even when the single pod’s files can’t be listed, saying why at the root', async () => {
    const { root } = await connected('solo')
    const pod = 'solo-7d9f-abcde'

    expect(root).toEqual([
      { kind: 'folded', name: pod, path: pod, kubernetes: { kind: 'pod', status: expect.objectContaining({ reason: 'CrashLoopBackOff', restarts: 2 }), containerCount: 1 } },
      { kind: 'error', path: '', code: 'CONTAINER_NOT_RUNNING', message: expect.stringContaining(pod) }
    ])
  })
})

/** What a listing shows, as `kind name`, in its order. */
const described = (nodes: TreeNode[]) => nodes.map((node) => `${node.kind} ${'name' in node ? node.name : ''}`)

/** The pod folded into a root listing: a Workload's only one. */
const foldedPod = (root: TreeNode[]) => {
  expect(root[0]).toMatchObject({ kind: 'folded' })
  return root[0] as FoldedNode
}

describe.skipIf(!hasTestCluster)('Kubernetes Files against the test cluster', () => {
  let core: Core

  beforeEach(() => {
    core = createCore({ cacheDir: join(dir, 'cache') })
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

    it('lists a namespace’s Workloads of every kind, by kind then name, with where their volumes are mounted', async () => {
      const { context, namespace } = testKubernetesFilesSource()

      expect(await core.listKubeWorkloads(context, namespace)).toEqual([
        { kind: 'Deployment', name: 'files-busybox', mountPaths: [] },
        { kind: 'Deployment', name: 'files-pair', mountPaths: [] },
        { kind: 'Deployment', name: 'files-rollout', mountPaths: [] },
        { kind: 'Deployment', name: 'files-shellless', mountPaths: ['/data'] },
        { kind: 'StatefulSet', name: 'files-coreutils', mountPaths: [] }
      ])
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

    it('folds a single pod of one container into the root, which lists the path’s contents, their paths keeping the pod', async () => {
      const { id, root } = await connected()
      const [pod] = await podsNamed('files-busybox')

      expect(foldedPod(root)).toEqual({
        kind: 'folded',
        name: pod,
        path: pod,
        kubernetes: { kind: 'pod', status: { reason: 'Running', health: 'healthy', restarts: 0 }, containerCount: 1 }
      })
      expect(described(root)).toEqual([`folded ${pod}`, 'folder empty', 'folder logs', 'file app.log'])
      expect(await core.expand(id, '')).toEqual(root)
      expect(described(await core.expand(id, `${pod}/logs`))).toEqual(['file old.log'])
      expect(await core.expand(id, `${pod}/empty`)).toEqual([])
    })

    it('lists files with their size and modified time', async () => {
      const { root } = await connected()
      const pod = foldedPod(root)

      const [, , , file] = root as EntryNode[]
      expect(file).toMatchObject({ kind: 'file', name: 'app.log', path: `${pod.path}/app.log`, size: 8, icon: 'log' })
      expect(file!.modifiedTime).toBeLessThanOrEqual(Date.now())
    })

    it('shows a container level, sidecars labelled, when the pod has several containers', async () => {
      const { id, root } = await connected({ workloadName: 'files-pair' })
      const pod = foldedPod(root)

      expect(pod).toMatchObject({ kubernetes: { kind: 'pod', containerCount: 2 } })
      expect(root.slice(1)).toEqual([
        { kind: 'folder', name: 'app', path: `${pod.path}/app`, icon: expect.any(String), kubernetes: { kind: 'container' } },
        { kind: 'folder', name: 'proxy', path: `${pod.path}/proxy`, icon: expect.any(String), kubernetes: { kind: 'container', role: 'sidecar' } }
      ])
      expect(await core.openFile(id, `${pod.path}/proxy/whoami`)).toMatchObject({ content: 'proxy\n' })
      expect(await core.openFile(id, `${pod.path}/app/whoami`)).toMatchObject({ content: 'app\n' })
    })

    it('shows an error node for a container with no shell', async () => {
      const { root } = await connected({ workloadName: 'files-shellless' })

      expect(root.slice(1)).toEqual([{ kind: 'error', path: '', code: 'NO_SHELL', message: expect.stringContaining('sh') }])
    })

    it('shows an error node for a path that is not there', async () => {
      const { root } = await connected({ path: '/nowhere' })

      expect(root.slice(1)).toEqual([expect.objectContaining({ kind: 'error', path: '', code: 'NOT_FOUND' })])
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
      // The StatefulSet's two pods each have a folder; the Deployment's one is folded into the root.
      const [pod] = root as (EntryNode | FoldedNode)[]

      expect(await core.openFile(id, `${pod!.path}/logs/old.log`)).toMatchObject({ view: 'editor', content: 'one\ntwo\n', size: 8 })
    })

    it('reports a pod that no longer exists, folding its replacement into the root instead', async () => {
      const [before] = await podsNamed('files-rollout')
      const { id } = await connected({ workloadName: 'files-rollout' })
      const api = kubeConfigFor(testKubernetesFilesSource().context).makeApiClient(CoreV1Api)

      await api.deleteNamespacedPod({ name: before!, namespace: testFilesNamespace, gracePeriodSeconds: 0 })

      await vi.waitFor(() => expect(core.openFile(id, `${before}/app.log`)).rejects.toMatchObject({ code: 'POD_GONE' }), { timeout: 60_000, interval: 1_000 })
      await vi.waitFor(async () => expect(foldedPod(await core.expand(id, '')).name).not.toBe(before), { timeout: 60_000, interval: 1_000 })
    }, 150_000)
    it('opens a Large File at its end, then caches it through range reads', async () => {
      const [pod] = await podsNamed('files-busybox')
      const seeded = await seedContainerFolder(pod!, {})
      try {
        await core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap: 4 * MB })
        const config = kubeConfigFor(testKubernetesFilesSource().context)
        const target = { namespace: testFilesNamespace, pod: pod!, container: 'app' }
        // 300,000 numbered lines: about 2 MB.
        const written = await execInPod(config, target, ['sh', '-c', 'seq 1 300000 > "$1/big.log"', 'sh', seeded.path])
        expect(written.exitCode).toBe(0)
        const { id } = await connected({ workloadName: 'files-busybox', path: seeded.path })

        const file = await core.openFile(id, `${pod}/big.log`)

        expect(file).toMatchObject({ view: 'large', encoding: 'utf-8' })
        if (file.view !== 'large') return
        expect(file.lastLines.at(-1)).toBe('300000')
        await vi.waitFor(async () => expect(await core.largeFileStatus(file.largeFileId)).toMatchObject({ state: 'ready', lineCount: 300_000 }), {
          timeout: 60_000,
          interval: 200
        })
        expect(await core.readLargeFileLines(file.largeFileId, 149_999, 2)).toEqual({ firstLine: 149_999, lines: ['150000', '150001'] })
        await core.closeLargeFile(file.largeFileId)
      } finally {
        await seeded.remove()
      }
    }, 90_000)
  })

  describe('following a file', () => {
    /** Runs a script in a pod's app container, `file` being its $1. */
    const runIn = async (pod: string, script: string, file: string) => {
      const config = kubeConfigFor(testKubernetesFilesSource().context)
      const result = await execInPod(config, { namespace: testFilesNamespace, pod, container: 'app' }, ['sh', '-c', script, 'sh', file])
      if (result.exitCode !== 0) throw new Error(`${script} failed in ${pod}: ${result.stderr}`)
    }

    it.each([
      ['busybox', { workloadName: 'files-busybox' }],
      ['coreutils', { workloadKind: 'StatefulSet', workloadName: 'files-coreutils' }]
    ] as const)('adds what is written to a file in a %s pod, marking it cut short or rotated', async (_image, changes) => {
      const [pod] = await podsNamed(changes.workloadName)
      const seeded = await seedContainerFolder(pod!, { 'app.log': 'one\ntwo\nthree\n' })
      const events: FollowEvent[] = []
      const unsubscribe = core.onFollowEvent((event) => events.push(event))
      try {
        const { id } = await connected({ ...changes, path: seeded.path })
        const followed = await core.followFile(id, `${pod}/app.log`, { lastNLines: 2 })
        const updates = () =>
          events.filter((e) => e.followId === followed.followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [`<${e.kind}>`]))
        const eventually = (expected: string[]) => vi.waitFor(() => expect(updates()).toEqual(expected), { timeout: 20_000, interval: 500 })
        const file = `${seeded.path}/app.log`

        expect(followed.content).toBe('two\nthree')
        await runIn(pod!, 'printf "four\\nfive\\n" >> "$1"', file)
        await eventually(['four', 'five'])
        await runIn(pod!, 'printf "anew\\n" > "$1"', file)
        await eventually(['four', 'five', '<truncated>', 'anew'])
        // Longer than what it replaces, so only its identity tells it's another file.
        await runIn(pod!, 'mv "$1" "$1.1" && printf "rotated in and longer\\n" > "$1"', file)
        await eventually(['four', 'five', '<truncated>', 'anew', '<rotated>', 'rotated in and longer'])
        await core.stopFollow(followed.followId)
      } finally {
        unsubscribe()
        await seeded.remove()
      }
    }, 90_000)
  })
})

describe.skipIf(!hasRestrictedContext)('Kubernetes Files permission errors against the test cluster', () => {
  it('says what’s missing when no kind of Workload may be listed', async () => {
    const core = createCore()
    // The restricted ServiceAccount has no permissions at all in the Files namespace.
    const { context } = restrictedKubernetesFilesSource()

    await expect(core.listKubeWorkloads(context, testFilesNamespace)).rejects.toMatchObject({ code: 'MISSING_PERMISSION' })
  })

  it('says exec is the permission missing', async () => {
    const core = createCore()
    // The restricted ServiceAccount may list the Logs namespace's Deployments and pods, but not exec into them.
    const { id } = await core.addSource(restrictedKubernetesFilesSource({ namespace: testNamespace, workloadName: 'web', path: '/' }))
    const pod = foldedPod(await core.connect(id))

    expect(await core.expand(id, `${pod.path}/app`)).toEqual([
      { kind: 'error', path: `${pod.path}/app`, code: 'MISSING_PERMISSION', message: `create pods/exec in namespace ${testNamespace}` }
    ])
  })
})
