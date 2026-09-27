import type { LogNode, SourcePath } from '@shared/core-api'

/** How much of a log to read. */
export interface LogReadOptions {
  /** Only this many of the last lines; all of them when left out. */
  tailLines?: number
  /** Stops after about this many bytes from the start (the backend may overshoot a little); no limit when left out. */
  limitBytes?: number
  /** Starts each line with when it was logged: an RFC 3339 timestamp in UTC, then a space. */
  timestamps?: boolean
}

/** Where following a log starts: from the start of the container's current run unless told. Lines always come with their timestamps, as with `timestamps` when reading. */
export interface LogFollowOptions {
  /** Only lines logged since this RFC 3339 time; the backend may go back to the start of its second. */
  sinceTime?: string
}

/** The connection a log is followed over. */
export interface LogConnection {
  /** Resolves when the backend stops sending (say, the container ended); rejects with a CoreError if the stream fails. */
  ended: Promise<void>
  /** Hangs up; `ended` settles either way, and nothing more arrives. */
  stop(): void
}

/** The current run of a container. */
export interface ContainerInstance {
  /** How many times the container has restarted; each new run counts one more. */
  restarts: number
  state: 'waiting' | 'running' | 'terminated'
  /** Terminated, and never going to run again: its pod completed, failed or is going away, or it isn't restarted. */
  finished: boolean
}

/** What a log's path points at. */
export interface LogStreamInfo {
  pod: string
  container: string
  /** Whether it's the container's Previous Log, rather than its current one. */
  previous: boolean
}

/**
 * The contract every Log Source Type implements, checked by the shared suite in log-source-contract.ts.
 * Paths are Source-relative ('/'-separated, '' for the root); implementations throw CoreError on failure.
 * A log's path is a container's, or a Previous Log's.
 */
export interface LogSource {
  /**
   * The nodes under a node: groups under the root, then down through Workloads and pods to containers
   * and Previous Logs, which have none. A pod lists its containers in its own order, each restarted one
   * followed by its Previous Log; everything else comes in no particular order.
   * Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_FOLDER for a log's.
   */
  listChildren(path: SourcePath): Promise<LogNode[]>
  /** What a log's path points at. Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_LOG_STREAM for one that isn't a log's. */
  logStreamAt(path: SourcePath): Promise<LogStreamInfo>
  /** A log as text, lines ending in '\n'. Fails like logStreamAt, or with LOG_UNAVAILABLE when there's no log to give yet. */
  readLog(path: SourcePath, options?: LogReadOptions): Promise<string>
  /**
   * Starts following a container's current log, resolving once the backend is sending; `onText` gets
   * what arrives, in pieces that needn't end at a line break. Fails like readLog, and with NOT_FOLLOWABLE for a Previous Log.
   */
  followLog(path: SourcePath, options: LogFollowOptions, onText: (text: string) => void): Promise<LogConnection>
  /**
   * A container's current run, looked at often while a Follow waits for a restart, so it may trust the
   * path to be a container's. Fails with NOT_FOUND once the container or its pod is gone.
   */
  containerInstance(path: SourcePath): Promise<ContainerInstance>
}
