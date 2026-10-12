import type { DockerLogStream, NodeHealth, NodeStatus } from '@shared/core-api'
import type { LogStreamRun } from './log-source'

/** The parts of the engine's container inspect Polyscope reads. */
export interface ContainerInspect {
  Config?: { Tty?: boolean; Image?: string }
  State?: {
    /** created, running, paused, restarting, removing, exited or dead. */
    Status?: string
    Running?: boolean
    ExitCode?: number
    OOMKilled?: boolean
    /** When its current run started, or its last one if it isn't running; the zero time, `0001-…`, if it never has. */
    StartedAt?: string
    /** When its last run ended; the zero time if none has. */
    FinishedAt?: string
    /** Set only for a container with a healthcheck. */
    Health?: { Status?: 'starting' | 'healthy' | 'unhealthy' | 'none' }
  }
  /** How many times the engine has restarted it, by its restart policy. */
  RestartCount?: number
  HostConfig?: { LogConfig?: { Type?: string } }
}

/** An engine time as milliseconds since the epoch; undefined for the zero time, which stands for never. */
export const engineMillis = (time: string | undefined) => (!time || time.startsWith('0001-') ? undefined : Date.parse(time))

/** Exit codes from `docker stop`: SIGTERM's, or SIGKILL's once it gave up waiting; and Ctrl+C's SIGINT. */
const stopped = new Set([0, 130, 137, 143])

/** What a container is doing, or what's wrong with it, and how that looks. */
function reasonOf({ State: state = {} }: ContainerInspect): { reason: string; health: NodeHealth } {
  switch (state.Status) {
    case 'running':
      if (state.Health?.Status === 'unhealthy') return { reason: 'Unhealthy', health: 'failing' }
      if (state.Health?.Status === 'starting') return { reason: 'Starting', health: 'pending' }
      return { reason: 'Running', health: 'healthy' }
    case 'exited': {
      if (state.OOMKilled) return { reason: 'OOMKilled', health: 'failing' }
      const exitCode = state.ExitCode ?? 0
      return { reason: `Exited (${exitCode})`, health: stopped.has(exitCode) ? 'inactive' : 'failing' }
    }
    case 'restarting':
      return { reason: 'Restarting', health: 'failing' }
    case 'paused':
      return { reason: 'Paused', health: 'inactive' }
    case 'dead':
      return { reason: 'Dead', health: 'failing' }
    case 'created':
      return { reason: 'Created', health: 'pending' }
    case 'removing':
      return { reason: 'Removing', health: 'inactive' }
    default:
      return { reason: state.Status ?? 'Unknown', health: 'inactive' }
  }
}

/** A container's Container Status: its state, or its health when a healthcheck fails, with its restarts. */
export function containerStatusOf(container: ContainerInspect): NodeStatus {
  const restarts = container.RestartCount ?? 0
  const status: NodeStatus = { ...reasonOf(container), restarts }
  // Running again (or about to be) after a restart, its last run ended when it went down.
  const lastRestart = ['running', 'restarting', 'paused'].includes(container.State?.Status ?? '') ? engineMillis(container.State?.FinishedAt) : undefined
  if (restarts > 0 && lastRestart !== undefined) status.lastRestart = lastRestart
  return status
}

/** Whether a container has run for good, unless someone starts it again. */
const hasEnded = (container: ContainerInspect) => ['exited', 'dead'].includes(container.State?.Status ?? '')

/** What a container is, as its Log Stream tells: its image, and when it started, and exited if it has. */
export function containerDetailsOf(container: ContainerInspect): DockerLogStream {
  const image = container.Config?.Image
  const startedAt = engineMillis(container.State?.StartedAt)
  const finishedAt = hasEnded(container) ? engineMillis(container.State?.FinishedAt) : undefined
  return { kind: 'container', ...(image && { image }), ...(startedAt !== undefined && { startedAt }), ...(finishedAt !== undefined && { finishedAt }) }
}

/**
 * A container's current run, as a Follow needs it. The engine goes straight from running to restarting when its restart
 * policy says to, so one that has exited won't run again unless someone starts it.
 */
export function containerRunOf(container: ContainerInspect): LogStreamRun {
  const status = container.State?.Status
  const state =
    status === 'running' || status === 'paused' ? 'running'
    : hasEnded(container) ? 'terminated'
    : 'waiting'
  return { restarts: container.RestartCount ?? 0, state, finished: state === 'terminated' }
}
