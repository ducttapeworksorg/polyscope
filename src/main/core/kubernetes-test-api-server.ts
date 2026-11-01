// Test support: a stand-in for a Kubernetes API server, just enough of one to connect a Kubernetes Logs Source to
// and read and follow its logs, over TLS with a certificate from the private test CA. Its namespace `shop` holds
// an ownerless pod `counter`; `lines` holds one too, which logs as the Log Source contract's counter does; in
// `locked`, which holds a Deployment `web` and a CronJob `nightly`, listing pods is denied the way RBAC denies it;
// `crashing` holds a pod `crasher` whose restarted containers' previous runs Kubernetes has removed; `files` holds
// the Deployments of `filesDeployments`, for a Kubernetes Files Source's tree (it can't exec into their pods); `batch`
// holds the CronJobs and Jobs of `batchJobs`, and the Events of `batchEvents`; `events` holds the Deployments `api`, with
// a pod, and `worker`, with none, and the Events of `namespaceEvents`, and `noevents` nothing but a pod `counter`,
// listing its Events denied the way RBAC denies it. Events in `events` can be watched, the test changing them, closing
// the watch or answering it "410 Gone", or adding pods to `api`, through the stand-in's `events`.
// Given a token, it turns away requests that don't bear it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startTlsFront } from './test-network'

/** What `counter` logs, with when, a second apart: `line 1` to `line 3`, then `line 4` while it's followed. */
const logged = [1, 2, 3, 4].map((i) => ({ time: `2026-09-27T10:00:0${i}.000000000Z`, text: `line ${i}` }))

/** What `counter` in `lines` logs, a second apart: `line 1` to `line 100`. */
const linesLogged = Array.from({ length: 100 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 8, 27, 10, 0, i + 1)).toISOString().replace('Z', '000000Z'),
  text: `line ${i + 1}`
}))

const counter = {
  metadata: { name: 'counter', uid: 'counter' },
  spec: { containers: [{ name: 'counter' }] },
  status: {
    phase: 'Running',
    containerStatuses: [{ name: 'counter', image: 'busybox', imageID: '', ready: true, restartCount: 0, state: { running: {} } }]
  }
}

/** The container runtimes `crasher`'s containers are named after, each with its own container id scheme. */
const runtimes = ['containerd', 'cri-o', 'docker']

/** What the kubelet answers for the log of a container's run it no longer keeps. */
const removedRunMessage = (runtime: string) => `unable to retrieve container logs for ${runtime}://0123456789abcdef`

/** Crash-looping, waiting to run again: its last run is the current one, and the run before that is gone. */
const crasher = {
  metadata: { name: 'crasher', uid: 'crasher' },
  spec: { containers: runtimes.map((name) => ({ name })) },
  status: {
    phase: 'Running',
    containerStatuses: runtimes.map((name) => ({
      name,
      image: 'busybox',
      imageID: '',
      ready: false,
      restartCount: 3,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { exitCode: 1, reason: 'Error' } }
    }))
  }
}

/** A pod of a ReplicaSet in `files`, its containers named, all running or (`crashing`) all crash-looping. */
const filesPod = (name: string, replicaSet: string, containers: string[], { crashing = false, sidecar = '' } = {}) => ({
  metadata: { name, uid: name, ownerReferences: [{ kind: 'ReplicaSet', name: replicaSet, uid: replicaSet, controller: true }] },
  spec: {
    containers: containers.map((container) => ({ name: container })),
    ...(sidecar && { initContainers: [{ name: sidecar, restartPolicy: 'Always' }] })
  },
  status: {
    phase: 'Running',
    ...(sidecar && { initContainerStatuses: [{ name: sidecar, image: 'busybox', imageID: '', ready: true, restartCount: 0, state: { running: {} } }] }),
    containerStatuses: containers.map((container) => ({
      name: container,
      image: 'busybox',
      imageID: '',
      ready: !crashing,
      restartCount: crashing ? 2 : 0,
      state: crashing ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} },
      ...(crashing && { lastState: { terminated: { exitCode: 1, reason: 'Error' } } })
    }))
  }
})

/**
 * The Deployments in `files`, each with one ReplicaSet unless it has no pods, and their pods: `solo` has one pod of one
 * container, crash-looping; `pair` one pod with a main container and a sidecar; `duo` two pods; `idle` none.
 */
export const filesDeployments = {
  solo: [filesPod('solo-7d9f-abcde', 'solo-7d9f', ['app'], { crashing: true })],
  pair: [filesPod('pair-5c4b-fghij', 'pair-5c4b', ['app'], { sidecar: 'proxy' })],
  duo: [filesPod('duo-6a2e-klmno', 'duo-6a2e', ['app']), filesPod('duo-6a2e-pqrst', 'duo-6a2e', ['app'])],
  idle: []
}

const filesPods = Object.values(filesDeployments).flat()

const filesReplicaSets = Object.entries(filesDeployments).flatMap(([deployment, [pod]]) => {
  const name = pod?.metadata.ownerReferences[0]!.name
  return name ? [{ metadata: { name, uid: name, ownerReferences: [{ kind: 'Deployment', name: deployment, uid: deployment, controller: true }] } }] : []
})

/** A completed pod of a Job, with one container, which logged `done`. */
const jobPod = (name: string, job: string, container: string) => ({
  metadata: { name, uid: name, ownerReferences: [{ kind: 'Job', name: job, uid: job, controller: true }] },
  spec: { restartPolicy: 'Never', containers: [{ name: container }] },
  status: {
    phase: 'Succeeded',
    containerStatuses: [
      { name: container, image: 'busybox', imageID: '', ready: false, restartCount: 0, state: { terminated: { exitCode: 0, reason: 'Completed' } } }
    ]
  }
})

/**
 * The Jobs in `batch`, by the CronJob that owns them ('' for none), and their pods: `nightly` has run once, `hourly` twice,
 * `weekly` not yet; `migrate` has one pod, `retried` two.
 */
export const batchJobs = {
  nightly: { 'nightly-1': [jobPod('nightly-1-abcde', 'nightly-1', 'report')] },
  weekly: {},
  hourly: { 'hourly-1': [jobPod('hourly-1-fghij', 'hourly-1', 'sync')], 'hourly-2': [jobPod('hourly-2-klmno', 'hourly-2', 'sync')] },
  '': { migrate: [jobPod('migrate-pqrst', 'migrate', 'migrate')], retried: [jobPod('retried-uvwxy', 'retried', 'retry'), jobPod('retried-zabcd', 'retried', 'retry')] }
}

const batchCronJobs = Object.keys(batchJobs)
  .filter(Boolean)
  .map((name) => ({ metadata: { name, uid: name } }))

const batchJobList = Object.entries(batchJobs).flatMap(([cronJob, jobs]) =>
  Object.keys(jobs).map((name) => ({
    metadata: { name, uid: name, ...(cronJob && { ownerReferences: [{ kind: 'CronJob', name: cronJob, uid: cronJob, controller: true }] }) }
  }))
)

const batchPods = Object.values(batchJobs).flatMap((jobs) => Object.values(jobs).flat())

/** A pod in `events`, of a ReplicaSet of `api` unless said, running one container `app`. */
const eventsPod = (name: string, replicaSet = 'api-7d9f') => ({
  metadata: { name, uid: name, ownerReferences: [{ kind: 'ReplicaSet', name: replicaSet, uid: replicaSet, controller: true }] },
  spec: { containers: [{ name: 'app' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'app', image: 'busybox', imageID: '', ready: true, restartCount: 0, state: { running: {} } }] }
})

/** The Deployments in `events`, by name: `api`'s ReplicaSet has a pod, `worker`'s can't create one. */
const eventsDeployments = [{ metadata: { name: 'api', uid: 'api' } }, { metadata: { name: 'worker', uid: 'worker' } }]

const eventsReplicaSets = [
  ['api-7d9f', 'api'],
  ['worker-5c4b', 'worker']
].map(([name, deployment]) => ({
  metadata: { name, uid: name, ownerReferences: [{ kind: 'Deployment', name: deployment, uid: deployment, controller: true }] }
}))

/** An Event about an object, of a type, with what it says and when, as the API server gives it. */
const event = (type: string, reason: string, kind: string, name: string, message: string, times: Record<string, unknown>) => ({
  metadata: { name: `${name}.${reason.toLowerCase()}`, namespace: 'events', ...('creationTimestamp' in times && { creationTimestamp: times['creationTimestamp'] }) },
  type,
  reason,
  message,
  involvedObject: { kind, name, namespace: 'events' },
  ...Object.fromEntries(Object.entries(times).filter(([key]) => key !== 'creationTimestamp'))
})

/**
 * The Events in `events`, listed out of order: a pod scheduled, then pulled (only the time it was created), a Deployment
 * scaled twice (said as a series, events.k8s.io style), its ReplicaSet failing to create a pod (first seen only), and
 * the pod's container backing off 14 times, first seen at the start and last seen at 10:30.
 */
export const namespaceEvents = [
  event('Warning', 'FailedCreate', 'ReplicaSet', 'worker-5c4b', 'Error creating: pods "worker-5c4b-z" is forbidden: exceeded quota', {
    count: 3,
    firstTimestamp: '2026-10-29T09:40:00Z',
    lastTimestamp: '2026-10-29T09:50:00Z'
  }),
  event('Warning', 'BackOff', 'Pod', 'api-7d9f-x2k', 'Back-off restarting failed container', {
    count: 14,
    firstTimestamp: '2026-10-29T10:00:00Z',
    lastTimestamp: '2026-10-29T10:30:00Z'
  }),
  event('Normal', 'Pulled', 'Pod', 'api-7d9f-x2k', 'Container image "busybox" already present on machine\n', { creationTimestamp: '2026-10-29T10:05:00Z' }),
  event('Warning', 'FailedCreate', 'ReplicaSet', 'api-7d9f', 'Error creating: pods "api-7d9f-y" is forbidden: exceeded quota', {
    firstTimestamp: '2026-10-29T10:20:00Z'
  }),
  event('Normal', 'ScalingReplicaSet', 'Deployment', 'api', 'Scaled up replica set api-7d9f to 1', {
    eventTime: '2026-10-29T09:59:00.000000Z',
    series: { count: 2, lastObservedTime: '2026-10-29T10:10:00.000000Z' }
  }),
  event('Normal', 'Scheduled', 'Pod', 'api-7d9f-x2k', 'Successfully assigned events/api-7d9f-x2k to node-1', {
    count: 1,
    firstTimestamp: '2026-10-29T10:00:00Z',
    lastTimestamp: '2026-10-29T10:00:00Z'
  })
]

/** An Event in `batch`, Normal unless said, last seen at a time on 29 October. */
const batchEvent = (reason: string, kind: string, name: string, message: string, time: string, type = 'Normal') =>
  event(type, reason, kind, name, message, { count: 1, firstTimestamp: `2026-10-29T${time}Z`, lastTimestamp: `2026-10-29T${time}Z` })

/**
 * The Events in `batch`: `hourly`'s two runs, the first completed and the second failing, with their Jobs' and pods',
 * and those of a run before them since deleted, Job and pod; `nightly`'s one run; and those of `migrate` and of
 * `hourly-report`, since deleted, Jobs of no CronJob.
 */
export const batchEvents = [
  batchEvent('SuccessfulCreate', 'CronJob', 'nightly', 'Created job nightly-1', '02:00:00'),
  batchEvent('Scheduled', 'Pod', 'nightly-1-abcde', 'Successfully assigned batch/nightly-1-abcde to node-1', '02:00:01'),
  batchEvent('Completed', 'Job', 'migrate', 'Job completed', '09:00:00'),
  batchEvent('Completed', 'Job', 'hourly-0', 'Job completed', '09:01:00'),
  batchEvent('Pulled', 'Pod', 'hourly-0-vwxyz', 'Container image "busybox" already present on machine', '09:00:30'),
  batchEvent('Completed', 'Job', 'hourly-report', 'Job completed', '09:02:00'),
  batchEvent('Pulled', 'Pod', 'hourly-1-fghij', 'Container image "busybox" already present on machine', '10:00:00'),
  batchEvent('Completed', 'Job', 'hourly-1', 'Job completed', '10:01:00'),
  batchEvent('SawCompletedJob', 'CronJob', 'hourly', 'Saw completed job: hourly-1, condition: Complete', '10:01:01'),
  batchEvent('BackOff', 'Pod', 'hourly-2-klmno', 'Back-off restarting failed container', '11:01:00', 'Warning'),
  batchEvent('BackoffLimitExceeded', 'Job', 'hourly-2', 'Job has reached the specified backoff limit', '11:02:00', 'Warning')
]

/** An Event, with whichever of its counts and times it carries. */
type Event = Omit<ReturnType<typeof event>, 'metadata'> & { metadata: ReturnType<typeof event>['metadata'] & Record<string, unknown> } & Record<string, unknown>

/** An Event in `events` as the test gives it: of a pod, Warning unless said, with how many times and when it was last seen. */
export const podEvent = (reason: string, pod: string, message: string, lastTimestamp: string, { count = 1, type = 'Warning' } = {}) =>
  event(type, reason, 'Pod', pod, message, { count, firstTimestamp: lastTimestamp, lastTimestamp })

/**
 * The Events in `events`, as listed and watched: each change gives them a new resourceVersion, and a watch from one
 * first sends the changes since it. A watch from one older than the last `expire` answers "410 Gone", as the API
 * server does once it no longer keeps changes that far back.
 */
function eventsStore() {
  let version = 1
  let expiredBelow = 0
  const items = new Map<string, Event>(namespaceEvents.map((e) => [e.metadata.name, e]))
  const pods = [eventsPod('api-7d9f-x2k')]
  /** Every change, as a watch sends it, with its resourceVersion. */
  const changes: { version: number; line: string }[] = []
  const watches = new Set<ServerResponse>()
  const waiters = new Set<() => void>()
  const watched: number[] = []
  const record = (e: Event) => {
    const type = items.has(e.metadata.name) ? 'MODIFIED' : 'ADDED'
    version++
    const object = { ...e, metadata: { ...e.metadata, resourceVersion: String(version) } }
    items.set(e.metadata.name, object)
    const line = `${JSON.stringify({ type, object })}\n`
    changes.push({ version, line })
    return line
  }
  const gone = (response: ServerResponse) => {
    const status = { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Expired', code: 410, message: 'too old resource version' }
    response.end(`${JSON.stringify({ type: 'ERROR', object: status })}\n`)
  }
  return {
    list: () => ({ kind: 'EventList', apiVersion: 'v1', metadata: { resourceVersion: String(version) }, items: [...items.values()] }),
    watch(url: URL, response: ServerResponse) {
      const from = Number(url.searchParams.get('resourceVersion') ?? version)
      watched.push(from)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
      for (const waiter of waiters) waiter()
      if (from < expiredBelow) return gone(response)
      for (const change of changes.filter((c) => c.version > from)) response.write(change.line)
      watches.add(response)
      response.on('close', () => watches.delete(response))
    },
    /** Every watch asked for so far, by the resourceVersion each starts from. */
    watched,
    /** How many watches are open. */
    open: () => watches.size,
    /** Resolves once `count` watches in all have been asked for. */
    async watchedTimes(count: number) {
      while (watched.length < count) {
        await new Promise<void>((resolve) => {
          const waiter = () => (waiters.delete(waiter), resolve())
          waiters.add(waiter)
        })
      }
    },
    /** Changes an Event, or adds it, without telling the watches open: one they miss. */
    record: (e: Event) => void record(e),
    /** Changes an Event, or adds it, telling every watch open; a watch opened later from before it sends it first. */
    send(e: Event) {
      const line = record(e)
      for (const response of watches) response.write(line)
    },
    /** The pods in `events`. */
    pods: () => pods,
    /** Adds a pod to `api`'s ReplicaSet, or another's. */
    addPod: (name: string, replicaSet?: string) => void pods.push(eventsPod(name, replicaSet)),
    /** Ends every watch, as the API server does now and then. */
    close() {
      for (const response of watches) response.end()
      watches.clear()
    },
    /** Keeps no changes up to now: every watch open, and any from before now, answers "410 Gone". */
    expire() {
      expiredBelow = version
      for (const response of watches) gone(response)
      watches.clear()
    }
  }
}

const json = (response: ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

/**
 * Answers for the log of a pod `counter`'s container, which logged `lines` and hasn't restarted, so has no Previous
 * Log, as the query asks: the last `tailLines`, then those of them since `sinceTime`, as the kubelet takes them; at
 * most `limitBytes`; with timestamps.
 */
function sendLog(lines: { time: string; text: string }[], url: URL, response: ServerResponse) {
  const param = (name: string) => url.searchParams.get(name)
  if (param('previous') === 'true') {
    const message = `previous terminated container "counter" in pod "counter" not found`
    return json(response, 400, { kind: 'Status', status: 'Failure', reason: 'BadRequest', code: 400, message })
  }
  const tail = param('tailLines') === null ? lines.length : Number(param('tailLines'))
  const since = param('sinceTime') === null ? -Infinity : Date.parse(param('sinceTime')!)
  const stamped = param('timestamps') === 'true'
  const text = lines
    .slice(Math.max(0, lines.length - tail))
    .filter(({ time }) => Date.parse(time) >= since)
    .map(({ time, text }) => `${stamped ? `${time} ` : ''}${text}\n`)
    .join('')
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.write(param('limitBytes') === null ? text : text.slice(0, Number(param('limitBytes'))))
  // Following: nothing more for as long as the connection lasts.
  return param('follow') === 'true' ? undefined : response.end()
}

function respond(request: IncomingMessage, response: ServerResponse, token: string | undefined, events: ReturnType<typeof eventsStore>) {
  if (token !== undefined && request.headers.authorization !== `Bearer ${token}`) {
    return json(response, 401, { kind: 'Status', status: 'Failure', reason: 'Unauthorized', code: 401, message: 'Unauthorized' })
  }
  const url = new URL(request.url ?? '/', 'http://api')
  const namespaced = /^\/apis?\/(?:[^/]+\/)?v1\/namespaces\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!namespaced) return json(response, 404, { kind: 'Status', code: 404, message: 'not found' })
  const [, namespace, rest = ''] = namespaced
  if (!rest) return json(response, 200, { kind: 'Namespace', apiVersion: 'v1', metadata: { name: namespace } })
  if (namespace === 'locked' && rest === '/pods') {
    const message = `pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "locked"`
    return json(response, 403, { kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403, message })
  }
  if (namespace === 'noevents' && rest === '/events') {
    const message = `events is forbidden: User "jane" cannot list resource "events" in API group "" in the namespace "noevents"`
    return json(response, 403, { kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403, message })
  }
  if (namespace === 'events' && rest === '/events') {
    return url.searchParams.get('watch') === 'true' || url.searchParams.get('watch') === '1' ? events.watch(url, response) : json(response, 200, events.list())
  }
  if (namespace === 'events') {
    const lists = { pods: events.pods(), deployments: eventsDeployments, replicasets: eventsReplicaSets }
    const [, resource, name] = /^\/(pods|deployments|replicasets)(?:\/([^/]+))?$/.exec(rest) ?? []
    if (resource && name === undefined) return json(response, 200, { kind: 'List', apiVersion: 'v1', metadata: {}, items: lists[resource as keyof typeof lists] })
    if (resource) {
      const item = lists[resource as keyof typeof lists].find((i) => i.metadata.name === name)
      return item ? json(response, 200, item) : json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound', message: 'not found' })
    }
  }
  if (namespace === 'locked' && rest === '/deployments') {
    return json(response, 200, { kind: 'DeploymentList', apiVersion: 'apps/v1', metadata: {}, items: [{ metadata: { name: 'web', uid: 'web' } }] })
  }
  if (namespace === 'locked' && rest === '/cronjobs') {
    return json(response, 200, { kind: 'CronJobList', apiVersion: 'batch/v1', metadata: {}, items: [{ metadata: { name: 'nightly', uid: 'nightly' } }] })
  }
  if (namespace === 'noevents' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [counter] })
  if (namespace === 'shop' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [counter] })
  if (namespace === 'shop' && rest === '/pods/counter') return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...counter })
  if (namespace === 'shop' && rest === '/pods/counter/log') {
    return sendLog(url.searchParams.get('follow') === 'true' ? logged : logged.slice(0, 3), url, response)
  }
  if (namespace === 'lines' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [counter] })
  if (namespace === 'lines' && rest === '/pods/counter') return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...counter })
  if (namespace === 'lines' && rest === '/pods/counter/log') return sendLog(linesLogged, url, response)
  if (namespace === 'crashing' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [crasher] })
  if (namespace === 'crashing' && rest === '/pods/crasher') return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...crasher })
  if (namespace === 'crashing' && rest === '/pods/crasher/log') {
    // The previous run: the kubelet's answer, unstamped and with no line break. The current run logged that same line itself.
    const runtime = url.searchParams.get('container') ?? ''
    const previous = url.searchParams.get('previous') === 'true'
    return response.writeHead(200, { 'content-type': 'text/plain' }).end(previous ? removedRunMessage(runtime) : `${removedRunMessage(runtime)}\n`)
  }
  if (namespace === 'files') {
    if (rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: filesPods })
    if (rest === '/replicasets') return json(response, 200, { kind: 'ReplicaSetList', apiVersion: 'apps/v1', metadata: {}, items: filesReplicaSets })
    if (rest === '/deployments') {
      const items = Object.keys(filesDeployments).map((name) => ({ metadata: { name, uid: name } }))
      return json(response, 200, { kind: 'DeploymentList', apiVersion: 'apps/v1', metadata: {}, items })
    }
    const pod = filesPods.find((p) => rest === `/pods/${p.metadata.name}`)
    if (pod) return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...pod })
    const deployment = Object.keys(filesDeployments).find((name) => rest === `/deployments/${name}`)
    if (deployment) return json(response, 200, { kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: deployment, uid: deployment } })
    if (rest.startsWith('/pods/') || rest.startsWith('/deployments/')) return json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound', message: 'not found' })
  }
  if (namespace === 'batch') {
    if (rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: batchPods })
    if (rest === '/jobs') return json(response, 200, { kind: 'JobList', apiVersion: 'batch/v1', metadata: {}, items: batchJobList })
    if (rest === '/cronjobs') return json(response, 200, { kind: 'CronJobList', apiVersion: 'batch/v1', metadata: {}, items: batchCronJobs })
    if (rest === '/events') return json(response, 200, { kind: 'EventList', apiVersion: 'v1', metadata: {}, items: batchEvents })
    if (batchPods.some((pod) => rest === `/pods/${pod.metadata.name}/log`)) {
      return response.writeHead(200, { 'content-type': 'text/plain' }).end('done\n')
    }
    const lists = { pods: batchPods, jobs: batchJobList, cronjobs: batchCronJobs }
    const [, resource, name] = /^\/(pods|jobs|cronjobs)\/([^/]+)$/.exec(rest) ?? []
    if (resource) {
      const item = lists[resource as keyof typeof lists].find((i) => i.metadata.name === name)
      return item ? json(response, 200, item) : json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound', message: 'not found' })
    }
  }
  return json(response, 200, { kind: 'List', apiVersion: 'v1', metadata: {}, items: [] })
}

/** A kubeconfig whose context `fake` points at the stand-in API server at `server`, trusting `caPath` and through `proxyUrl` if given. */
export const standInCluster = (server: string, caPath: string | undefined, proxyUrl?: string) =>
  [
    'apiVersion: v1',
    'kind: Config',
    'current-context: fake',
    'clusters:',
    '- name: fake',
    '  cluster:',
    `    server: ${server}`,
    ...(caPath ? [`    certificate-authority: ${JSON.stringify(caPath)}`] : []),
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

/**
 * Starts the stand-in; `url` is its https address on 127.0.0.1, `caPath` a PEM file of the root CA that trusts it, and
 * `issuingCaPath` of the issuing CA between them.
 * With a `token`, only requests bearing it are answered. `events` changes the Events in `events` and their watches.
 */
export async function startTestApiServer({ token }: { token?: string } = {}) {
  const events = eventsStore()
  const server = createServer((request, response) => respond(request, response, token, events))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const front = await startTlsFront(`http://127.0.0.1:${port}`)
  return {
    url: front.url,
    caPath: front.caPath,
    issuingCaPath: front.issuingCaPath,
    events,
    close: async () => {
      await front.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
