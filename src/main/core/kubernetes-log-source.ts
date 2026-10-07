import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { ApiException, type KubeConfig, type V1Job, type V1ObjectMeta, type V1Pod } from '@kubernetes/client-node'
import type { ContainerNode, ContainerRole, LogNode, PodNode, SourcePath, WorkloadKind, WorkloadNode } from '@shared/core-api'
import { CoreError } from './core-error'
import {
  apisFor,
  asCoreError,
  call,
  checkNamespace,
  controllerOf,
  listReplicaSets,
  podsOfWorkload,
  podsOwnedBy,
  serverMessage,
  type PodOwnerKind
} from './kubernetes-api'
import type { LogConnection, LogFollowOptions, LogReadOptions, LogSource, LogStreamInfo } from './log-source'
import { containerInstanceOf, isSidecar, podStatusOf, readyCountOf, restartsOf } from './pod-status'

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

const notFound = (path: SourcePath) => new CoreError('NOT_FOUND', `Nothing at ${path} in the namespace`)

const notALog = (path: SourcePath) => new CoreError('NOT_A_LOG_STREAM', `Only containers have logs: ${path}`)

const previousLogGone = (path: SourcePath) => new CoreError('PREVIOUS_LOG_GONE', `The previous run’s log is no longer available: ${path}`)

/** A failed log request as a CoreError: the API server answers 400 when a container has no log to give, e.g. one still waiting to start. */
function logError(error: unknown): CoreError {
  if (error instanceof ApiException && error.code === 400) return new CoreError('LOG_UNAVAILABLE', serverMessage(error))
  return asCoreError(error)
}

/**
 * What the API server answers, successfully, for a run of a container the kubelet no longer keeps, whatever its
 * runtime: e.g. `unable to retrieve container logs for containerd://<container id>`.
 */
const removedRunPattern = /^unable to retrieve container logs for [a-z][a-z0-9+.-]*:\/\/\S+\n?$/

/** The whole body of a response, as text. */
async function bodyOf(response: IncomingMessage): Promise<string> {
  response.setEncoding('utf8')
  let body = ''
  for await (const chunk of response) body += chunk
  return body
}

const join = (parent: SourcePath, name: string) => (parent ? `${parent}/${name}` : name)

/**
 * The Workloads, pods and containers of one namespace, as a Log Source. Paths start with a group
 * (`deployments`, `cronjobs`…), then name each object on the way down, e.g. `cronjobs/nightly/<job>/<pod>/<container>`.
 * A CronJob with one Job, a Workload with one pod and a pod with one container carry it folded in, paths keeping every level.
 */
export function createKubernetesLogSource(config: KubeConfig, namespace: string): LogSource & { checkNamespace(): Promise<void> } {
  const apis = apisFor(config)
  const { core, apps, batch } = apis

  const listPods = async () => (await call(() => core.listNamespacedPod({ namespace }))).items
  const cronJobs = async () => (await call(() => batch.listNamespacedCronJob({ namespace }))).items
  const listJobs = async () => (await call(() => batch.listNamespacedJob({ namespace }))).items
  /** Jobs outside any CronJob. */
  const standaloneJobs = async () => (await listJobs()).filter((job) => controllerOf(job.metadata)?.kind !== 'CronJob')

  const names = (items: { metadata?: V1ObjectMeta }[]) => items.map((item) => item.metadata?.name ?? '').filter(Boolean)

  /** A group's Workloads, or for Pods, the pods no Workload owns. */
  const members = async (group: Group): Promise<{ metadata?: V1ObjectMeta }[]> => {
    switch (group) {
      case 'deployments':
        return (await call(() => apps.listNamespacedDeployment({ namespace }))).items
      case 'statefulsets':
        return (await call(() => apps.listNamespacedStatefulSet({ namespace }))).items
      case 'daemonsets':
        return (await call(() => apps.listNamespacedDaemonSet({ namespace }))).items
      case 'cronjobs':
        return await cronJobs()
      case 'jobs':
        return await standaloneJobs()
      case 'pods':
        return (await listPods()).filter((pod) => !controllerOf(pod.metadata))
    }
  }

  const isStandaloneJob = async (name: string) => names(await members('jobs')).includes(name)

  /** The pods of a Workload (a CronJob's Job included); NOT_FOUND if the group has no such Workload. */
  const podsOf = (group: Exclude<Group, 'pods' | 'cronjobs'>, name: string): Promise<V1Pod[]> =>
    podsOfWorkload(apis, namespace, kindOfGroup[group] as PodOwnerKind, name, listPods())

  /** Of a namespace's Jobs, those of the CronJob with `uid`. */
  const jobsOwnedBy = (uid: string | undefined, jobs: V1Job[]) => (uid ? jobs.filter((job) => controllerOf(job.metadata)?.uid === uid) : [])

  /** A CronJob's Jobs; NOT_FOUND if there's no such CronJob. */
  const jobsOf = async (cronJob: string) => {
    const [owner, jobs] = await Promise.all([call(() => batch.readNamespacedCronJob({ name: cronJob, namespace })), listJobs()])
    return jobsOwnedBy(owner.metadata?.uid, jobs)
  }

  /** What's listed only to fold a level into its parent: undefined if the user may not list it, the parent then listed unfolded. */
  const unlessDenied = async <T>(listing: Promise<T>): Promise<T | undefined> => {
    try {
      return await listing
    } catch (error) {
      const { code } = error as CoreError
      if (code === 'MISSING_PERMISSION' || code === 'PERMISSION_DENIED') return undefined
      throw error
    }
  }

  /**
   * Finds the pods of Workloads of a kind among the namespace's, to fold a Workload's only pod into it. Undefined
   * if the user may not list the pods (or a Deployment's ReplicaSets): the Workloads are listed unfolded.
   */
  const podFinder = async (kind: PodOwnerKind) => {
    const listed = await unlessDenied(Promise.all([listPods(), kind === 'Deployment' ? listReplicaSets(apis, namespace) : []]))
    if (!listed) return undefined
    const [pods, replicaSets] = listed
    return (uid: string | undefined) => podsOwnedBy(kind, uid, pods, replicaSets)
  }

  /** A pod's containers, init and sidecar containers first as they start first. */
  const containerNodes = (parent: SourcePath, pod: V1Pod): ContainerNode[] => {
    const node = (name: string, role?: ContainerRole): ContainerNode => {
      const restarts = restartsOf(pod, name)
      return { kind: 'container', name, path: join(parent, name), ...(role && { role }), ...(restarts && { restarts }) }
    }
    return [
      ...(pod.spec?.initContainers ?? []).map((c) => node(c.name, isSidecar(c) ? 'sidecar' : 'init')),
      ...(pod.spec?.containers ?? []).map((c) => node(c.name))
    ]
  }

  /** A pod's node, its only container folded in if it has just the one. */
  const podNode = (parent: SourcePath, pod: V1Pod): PodNode => {
    const name = pod.metadata?.name ?? ''
    const path = join(parent, name)
    const containers = containerNodes(path, pod)
    const folded = containers.length === 1 && { container: containers[0]! }
    return { kind: 'pod', name, path, status: podStatusOf(pod), containerCount: containers.length, ...folded }
  }

  const podNodes = (parent: SourcePath, pods: V1Pod[]): PodNode[] => pods.filter((pod) => pod.metadata?.name).map((pod) => podNode(parent, pod))

  /**
   * A Workload's node, with its Ready Count if its kind has one; its only pod folded in if `pods` are its pods and
   * there's just the one, or for a CronJob, its only Job if `jobs` are its Jobs and there's just the one. Marked
   * empty if those are known and there are none.
   */
  const workloadNode = (
    parent: SourcePath,
    kind: Exclude<WorkloadKind, 'Pod'>,
    workload: { metadata?: V1ObjectMeta },
    { pods, jobs }: { pods?: V1Pod[]; jobs?: { job: V1Job; pods?: V1Pod[] }[] } = {}
  ): WorkloadNode => {
    const name = workload.metadata?.name ?? ''
    const path = join(parent, name)
    const readyCount = readyCountOf(kind, workload)
    const [onlyPod, ...otherPods] = pods?.filter((pod) => pod.metadata?.name) ?? []
    const [onlyJob, ...otherJobs] = jobs?.filter(({ job }) => job.metadata?.name) ?? []
    const children = kind === 'CronJob' ? jobs : pods
    const folded =
      children?.length === 0 ? { empty: true as const }
      : onlyJob && otherJobs.length === 0 ? { job: workloadNode(path, 'Job', onlyJob.job, { pods: onlyJob.pods }) }
      : onlyPod && otherPods.length === 0 ? { pod: podNode(path, onlyPod) }
      : undefined
    return { kind: 'workload', workloadKind: kind, name, path, ...(readyCount && { readyCount }), ...folded }
  }

  /** A group's Workloads, each carrying its only pod, or a CronJob its only Job, folded in. */
  const workloadNodes = async (group: Exclude<Group, 'pods'>): Promise<WorkloadNode[]> => {
    const kind = kindOfGroup[group] as Exclude<WorkloadKind, 'Pod'>
    const [items, podsOf, jobs] = await Promise.all([
      members(group),
      podFinder(kind === 'CronJob' ? 'Job' : (kind as PodOwnerKind)),
      kind === 'CronJob' ? unlessDenied(listJobs()) : []
    ])
    return items
      .filter((item) => item.metadata?.name)
      .map((item) => {
        const uid = item.metadata?.uid
        if (kind !== 'CronJob') return workloadNode(group, kind, item, { pods: podsOf?.(uid) })
        const owned = jobs && jobsOwnedBy(uid, jobs).map((job) => ({ job, pods: podsOf?.(job.metadata?.uid) }))
        return workloadNode(group, kind, item, { jobs: owned })
      })
  }

  /** A CronJob's Jobs, each carrying its only pod folded in. */
  const jobNodes = async (parent: SourcePath, cronJob: string): Promise<WorkloadNode[]> => {
    const [jobs, podsOf] = await Promise.all([jobsOf(cronJob), podFinder('Job')])
    return jobs.filter((job) => job.metadata?.name).map((job) => workloadNode(parent, 'Job', job, { pods: podsOf?.(job.metadata?.uid) }))
  }

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
      const listed = await Promise.all(Object.values(groups).map(async (g) => [g, names(await members(g)).length > 0] as const))
      return listed.filter(([, any]) => any).map(([g]) => ({ kind: 'group', workloadKind: kindOfGroup[g], name: g, path: g }))
    }
    if (!isGroup(group) || segments.some((segment) => !segment)) throw notFound(path)
    if (first === undefined) {
      return group === 'pods' ? podNodes(path, (await members(group)) as V1Pod[]) : await workloadNodes(group)
    }
    if (segments.length === 2) {
      if (group === 'pods') {
        const pod = podNamed((await listPods()).filter((p) => !controllerOf(p.metadata)), first, path)
        return containerNodes(path, pod)
      }
      if (group === 'cronjobs') return await jobNodes(path, first)
      if (group === 'jobs' && !(await isStandaloneJob(first))) throw notFound(path)
      return podNodes(path, await podsOf(group, first))
    }
    if (segments.length === 3 && group === 'cronjobs') {
      if (!names(await jobsOf(first)).includes(second!)) throw notFound(path)
      return podNodes(path, await podsOf('jobs', second!))
    }
    if (segments.length === 3 && group !== 'pods' && group !== 'cronjobs') {
      if (group === 'jobs' && !(await isStandaloneJob(first))) throw notFound(path)
      return containerNodes(path, podNamed(await podsOf(group, first), second!, path))
    }
    if (segments.length === 4 && group === 'cronjobs') {
      if (!names(await jobsOf(first)).includes(second!)) throw notFound(path)
      return containerNodes(path, podNamed(await podsOf('jobs', second!), third!, path))
    }
    // Deeper than any container: the path is a log's, or nothing's.
    throw (await nodeAt(path))?.kind === 'container' ? new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`) : notFound(path)
  }

  /** The children of a node, none if there's no such node or it has none. */
  const childrenOf = (path: SourcePath) =>
    listChildren(path).catch((error: CoreError) => {
      if (error.code === 'NOT_FOUND' || error.code === 'NOT_A_FOLDER') return []
      throw error
    })

  /** The node at a path, found among its parent's children; undefined if it isn't there. */
  const nodeAt = async (path: SourcePath): Promise<LogNode | undefined> => {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')))
    if (!parent) return undefined
    return (await childrenOf(parent)).find((node) => node.path === path)
  }

  const logStreamAt = async (path: SourcePath): Promise<LogStreamInfo> => {
    if (!path || isGroup(path)) throw notALog(path)
    const node = await nodeAt(path)
    if (!node) throw notFound(path)
    if (node.kind !== 'container') throw notALog(path)
    return { pod: path.split('/').at(-2)!, container: node.name, restarts: node.restarts ?? 0 }
  }

  /** Opens a connection following a container's log; resolves once the API server answers with the log. */
  const openLogConnection = async (pod: string, container: string, options: LogFollowOptions, onText: (text: string) => void) => {
    const cluster = config.getCurrentCluster()
    if (!cluster) throw new CoreError('UNKNOWN', 'The kubeconfig context has no cluster')
    const url = new URL(`${cluster.server.replace(/\/+$/, '')}/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/log`)
    url.searchParams.set('container', container)
    url.searchParams.set('follow', 'true')
    url.searchParams.set('timestamps', 'true')
    if (options.sinceTime !== undefined) url.searchParams.set('sinceTime', options.sinceTime)
    // The kubeconfig's TLS settings, credentials (exec plugins included) and proxy, as for any other call.
    const requestOptions: RequestOptions = {}
    await call(() => config.applyToHTTPSOptions(requestOptions))
    const https = url.protocol === 'https:'
    if (!https && requestOptions.agent instanceof HttpsAgent) delete requestOptions.agent
    return new Promise<LogConnection>((resolve, reject) => {
      const request = (https ? httpsRequest : httpRequest)(url, { ...requestOptions, method: 'GET' }, (response) => {
        if (response.statusCode !== 200) {
          const status = response.statusCode ?? 500
          void bodyOf(response).then(
            (body) => reject(logError(new ApiException(status, `HTTP ${status}`, body, {}))),
            (error: unknown) => reject(asCoreError(error))
          )
          return
        }
        response.setEncoding('utf8')
        const ended = new Promise<void>((done, fail) => {
          response.on('data', onText)
          response.on('end', done)
          response.on('error', (error) => fail(asCoreError(error)))
          // Closed before its end: the connection dropped, or the stream was stopped.
          response.on('close', () => fail(new CoreError('UNREACHABLE', 'The log stream was cut off')))
        })
        // Settled whether or not anyone is still waiting on it, say after stopping.
        ended.catch(() => undefined)
        resolve({ ended, stop: () => request.destroy() })
      })
      request.on('error', (error) => reject(asCoreError(error)))
      // A quiet log sends nothing for long stretches; keep-alive probes are what notice a connection that died meanwhile.
      request.on('socket', (socket) => socket.setKeepAlive(true, 15_000))
      request.end()
    })
  }

  return {
    listChildren,
    logStreamAt,

    async readLog(path, { previous = false, ...options }: LogReadOptions = {}) {
      const { pod, container } = await logStreamAt(path)
      let text: string
      try {
        text = await core.readNamespacedPodLog({ name: pod, namespace, container, previous, ...options })
      } catch (error) {
        throw logError(error)
      }
      // A current log that reads so is what the container itself logged.
      if (previous && removedRunPattern.test(text)) throw previousLogGone(path)
      return text
    },

    async followLog(path, options, onText) {
      const { pod, container } = await logStreamAt(path)
      return openLogConnection(pod, container, options, onText)
    },

    /** Reads just the pod, trusting the path, as it's looked at every few seconds while a container restarts. */
    async containerInstance(path) {
      const [pod, container] = path.split('/').slice(-2)
      const found = await call(() => core.readNamespacedPod({ name: pod!, namespace }))
      const instance = containerInstanceOf(found, container!)
      if (!instance) throw notFound(path)
      return instance
    },

    checkNamespace: () => checkNamespace(core, namespace)
  }
}
