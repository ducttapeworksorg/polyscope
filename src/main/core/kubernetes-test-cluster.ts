// Test support: a real cluster (kind in CI) seeded from tests/kind/seed.yaml, named by POLYSCOPE_TEST_KUBE_CONTEXT
// (a context in the kubeconfig), with POLYSCOPE_TEST_KUBE_NAMESPACE for the Logs tests and
// POLYSCOPE_TEST_KUBE_FILES_NAMESPACE for the Files tests. Tests that need it are skipped without it.
// POLYSCOPE_TEST_KUBE_RESTRICTED_CONTEXT names a context signed in as the seed's `restricted` ServiceAccount.

import { randomUUID } from 'node:crypto'
import { CoreV1Api, type V1ContainerStatus, type V1PodSpec } from '@kubernetes/client-node'
import type { NewKubernetesFilesSource, NewKubernetesLogsSource } from '@shared/core-api'
import type { SeedTree } from './file-source-contract'
import { execInPod, type ExecTarget } from './kubernetes-exec'
import { kubeConfigFor } from './kubeconfig'

const context = process.env['POLYSCOPE_TEST_KUBE_CONTEXT']

/** Whether a test cluster was given; Kubernetes tests are skipped without one. */
export const hasTestCluster = Boolean(context)

export const testNamespace = process.env['POLYSCOPE_TEST_KUBE_NAMESPACE'] || 'polyscope-test'

/** Settings of a Kubernetes Logs Source pointing at the seeded namespace of the test cluster. */
export const testKubernetesLogsSource = (name = 'Cluster', namespace = testNamespace): NewKubernetesLogsSource => ({
  type: 'kubernetesLogs',
  name,
  context: context ?? '',
  namespace
})

const restrictedContext = process.env['POLYSCOPE_TEST_KUBE_RESTRICTED_CONTEXT']

/** Whether the test cluster has a restricted context; the permission tests are skipped without one. */
export const hasRestrictedContext = Boolean(restrictedContext)

/** Settings of a Kubernetes Logs Source signed in as the restricted ServiceAccount. */
export const restrictedKubernetesLogsSource = (name = 'Restricted', namespace = testNamespace): NewKubernetesLogsSource => ({
  ...testKubernetesLogsSource(name, namespace),
  context: restrictedContext ?? ''
})

export const testFilesNamespace = process.env['POLYSCOPE_TEST_KUBE_FILES_NAMESPACE'] || 'polyscope-files'

/** Settings of a Kubernetes Files Source pointing at /data in the seed's files-busybox Deployment; `changes` point it elsewhere. */
export const testKubernetesFilesSource = (changes: Partial<NewKubernetesFilesSource> = {}): NewKubernetesFilesSource => ({
  type: 'kubernetesFiles',
  name: 'Files',
  context: context ?? '',
  namespace: testFilesNamespace,
  workloadKind: 'Deployment',
  workloadName: 'files-busybox',
  path: '/data',
  ...changes
})

/** Settings like testKubernetesFilesSource's, signed in as the restricted ServiceAccount. */
export const restrictedKubernetesFilesSource = (changes: Partial<NewKubernetesFilesSource> = {}): NewKubernetesFilesSource =>
  testKubernetesFilesSource({ context: restrictedContext ?? '', ...changes })

/** The names of a Workload's pods in the Files namespace, going by the `app` label the seed gives them. */
export async function podsNamed(app: string) {
  const api = kubeConfigFor(context ?? '').makeApiClient(CoreV1Api)
  const pods = await api.listNamespacedPod({ namespace: testFilesNamespace, labelSelector: `app=${app}` })
  return pods.items.map((pod) => pod.metadata?.name ?? '').sort()
}

/** A ustar archive of a tree, as `tar -x` takes it in busybox and coreutils images alike. */
function tarOf(tree: SeedTree): Uint8Array {
  const blocks: Uint8Array[] = []
  const header = (name: string, type: '0' | '5', size: number) => {
    const block = new Uint8Array(512)
    const put = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset)
    const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`
    put(0, name)
    put(100, octal(type === '5' ? 0o755 : 0o644, 8))
    put(108, octal(0, 8))
    put(116, octal(0, 8))
    put(124, octal(size, 12))
    put(136, octal(Math.floor(Date.now() / 1000), 12))
    put(148, '        ')
    put(156, type)
    put(257, 'ustar\u000000')
    const sum = block.reduce((total, byte) => total + byte, 0)
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
    return block
  }
  const folders = new Set<string>()
  const addFolders = (path: string) => {
    const segments = path.split('/')
    for (let i = 1; i <= segments.length; i++) {
      const folder = segments.slice(0, i).join('/')
      if (!folders.has(folder)) blocks.push(header(`${folder}/`, '5', 0))
      folders.add(folder)
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (content === null) {
      addFolders(path)
      continue
    }
    if (path.includes('/')) addFolders(path.slice(0, path.lastIndexOf('/')))
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    blocks.push(header(path, '0', bytes.length), bytes, new Uint8Array((512 - (bytes.length % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  return new Uint8Array(Buffer.concat(blocks))
}

/**
 * Writes a tree into a new folder in a container of the Files namespace; resolves to the folder's path, and to `remove` it.
 * Sent as a tar on stdin, which needs a cluster that speaks the v5 exec protocol (Kubernetes 1.30 on): with older ones,
 * the end of stdin closes the whole exec before tar is done.
 */
export async function seedContainerFolder(pod: string, tree: SeedTree, container = 'app') {
  const config = kubeConfigFor(context ?? '')
  const target: ExecTarget = { namespace: testFilesNamespace, pod, container }
  const path = `/tmp/contract-${randomUUID()}`
  const unpacked = await execInPod(config, target, ['sh', '-c', 'mkdir -p "$1" && tar -xf - -C "$1"', 'sh', path], tarOf(tree))
  if (unpacked.exitCode !== 0) throw new Error(`Seeding ${pod} failed: ${unpacked.stderr}`)
  const remove = async () => {
    await execInPod(config, target, ['rm', '-rf', path])
  }
  return { path, remove }
}

/** What the seed's `counter` pod prints, one line each, before it sleeps: `line 1` to `line 100`. */
export const counterLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)

/**
 * A namespace of the test's own holding a `ticker` pod, which prints `tick 1`, `tick 2`… a second apart,
 * then fails after `ticks` of them, so it restarts (the first time about ten seconds later). Resolves once
 * the pod is running; `remove` deletes the namespace.
 */
export async function tickerNamespace(namespace: string, ticks: number) {
  const script = `i=0; while [ $i -lt ${ticks} ]; do i=$((i+1)); echo "tick $i"; sleep 1; done; exit 1`
  return podNamespace(namespace, 'ticker', script, (status) => status.state?.running !== undefined)
}

/**
 * Creates `namespace` with a pod, `restarted`, whose container logs "crashing" and crashes on its first run, then
 * logs "running" and keeps running. Its crashed run stays its Previous Log, unlike a crash-looping container's:
 * between runs, that one's last run is the current one, and Kubernetes has already removed the run before it.
 */
export async function restartedOnceNamespace(namespace: string) {
  // The marker is kept in an emptyDir, which outlives the container, so only the first run crashes.
  const script = 'if [ -e /state/crashed ]; then echo running; exec sleep 3600; fi; touch /state/crashed; echo crashing; exit 1'
  return podNamespace(namespace, 'restarted', script, (status) => (status.restartCount ?? 0) > 0 && status.state?.running !== undefined, {
    volumes: [{ name: 'state', emptyDir: {} }],
    mounts: [{ name: 'state', mountPath: '/state' }]
  })
}

/** Creates `namespace` with a pod of one busybox container, both named `name`, running `script`, once `ready` holds for it. */
async function podNamespace(
  namespace: string,
  name: string,
  script: string,
  ready: (status: V1ContainerStatus) => boolean,
  { volumes, mounts }: { volumes?: V1PodSpec['volumes']; mounts?: V1PodSpec['containers'][number]['volumeMounts'] } = {}
) {
  const api = kubeConfigFor(context ?? '').makeApiClient(CoreV1Api)
  await api.createNamespace({ body: { metadata: { name: namespace } } })
  const remove = () => api.deleteNamespace({ name: namespace, gracePeriodSeconds: 0 }).then(() => undefined)
  try {
    // A bare pod isn't retried like a Workload's: its namespace's default ServiceAccount has to be there first.
    await until(() => api.readNamespacedServiceAccount({ name: 'default', namespace }).then(() => true, () => false))
    await api.createNamespacedPod({
      namespace,
      body: {
        metadata: { name },
        spec: {
          terminationGracePeriodSeconds: 0,
          volumes,
          containers: [{ name, image: 'busybox:1.36', command: ['sh', '-c', script], volumeMounts: mounts }]
        }
      }
    })
    await until(async () => {
      const status = (await api.readNamespacedPod({ name, namespace })).status?.containerStatuses?.[0]
      return status !== undefined && ready(status)
    })
  } catch (error) {
    await remove()
    throw error
  }
  return { remove }
}

/** Waits until `check` holds, looking every half second for up to two minutes. */
async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 240; tries++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Gave up waiting for the test cluster')
}
