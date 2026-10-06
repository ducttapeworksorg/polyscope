import type { LogNode, SourcePath } from '@shared/core-api'

/** How much of a log to read. */
export interface LogReadOptions {
  /** Only this many of the last lines; all of them when left out. */
  tailLines?: number
  /** Stops after about this many bytes from the start (the backend may overshoot a little); no limit when left out. */
  limitBytes?: number
  /** Starts each line with when it was logged: an RFC 3339 timestamp in UTC, then a space. */
  timestamps?: boolean
  /** Reads the container's Previous Log, the log of its run before the current one, rather than its current one. */
  previous?: boolean
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
  /** How many times the container has restarted; once it has, it has a Previous Log. */
  restarts: number
}

/**
 * The contract every Log Source Type implements, checked by the shared suite in log-source-contract.ts.
 * Paths are Source-relative ('/'-separated, '' for the root); implementations throw CoreError on failure.
 * A log's path is a container's; its Previous Log is read through the same path.
 */
export interface LogSource {
  /**
   * The nodes under a node: groups under the root, then down through Workloads and pods to containers,
   * which have none. A pod lists its containers in its own order; everything else comes in no particular order.
   * Previous Logs aren't listed: they're read through their containers' paths.
   * Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_FOLDER for a log's.
   */
  listChildren(path: SourcePath): Promise<LogNode[]>
  /** What a log's path points at. Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_LOG_STREAM for one that isn't a log's. */
  logStreamAt(path: SourcePath): Promise<LogStreamInfo>
  /**
   * A container's log as text, lines ending in '\n'. Fails like logStreamAt, with LOG_UNAVAILABLE when there's no log to
   * give yet (for a Previous Log, no run before the current one), or with PREVIOUS_LOG_GONE for a Previous Log whose
   * run is no longer kept.
   */
  readLog(path: SourcePath, options?: LogReadOptions): Promise<string>
  /**
   * Starts following a container's current log, resolving once the backend is sending; `onText` gets
   * what arrives, in pieces that needn't end at a line break. Fails like readLog.
   */
  followLog(path: SourcePath, options: LogFollowOptions, onText: (text: string) => void): Promise<LogConnection>
  /**
   * A container's current run, looked at often while a Follow waits for a restart, so it may trust the
   * path to be a container's. Fails with NOT_FOUND once the container or its pod is gone.
   */
  containerInstance(path: SourcePath): Promise<ContainerInstance>
}
