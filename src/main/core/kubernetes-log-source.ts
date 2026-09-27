import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  type KubeConfig,
  type V1ObjectMeta,
  type V1Pod
} from '@kubernetes/client-node'
import type { LogNode, SourcePath, WorkloadKind } from '@shared/core-api'
import { CoreError } from './core-error'
import type { LogReadOptions, LogSource } from './log-source'
import { certificateCodes, networkCodes } from './network-errors'

/** Each group's path segment, which is also its name. */
const groups = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  CronJob: 'cronjobs',
  Job: 'jobs',
  Pod: 'pods'
} as const satisfies Record<WorkloadKind, string>

type Group = (typeof groups)[WorkloadKind]

const kindOfGroup = Object.fromEntries(Object.entries(groups).map(([kind, group]) => [group, kind])) as Record<Group, WorkloadKind>

const isGroup = (segment: string | undefined): segment is Group => Object.hasOwn(kindOfGroup, segment ?? '')

/** What owns an object: the owner reference marked as its controller. */
const controllerOf = (meta: V1ObjectMeta | undefined) => meta?.ownerReferences?.find((owner) => owner.controller)

/** The error codes along an error and its causes, e.g. a failed fetch's ECONNREFUSED. */
function codesOf(error: unknown): string[] {
  const codes: string[] = []
  for (let cause = error; cause instanceof Error && codes.length < 10; cause = cause.cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
  }
  return codes
}

/** The message the API server gave with a failed call, which ApiException buries in a longer one. */
function serverMessage({ code, body }: { code: number; body: unknown }): string {
  let status: unknown = body
  if (typeof body === 'string') {
    try {
      status = JSON.parse(body)
    } catch {
      return body || `HTTP ${code}`
    }
  }
  const message = (status as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : `HTTP ${code}`
}

/** A failed Kubernetes call as a CoreError. */
function asCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error
  if (error instanceof ApiException) {
    const message = serverMessage(error)
    if (error.code === 401) return new CoreError('AUTH_FAILED', message)
    if (error.code === 403) return new CoreError('PERMISSION_DENIED', message)
    if (error.code === 404) return new CoreError('NOT_FOUND', message)
    return new CoreError('UNKNOWN', message)
  }
  const message = error instanceof Error ? error.message : String(error)
  const codes = codesOf(error)
  // An exec auth plugin (aws, gke-gcloud-auth-plugin, kubelogin…) that isn't on the PATH.
  const spawn = (error as { syscall?: unknown } | null)?.syscall
  if (codes.includes('ENOENT') && typeof spawn === 'string' && spawn.startsWith('spawn')) {
    return new CoreError('CREDENTIALS_UNAVAILABLE', `${spawn.slice('spawn '.length)} was not found: ${message}`)
  }
  if (codes.some((code) => networkCodes.has(code))) return new CoreError('UNREACHABLE', `${message} (${codes.join(', ')})`)
  if (codes.some((code) => certificateCodes.has(code))) return new CoreError('CERTIFICATE_UNTRUSTED', message)
  return new CoreError('UNKNOWN', message)
}

const notFound = (path: SourcePath) => new CoreError('NOT_FOUND', `Nothing at ${path} in the namespace`)

const join = (parent: SourcePath, name: string) => (parent ? `${parent}/${name}` : name)

/**
 * The Workloads, pods and containers of one namespace, as a Log Source. Paths start with a group
 * (`deployments`, `cronjobs`…), then name each object on the way down, e.g. `cronjobs/nightly/<job>/<pod>/<container>`.
 */
export function createKubernetesLogSource(config: KubeConfig, namespace: string): LogSource & { checkNamespace(): Promise<void> } {
  const core = config.makeApiClient(CoreV1Api)
  const apps = config.makeApiClient(AppsV1Api)
  const batch = config.makeApiClient(BatchV1Api)

  /** Runs a Kubernetes call, turning its failure into a CoreError. */
  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request()
    } catch (error) {
      throw asCoreError(error)
    }
  }

  const listPods = async () => (await call(() => core.listNamespacedPod({ namespace }))).items
  const cronJobs = async () => (await call(() => batch.listNamespacedCronJob({ namespace }))).items
  /** Jobs outside any CronJob. */
  const standaloneJobs = async () =>
    (await call(() => batch.listNamespacedJob({ namespace }))).items.filter((job) => controllerOf(job.metadata)?.kind !== 'CronJob')

  const names = (items: { metadata?: V1ObjectMeta }[]) => items.map((item) => item.metadata?.name ?? '').filter(Boolean)

  /** The names of a group's Workloads, or for Pods, the pods no Workload owns. */
  const members = async (group: Group): Promise<string[]> => {
    switch (group) {
      case 'deployments':
        return names((await call(() => apps.listNamespacedDeployment({ namespace }))).items)
      case 'statefulsets':
        return names((await call(() => apps.listNamespacedStatefulSet({ namespace }))).items)
      case 'daemonsets':
        return names((await call(() => apps.listNamespacedDaemonSet({ namespace }))).items)
      case 'cronjobs':
        return names(await cronJobs())
      case 'jobs':
        return names(await standaloneJobs())
      case 'pods':
        return names((await listPods()).filter((pod) => !controllerOf(pod.metadata)))
    }
  }

  const ownedBy = (uids: ReadonlySet<string | undefined>) => (pod: V1Pod) => uids.has(controllerOf(pod.metadata)?.uid)

  /** The pods of a Workload (a CronJob's Job included); NOT_FOUND if the group has no such Workload. */
  const podsOf = async (group: Exclude<Group, 'pods' | 'cronjobs'>, name: string): Promise<V1Pod[]> => {
    const read: () => Promise<{ metadata?: V1ObjectMeta }> = {
      deployments: () => apps.readNamespacedDeployment({ name, namespace }),
      statefulsets: () => apps.readNamespacedStatefulSet({ name, namespace }),
      daemonsets: () => apps.readNamespacedDaemonSet({ name, namespace }),
      jobs: () => batch.readNamespacedJob({ name, namespace })
    }[group]
    const [workload, pods] = await Promise.all([call(read), listPods()])
    const uid = workload.metadata?.uid
    if (group !== 'deployments') return pods.filter(ownedBy(new Set([uid])))
    // A Deployment owns its pods through ReplicaSets, which the tree leaves out.
    const replicaSets = (await call(() => apps.listNamespacedReplicaSet({ namespace }))).items
    const replicaSetUids = new Set(replicaSets.filter((rs) => controllerOf(rs.metadata)?.uid === uid).map((rs) => rs.metadata?.uid))
    return pods.filter(ownedBy(replicaSetUids))
  }

  /** A CronJob's Jobs; NOT_FOUND if there's no such CronJob. */
  const jobsOf = async (cronJob: string) => {
    const [owner, jobs] = await Promise.all([
      call(() => batch.readNamespacedCronJob({ name: cronJob, namespace })),
      call(() => batch.listNamespacedJob({ namespace }))
    ])
    return jobs.items.filter((job) => controllerOf(job.metadata)?.uid === owner.metadata?.uid)
  }

  const podNodes = (parent: SourcePath, pods: V1Pod[]): LogNode[] =>
    names(pods).map((name) => ({ kind: 'pod', name, path: join(parent, name) }))

  /** A pod's containers, init and sidecar containers first as they start first. */
  const containerNodes = (parent: SourcePath, pod: V1Pod): LogNode[] => [
    ...(pod.spec?.initContainers ?? []).map(
      (c): LogNode => ({ kind: 'container', name: c.name, path: join(parent, c.name), role: c.restartPolicy === 'Always' ? 'sidecar' : 'init' })
    ),
    ...(pod.spec?.containers ?? []).map((c): LogNode => ({ kind: 'container', name: c.name, path: join(parent, c.name) }))
  ]

  /** The pod named `name` among `pods`, or NOT_FOUND. */
  const podNamed = (pods: V1Pod[], name: string, path: SourcePath) => {
    const pod = pods.find((p) => p.metadata?.name === name)
    if (!pod) throw notFound(path)
    return pod
  }

  const listChildren = async (path: SourcePath): Promise<LogNode[]> => {
    const segments = path ? path.split('/') : []
    const [group, first, second, third] = segments
    if (segments.length === 0) {
      const listed = await Promise.all(Object.values(groups).map(async (g) => [g, (await members(g)).length > 0] as const))
      return listed.filter(([, any]) => any).map(([g]) => ({ kind: 'group', workloadKind: kindOfGroup[g], name: g, path: g }))
    }
    if (!isGroup(group) || segments.some((segment) => !segment)) throw notFound(path)
    if (first === undefined) {
      const kind = kindOfGroup[group]
      return (await members(group)).map((name) =>
        kind === 'Pod' ? { kind: 'pod', name, path: join(path, name) } : { kind: 'workload', workloadKind: kind, name, path: join(path, name) }
      )
    }
    if (segments.length === 2) {
      if (group === 'pods') {
        const pod = podNamed((await listPods()).filter((p) => !controllerOf(p.metadata)), first, path)
        return containerNodes(path, pod)
      }
      if (group === 'cronjobs') {
        return names(await jobsOf(first)).map((name) => ({ kind: 'workload', workloadKind: 'Job', name, path: join(path, name) }))
      }
      if (group === 'jobs' && !(await members('jobs')).includes(first)) throw notFound(path)
      return podNodes(path, await podsOf(group, first))
    }
    if (segments.length === 3 && group === 'cronjobs') {
      if (!names(await jobsOf(first)).includes(second!)) throw notFound(path)
      return podNodes(path, await podsOf('jobs', second!))
    }
    if (segments.length === 3 && group !== 'pods' && group !== 'cronjobs') {
      if (group === 'jobs' && !(await members('jobs')).includes(first)) throw notFound(path)
      return containerNodes(path, podNamed(await podsOf(group, first), second!, path))
    }
    if (segments.length === 4 && group === 'cronjobs') {
      if (!names(await jobsOf(first)).includes(second!)) throw notFound(path)
      return containerNodes(path, podNamed(await podsOf('jobs', second!), third!, path))
    }
    // Deeper than any container: the path is a container's, or nothing's.
    throw (await nodeAt(path))?.kind === 'container' ? new CoreError('NOT_A_FOLDER', `A container has no children: ${path}`) : notFound(path)
  }

  /** The node at a path, found among its parent's children; undefined if it isn't there. */
  const nodeAt = async (path: SourcePath): Promise<LogNode | undefined> => {
    const cut = path.lastIndexOf('/')
    if (cut < 0) return undefined
    const siblings = await listChildren(path.slice(0, cut)).catch((error: CoreError) => {
      if (error.code === 'NOT_FOUND' || error.code === 'NOT_A_FOLDER') return []
      throw error
    })
    return siblings.find((node) => node.path === path)
  }

  return {
    listChildren,

    async readLog(path, options: LogReadOptions = {}) {
      if (!path || isGroup(path)) throw new CoreError('NOT_A_LOG_STREAM', `Only containers have logs: ${path}`)
      const node = await nodeAt(path)
      if (!node) throw notFound(path)
      if (node.kind !== 'container') throw new CoreError('NOT_A_LOG_STREAM', `Only containers have logs: ${path}`)
      const segments = path.split('/')
      const pod = segments.at(-2)!
      try {
        return await core.readNamespacedPodLog({ name: pod, namespace, container: node.name, ...options })
      } catch (error) {
        // The API server answers 400 when a container has no log to give, e.g. one still waiting to start.
        if (error instanceof ApiException && error.code === 400) throw new CoreError('LOG_UNAVAILABLE', serverMessage(error))
        throw asCoreError(error)
      }
    },

    /** Fails with NAMESPACE_NOT_FOUND if the namespace isn't there; a user who may not read namespaces gets the benefit of the doubt. */
    async checkNamespace() {
      try {
        await call(() => core.readNamespace({ name: namespace }))
      } catch (error) {
        const { code } = error as CoreError
        if (code === 'NOT_FOUND') throw new CoreError('NAMESPACE_NOT_FOUND', `No namespace named ${namespace}`)
        if (code !== 'PERMISSION_DENIED') throw error
      }
    }
  }
}
