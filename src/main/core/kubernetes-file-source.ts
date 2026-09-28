import type { KubeConfig, V1Container, V1Pod } from '@kubernetes/client-node'
import type { FilesWorkloadKind, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileEntry, FileSource } from './file-source'
import { apisFor, call, checkNamespace, podsOfWorkload, readWorkload, sortedNames } from './kubernetes-api'
import { podShell } from './kubernetes-exec'
import { isSidecar, podStatusOf } from './pod-status'
import { createShellFileSource } from './shell-file-source'

/** Where a Kubernetes Files Source looks: a folder in the containers of one Workload's pods. */
export interface KubernetesFilesTarget {
  namespace: string
  workloadKind: FilesWorkloadKind
  workloadName: string
  /** Absolute, in each container. */
  path: string
}

/** The containers of a pod that can be browsed, as they keep running: its sidecars, then its main containers. */
const browsableContainers = (pod: V1Pod): V1Container[] => [
  ...(pod.spec?.initContainers ?? []).filter(isSidecar),
  ...(pod.spec?.containers ?? [])
]

/** Whether a container of a pod is running now, so a command can run in it. */
function isRunning(pod: V1Pod, container: string) {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
  return statuses.some((status) => status.name === container && status.state?.running)
}

/**
 * The files of one Workload's pods, as a File Source: its root holds a folder per pod; a pod with several
 * containers holds a folder per container; below that is the target path's contents in that container, listed
 * and read by running commands in it (see shell-file-source.ts). Paths are `<pod>/<path…>`, or
 * `<pod>/<container>/<path…>` for a pod with several containers.
 */
export function createKubernetesFileSource(config: KubeConfig, target: KubernetesFilesTarget): FileSource & { check(): Promise<void> } {
  const apis = apisFor(config)
  const { namespace, workloadKind, workloadName } = target

  /** A pod, read afresh; POD_GONE once it has been deleted, say by a rollout. */
  const readPod = async (name: string) => {
    try {
      return await call(() => apis.core.readNamespacedPod({ name, namespace }))
    } catch (error) {
      if ((error as CoreError).code === 'NOT_FOUND') throw new CoreError('POD_GONE', `Pod ${name} no longer exists`)
      throw error
    }
  }

  /**
   * What a path is: the root, a pod with several containers, or somewhere in one container, with the path
   * inside the target folder there. Only the pod is read, trusting that the path came from the tree.
   */
  const resolve = async (path: SourcePath) => {
    if (!path) return { at: 'root' } as const
    const [podName = '', ...rest] = path.split('/')
    const pod = await readPod(podName)
    const containers = browsableContainers(pod).map((c) => c.name)
    if (containers.length > 1 && rest.length === 0) return { at: 'pod', pod } as const
    const container = containers.length > 1 ? rest.shift()! : containers[0]
    if (!container || !containers.includes(container)) throw new CoreError('NOT_FOUND', `No container ${container} in pod ${podName}`)
    return { at: 'container', pod, container, inner: rest.join('/') } as const
  }

  /** A File Source over the target folder in one container, once it's clear the container is running. */
  const filesIn = (pod: V1Pod, container: string) => {
    const name = pod.metadata?.name ?? ''
    if (!isRunning(pod, container)) throw new CoreError('CONTAINER_NOT_RUNNING', `${container} in pod ${name} isn’t running`)
    return createShellFileSource(podShell(config, { namespace, pod: name, container }), target.path)
  }

  const listPods = async (): Promise<FileEntry[]> => {
    const pods = await podsOfWorkload(apis, namespace, workloadKind, workloadName)
    return pods
      .filter((pod) => pod.metadata?.name)
      .map((pod) => ({
        kind: 'folder',
        name: pod.metadata!.name!,
        kubernetes: { kind: 'pod', status: podStatusOf(pod), containerCount: browsableContainers(pod).length }
      }))
  }

  const listContainers = (pod: V1Pod): FileEntry[] =>
    browsableContainers(pod).map((container) => ({
      kind: 'folder',
      name: container.name,
      kubernetes: isSidecar(container) ? { kind: 'container', role: 'sidecar' } : { kind: 'container' }
    }))

  return {
    async listChildren(path) {
      const at = await resolve(path)
      if (at.at === 'root') return { entries: await listPods() }
      if (at.at === 'pod') return { entries: listContainers(at.pod) }
      return filesIn(at.pod, at.container).listChildren(at.inner)
    },

    async stat(path) {
      const at = await resolve(path)
      if (at.at !== 'container') return { kind: 'folder' }
      return filesIn(at.pod, at.container).stat(at.inner)
    },

    async read(path, range) {
      const at = await resolve(path)
      if (at.at !== 'container') throw new CoreError('NOT_A_FILE', `A pod or container is a folder: ${path}`)
      return filesIn(at.pod, at.container).read(at.inner, range)
    },

    /** Fails if the namespace or the Workload isn't there. */
    async check() {
      await checkNamespace(apis.core, namespace)
      try {
        await readWorkload(apis, namespace, workloadKind, workloadName)
      } catch (error) {
        if ((error as CoreError).code !== 'NOT_FOUND') throw error
        throw new CoreError('WORKLOAD_NOT_FOUND', `No ${workloadKind} named ${workloadName} in namespace ${namespace}`)
      }
    }
  }
}

/** The Workloads of a kind in a namespace, by name. */
export async function listWorkloads(config: KubeConfig, namespace: string, kind: FilesWorkloadKind): Promise<string[]> {
  const { apps } = apisFor(config)
  const list = {
    Deployment: () => apps.listNamespacedDeployment({ namespace }),
    StatefulSet: () => apps.listNamespacedStatefulSet({ namespace }),
    DaemonSet: () => apps.listNamespacedDaemonSet({ namespace })
  }[kind]
  return sortedNames((await call(list)).items)
}
