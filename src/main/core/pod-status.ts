import type {
  V1Container,
  V1ContainerStateTerminated,
  V1ContainerStatus,
  V1CronJob,
  V1DaemonSet,
  V1Deployment,
  V1Job,
  V1Pod,
  V1StatefulSet
} from '@kubernetes/client-node'
import type { PodHealth, PodStatus, ReadyCount, WorkloadKind } from '@shared/core-api'

/** Why a container ended, as kubectl puts it: its reason, or else the signal or exit code it ended with. */
const endReason = ({ reason, signal, exitCode }: V1ContainerStateTerminated) =>
  reason || (signal ? `Signal:${signal}` : `ExitCode:${exitCode}`)

/** An init container that keeps running alongside the others: a sidecar. */
export const isSidecar = (container: V1Container) => container.restartPolicy === 'Always'

/** The statuses of all a pod's containers, init containers first. */
const statusesOf = (pod: V1Pod) => [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]

/** Reasons a pod is on its way up rather than in trouble. */
const starting = new Set(['Pending', 'ContainerCreating', 'PodInitializing'])
const healthy = new Set(['Running', 'Succeeded', 'Completed'])
const inactive = new Set(['Terminating', 'Unknown'])

const healthOf = (reason: string): PodHealth =>
  inactive.has(reason) ? 'inactive'
  : healthy.has(reason) ? 'healthy'
  : starting.has(reason) || /^Init:\d+\/\d+$/.test(reason) ? 'pending'
  : 'failing'

/** What an unfinished init container holds the pod up with, e.g. Init:CrashLoopBackOff or Init:1/2; undefined once they're all done. */
function initReason(pod: V1Pod): string | undefined {
  const statuses = pod.status?.initContainerStatuses ?? []
  const sidecars = new Set((pod.spec?.initContainers ?? []).filter(isSidecar).map((c) => c.name))
  const total = pod.spec?.initContainers?.length ?? statuses.length
  for (const [i, { name, state, started }] of statuses.entries()) {
    if (state?.terminated?.exitCode === 0) continue
    // A sidecar has done its part once it has started: it keeps running alongside the others.
    if (sidecars.has(name) && (started || state?.running)) continue
    if (state?.terminated) return `Init:${endReason(state.terminated)}`
    const waiting = state?.waiting?.reason
    if (waiting && waiting !== 'PodInitializing') return `Init:${waiting}`
    return `Init:${i}/${total}`
  }
  return undefined
}

/** What a container that isn't running says about it: why it's waiting, or why it ended. */
const containerReason = ({ state }: V1ContainerStatus) =>
  state?.waiting?.reason || (state?.terminated ? endReason(state.terminated) : undefined)

/** When a container's run ended, in milliseconds since the epoch; 0 if unknown. */
const endedAt = (ended: V1ContainerStateTerminated) => (ended.finishedAt ? new Date(ended.finishedAt).getTime() : 0)

/** A pod's Pod Status: its phase, or what's wrong with it the way kubectl would say, with its restarts. */
export function podStatusOf(pod: V1Pod): PodStatus {
  const containers = pod.status?.containerStatuses ?? []
  const all = statusesOf(pod)
  const phase = pod.status?.reason || pod.status?.phase || 'Unknown'
  const ended = containers.map(containerReason).filter((r): r is string => Boolean(r))
  // A container that completed while others run leaves the pod Running.
  const reason = pod.metadata?.deletionTimestamp
    ? 'Terminating'
    : (initReason(pod) ?? ended.find((r) => r !== 'Completed') ?? (ended.length && phase !== 'Running' ? 'Completed' : phase))
  const status: PodStatus = { reason, health: healthOf(reason), restarts: all.reduce((sum, c) => sum + c.restartCount, 0) }

  const last = all
    .filter((c) => c.restartCount > 0 && c.lastState?.terminated)
    .map((c) => c.lastState!.terminated!)
    .reduce<V1ContainerStateTerminated | undefined>((a, b) => (!a || endedAt(b) > endedAt(a) ? b : a), undefined)
  if (last?.finishedAt) status.lastRestart = endedAt(last)
  if (last) status.lastTerminationReason = endReason(last)
  return status
}

/** How many times a container of the pod has restarted; undefined until it has. */
export function restartsOf(pod: V1Pod, container: string): number | undefined {
  const restarts = statusesOf(pod).find((c) => c.name === container)?.restartCount
  return restarts ? restarts : undefined
}

type Workload = V1Deployment | V1StatefulSet | V1DaemonSet | V1Job | V1CronJob

/** A Workload's Ready Count; undefined for Jobs and CronJobs, which run to completion rather than stay ready. */
export function readyCountOf(kind: Exclude<WorkloadKind, 'Pod'>, workload: Workload): ReadyCount | undefined {
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet': {
      const { spec, status } = workload as V1Deployment | V1StatefulSet
      return { ready: status?.readyReplicas ?? 0, desired: spec?.replicas ?? 1 }
    }
    case 'DaemonSet': {
      const { status } = workload as V1DaemonSet
      return { ready: status?.numberReady ?? 0, desired: status?.desiredNumberScheduled ?? 0 }
    }
    default:
      return undefined
  }
}
