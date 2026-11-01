import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { ApiException, type CoreV1Event, type KubeConfig, type V1Job, type V1ObjectMeta, type V1Pod } from '@kubernetes/client-node'
import {
  kubernetesEventsPath,
  type ContainerRole,
  type LogGroupNode,
  type LogNode,
  type LogStreamCapabilities,
  type LogStreamNode,
  type SourcePath,
  type WorkloadKind
} from '@shared/core-api'
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
import { currentRunOf, isSidecar, podStatusOf, readyCountOf, restartsOf } from './pod-status'

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

/** The capabilities of Kubernetes Logs' the namespace's Events lack: they don't restart, so have no Previous Log (ADR 0010). */
const eventsCapabilities: LogStreamCapabilities = { previousLog: false, restarts: false }

/** The namespace's Events, listed first at the root. */
const eventsNode: LogStreamNode = { kind: 'logStream', name: kubernetesEventsPath, path: kubernetesEventsPath, capabilities: eventsCapabilities, kubernetes: { kind: 'events' } }

/** When an Event was last seen, in milliseconds since the epoch: going by the best of the times it carries; NaN if it has none. */
function lastSeen(event: CoreV1Event): number {
  const time = event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata.creationTimestamp
  return time ? new Date(time).getTime() : NaN
}

/** How many times an Event has happened, as its series or its count says; 1 if neither does. */
const countOf = (event: CoreV1Event) => event.series?.count ?? event.count ?? 1

/** An Event as a line: `[Warning] BackOff pod/api-7d9f-x2k: Back-off restarting failed container (×14)`, on one line whatever its message. */
function eventLine(event: CoreV1Event): string {
  const { kind = '', name = '' } = event.involvedObject
  const message = (event.message ?? '').trim().replace(/\s*\n\s*/g, ' ')
  const count = countOf(event)
  return `[${event.type ?? 'Normal'}] ${event.reason ?? ''} ${kind.toLowerCase()}/${name}: ${message}${count > 1 ? ` (×${count})` : ''}`
}

/** When an Event was last seen as a line's timestamp: RFC 3339 in UTC, the epoch's for one with no time at all. */
const lineTimestamp = (at: number) => new Date(Number.isNaN(at) ? 0 : at).toISOString()

/** An Event's line, starting with when it was last seen, ending in a line break. */
const stampedLine = ({ at, line }: { at: number; line: string }) => `${lineTimestamp(at)} ${line}\n`

/**
 * Events as lines, one per Event, by when each was last seen, oldest first (one with no time at all first of all):
 * those last seen since `sinceTime`, each with when it was last seen as its line's timestamp.
 */
function eventLines(events: CoreV1Event[], sinceTime?: string): { at: number; line: string; name: string }[] {
  const since = sinceTime === undefined ? -Infinity : Date.parse(sinceTime)
  return events
    .map((event) => ({ at: lastSeen(event), line: eventLine(event), name: event.metadata.name ?? '' }))
    .toSorted((a, b) => (Number.isNaN(a.at) ? -Infinity : a.at) - (Number.isNaN(b.at) ? -Infinity : b.at))
    .filter(({ at }) => (sinceTime === undefined ? true : at >= since))
}

/**
 * Events as a log, one line per Event, as LogReadOptions ask: those last seen since `sinceTime`, the last `tailLines`
 * of those, each starting with when it was last seen when asked, at about `limitBytes`.
 */
function eventsLog(events: CoreV1Event[], { tailLines, limitBytes, timestamps, sinceTime }: LogReadOptions): string {
  const seen = eventLines(events, sinceTime)
  const kept = tailLines === undefined ? seen : seen.slice(Math.max(0, seen.length - tailLines))
  const text = kept.map((seen) => (timestamps ? stampedLine(seen) : `${seen.line}\n`)).join('')
  return limitBytes === undefined ? text : text.slice(0, limitBytes)
}

/** What a watch on Events sends, one JSON object a line: a change to an Event, a bookmark, or an error, as a Status. */
interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  object: CoreV1Event | { kind?: string; code?: number; message?: string }
}

/**
 * The Workloads, pods and containers of one namespace, as a Log Source whose Log Streams are containers. Paths start
 * with a group (`deployments`, `cronjobs`…), then name each object on the way down, e.g. `cronjobs/nightly/<job>/<pod>/<container>`.
 * A CronJob with one Job, a Workload with one pod and a pod with one container carry it folded in, paths keeping every level.
 * The namespace's Events are a Log Stream of their own, `events`, listed first at the root.
 * It has every capability: containers restart and keep a Previous Log, pods have a Pod Status, and logs can be read
 * from a time on (Since). Events have no Previous Log and don't restart.
 */
export function createKubernetesLogSource(config: KubeConfig, namespace: string): LogSource & { checkNamespace(): Promise<void> } {
  const apis = apisFor(config)
  const { core, apps, batch } = apis

  const listPods = async () => (await call(() => core.listNamespacedPod({ namespace }))).items
  const listEvents = async () => (await call(() => core.listNamespacedEvent({ namespace }))).items
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
  const containerNodes = (parent: SourcePath, pod: V1Pod): LogStreamNode[] => {
    const node = (name: string, role?: ContainerRole): LogStreamNode => {
      const restarts = restartsOf(pod, name)
      return { kind: 'logStream', name, path: join(parent, name), ...(restarts && { restarts }), kubernetes: { kind: 'container', ...(role && { role }) } }
    }
    return [
      ...(pod.spec?.initContainers ?? []).map((c) => node(c.name, isSidecar(c) ? 'sidecar' : 'init')),
      ...(pod.spec?.containers ?? []).map((c) => node(c.name))
    ]
  }

  /** A pod's node, its only container folded in if it has just the one. */
  const podNode = (parent: SourcePath, pod: V1Pod): LogGroupNode => {
    const name = pod.metadata?.name ?? ''
    const path = join(parent, name)
    const containers = containerNodes(path, pod)
    const folded = containers.length === 1 && { folded: containers[0]! }
    return { kind: 'group', name, path, status: podStatusOf(pod), ...folded, kubernetes: { kind: 'pod', containerCount: containers.length } }
  }

  const podNodes = (parent: SourcePath, pods: V1Pod[]): LogGroupNode[] => pods.filter((pod) => pod.metadata?.name).map((pod) => podNode(parent, pod))

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
  ): LogGroupNode => {
    const name = workload.metadata?.name ?? ''
    const path = join(parent, name)
    const readyCount = readyCountOf(kind, workload)
    const [onlyPod, ...otherPods] = pods?.filter((pod) => pod.metadata?.name) ?? []
    const [onlyJob, ...otherJobs] = jobs?.filter(({ job }) => job.metadata?.name) ?? []
    const children = kind === 'CronJob' ? jobs : pods
    const folded =
      children?.length === 0 ? { empty: true as const }
      : onlyJob && otherJobs.length === 0 ? { folded: workloadNode(path, 'Job', onlyJob.job, { pods: onlyJob.pods }) }
      : onlyPod && otherPods.length === 0 ? { folded: podNode(path, onlyPod) }
      : undefined
    return { kind: 'group', name, path, ...folded, kubernetes: { kind: 'workload', workloadKind: kind, ...(readyCount && { readyCount }) } }
  }

  /** A group's Workloads, each carrying its only pod, or a CronJob its only Job, folded in. */
  const workloadNodes = async (group: Exclude<Group, 'pods'>): Promise<LogGroupNode[]> => {
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
  const jobNodes = async (parent: SourcePath, cronJob: string): Promise<LogGroupNode[]> => {
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
      // Events are listed whether or not there are any, or the user may list them: opening them says.
      return [
        eventsNode,
        ...listed
          .filter(([, any]) => any)
          .map(([g]): LogNode => ({ kind: 'group', name: g, path: g, unfoldable: true, kubernetes: { kind: 'workloads', workloadKind: kindOfGroup[g] } }))
      ]
    }
    if (path === kubernetesEventsPath) throw new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`)
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
    throw (await nodeAt(path))?.kind === 'logStream' ? new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`) : notFound(path)
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

  /** A container's Log Stream: its pod, name and restarts. */
  const containerAt = async (path: SourcePath): Promise<LogStreamInfo & Required<Pick<LogStreamInfo, 'kubernetes'>>> => {
    if (!path || isGroup(path)) throw notALog(path)
    const node = await nodeAt(path)
    if (!node) throw notFound(path)
    if (node.kind !== 'logStream') throw notALog(path)
    const restarts = node.restarts ?? 0
    return { name: node.name, hasPreviousLog: restarts > 0, kubernetes: { pod: path.split('/').at(-2)!, container: node.name, restarts } }
  }

  /** A Log Stream: the namespace's Events, or a container. */
  const logStreamAt = async (path: SourcePath): Promise<LogStreamInfo> =>
    path === kubernetesEventsPath ? { name: kubernetesEventsPath, capabilities: eventsCapabilities } : await containerAt(path)

  /**
   * Asks the API server for what's at a path in the namespace, with the query given, as a stream; resolves with the
   * response once it answers with it, rejecting with what `failed` makes of an error it answers with.
   */
  const streamResponse = async (
    resource: string,
    query: Record<string, string | number | boolean | undefined>,
    failed: (error: unknown) => CoreError = asCoreError
  ) => {
    const cluster = config.getCurrentCluster()
    if (!cluster) throw new CoreError('UNKNOWN', 'The kubeconfig context has no cluster')
    const url = new URL(`${cluster.server.replace(/\/+$/, '')}/api/v1/namespaces/${namespace}/${resource}`)
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value))
    // The kubeconfig's TLS settings, credentials (exec plugins included) and proxy, as for any other call.
    const requestOptions: RequestOptions = {}
    await call(() => config.applyToHTTPSOptions(requestOptions))
    const https = url.protocol === 'https:'
    if (!https && requestOptions.agent instanceof HttpsAgent) delete requestOptions.agent
    return new Promise<{ response: IncomingMessage; stop(): void }>((resolve, reject) => {
      const request = (https ? httpsRequest : httpRequest)(url, { ...requestOptions, method: 'GET' }, (response) => {
        if (response.statusCode !== 200) {
          const status = response.statusCode ?? 500
          void bodyOf(response).then(
            (body) => reject(failed(new ApiException(status, `HTTP ${status}`, body, {}))),
            (error: unknown) => reject(asCoreError(error))
          )
          return
        }
        resolve({ response, stop: () => request.destroy() })
      })
      request.on('error', (error) => reject(asCoreError(error)))
      // A quiet log sends nothing for long stretches; keep-alive probes are what notice a connection that died meanwhile.
      request.on('socket', (socket) => socket.setKeepAlive(true, 15_000))
      request.end()
    })
  }

  /**
   * Asks the API server for a container's log, with the query given; resolves with the response once it answers with
   * the log. Not through the client, which can't read a log since a time.
   */
  const logResponse = (pod: string, container: string, query: Record<string, string | number | boolean | undefined>) =>
    streamResponse(`pods/${encodeURIComponent(pod)}/log`, { container, ...query }, logError)

  /**
   * Watches the namespace's Events from a resourceVersion, sending each change to one to `send`, once the API server
   * answers; `end` resolves with the resourceVersion to carry on from once the API server ends the watch, or with
   * undefined if it no longer keeps changes from that far back ("410 Gone"), and rejects if the watch is cut off or
   * fails otherwise.
   */
  const watchEvents = async (from: string | undefined, send: (event: CoreV1Event) => void) => {
    const expired = new CoreError('UNKNOWN', 'The watch on Events can no longer carry on')
    const failed = (error: unknown) => (error instanceof ApiException && error.code === 410 ? expired : asCoreError(error))
    let opened: Awaited<ReturnType<typeof streamResponse>>
    try {
      opened = await streamResponse('events', { watch: true, allowWatchBookmarks: true, resourceVersion: from }, failed)
    } catch (error) {
      if (error === expired) return { end: Promise.resolve(undefined), stop: () => undefined }
      throw error
    }
    const { response, stop } = opened
    response.setEncoding('utf8')
    let last = from
    const end = new Promise<string | undefined>((done, fail) => {
      let partial = ''
      /** Takes in one line of the watch: false, having stopped it, once the watch fails. */
      const take = (piece: string) => {
        let watched: WatchEvent
        try {
          watched = JSON.parse(piece) as WatchEvent
        } catch {
          return fail(new CoreError('UNKNOWN', `The watch on Events sent what isn’t JSON: ${piece.slice(0, 200)}`))
        }
        const { type, object } = watched
        if (type === 'ERROR') {
          if ('code' in object && object.code === 410) return done(undefined)
          return fail(new CoreError('UNKNOWN', `The watch on Events failed: ${'message' in object ? object.message : ''}`))
        }
        if ('metadata' in object && object.metadata?.resourceVersion) last = object.metadata.resourceVersion
        if (type === 'ADDED' || type === 'MODIFIED') send(object as CoreV1Event)
        return true
      }
      response.on('data', (chunk: string) => {
        const pieces = (partial + chunk).split('\n')
        partial = pieces.pop()!
        for (const piece of pieces.filter((p) => p.trim())) {
          if (take(piece) !== true) return stop()
        }
      })
      response.on('end', () => done(last))
      response.on('error', (error) => fail(asCoreError(error)))
      // Closed before its end: the connection dropped, or the watch was stopped.
      response.on('close', () => fail(new CoreError('UNREACHABLE', 'The watch on Events was cut off')))
    })
    end.catch(() => undefined)
    return { end, stop }
  }

  /**
   * Follows the namespace's Events: those last seen since `sinceTime` as listed now, then each change to one as a line
   * of its own as a watch from that list sends it (a change leaving its count and last-seen time as they were shows
   * nothing), every line starting with when its Event was last seen. A watch the API server ends is watched again,
   * a second later, from the last change it sent, quietly; one it can't carry on ("410 Gone") starts over, telling
   * `onStartedOver`, from listing the Events last seen since the last line sent.
   */
  const followEvents = async ({ sinceTime, onStartedOver }: LogFollowOptions, onText: (text: string) => void): Promise<LogConnection> => {
    // The last line sent's time: starting over goes on from it.
    let since = sinceTime === undefined ? -Infinity : Date.parse(sinceTime)
    // What each Event's line last said, by the Event's name: one changed in no way shown isn't sent again.
    const shown = new Map<string, string>()
    const send = (events: CoreV1Event[]) => {
      // One with no time at all only when there's no time to go on from yet, as the snapshot shows it.
      const sent = eventLines(events).filter(({ at, line, name }) => (Number.isNaN(at) ? since === -Infinity : at >= since) && shown.get(name) !== `${at} ${line}`)
      for (const { at, line, name } of sent) {
        if (!Number.isNaN(at)) since = Math.max(since, at)
        shown.set(name, `${at} ${line}`)
      }
      if (sent.length) onText(sent.map(stampedLine).join(''))
    }
    const list = () => call(() => core.listNamespacedEvent({ namespace }))
    let stopped = false
    let wake: (() => void) | undefined
    const listed = await list()
    send(listed.items)
    let watch = await watchEvents(listed.metadata?.resourceVersion, (event) => send([event]))
    const ended = (async () => {
      for (;;) {
        let from = await watch.end
        if (stopped) return
        if (from === undefined) {
          onStartedOver?.()
          const relisted = await list()
          if (stopped) return
          send(relisted.items)
          from = relisted.metadata?.resourceVersion
        } else {
          // Not straight away, in case the API server, or a proxy on the way, keeps ending watches as soon as they start.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000)
            wake = () => (clearTimeout(timer), resolve())
          })
          if (stopped) return
        }
        watch = await watchEvents(from, (event) => send([event]))
        if (stopped) return watch.stop()
      }
    })()
    ended.catch(() => undefined)
    return {
      ended,
      stop() {
        stopped = true
        watch.stop()
        wake?.()
      }
    }
  }

  /** Opens a connection following a container's log; resolves once the API server answers with the log. */
  const openLogConnection = async (pod: string, container: string, { sinceTime }: LogFollowOptions, onText: (text: string) => void) => {
    const { response, stop } = await logResponse(pod, container, { follow: true, timestamps: true, sinceTime })
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
    return { ended, stop } satisfies LogConnection
  }

  return {
    capabilities: { previousLog: true, restarts: true, status: true, since: true },
    listChildren,
    logStreamAt,

    async readLog(path, { tailLines, limitBytes, timestamps, previous = false, sinceTime }: LogReadOptions = {}) {
      if (path === kubernetesEventsPath) return eventsLog(await listEvents(), { tailLines, limitBytes, timestamps, sinceTime })
      const { pod, container } = (await containerAt(path)).kubernetes
      // The kubelet takes the last lines, then those of them since the time: the last lines of those since it, either way.
      const { response } = await logResponse(pod, container, { tailLines, limitBytes, timestamps, previous, sinceTime })
      let text: string
      try {
        text = await bodyOf(response)
      } catch (error) {
        throw asCoreError(error)
      }
      // A current log that reads so is what the container itself logged.
      if (previous && removedRunPattern.test(text)) throw previousLogGone(path)
      return text
    },

    async followLog(path, options, onText) {
      if (path === kubernetesEventsPath) return followEvents(options, onText)
      const { pod, container } = (await containerAt(path)).kubernetes
      return openLogConnection(pod, container, options, onText)
    },

    /** Reads just the pod, trusting the path, as it's looked at every few seconds while a container restarts. */
    async currentRun(path) {
      const [pod, container] = path.split('/').slice(-2)
      const found = await call(() => core.readNamespacedPod({ name: pod!, namespace }))
      const run = currentRunOf(found, container!)
      if (!run) throw notFound(path)
      return run
    },

    checkNamespace: () => checkNamespace(core, namespace)
  }
}
