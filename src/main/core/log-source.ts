import type { LogCapabilities, LogNode, SourcePath } from '@shared/core-api'

/** How much of a log to read. */
export interface LogReadOptions {
  /** Only this many of the last lines; all of them when left out. */
  tailLines?: number
  /** Stops after about this many bytes from the start (the backend may overshoot a little); no limit when left out. */
  limitBytes?: number
  /** Starts each line with when it was logged: an RFC 3339 timestamp in UTC, then a space. */
  timestamps?: boolean
  /** Reads the Log Stream's Previous Log, the log of its run before the current one, rather than its current one. */
  previous?: boolean
}

/** Where following a log starts: from the start of the Log Stream's current run unless told. Lines always come with their timestamps, as with `timestamps` when reading. */
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

/** The current run of what logs to a Log Stream: a container, say. */
export interface LogStreamRun {
  /** How many times it has restarted; each new run counts one more. */
  restarts: number
  state: 'waiting' | 'running' | 'terminated'
  /** Terminated, and never going to run again: say a container whose pod completed, failed or is going away, or that isn't restarted. */
  finished: boolean
}

/** What a log's path points at: only what every Log Source Type can tell. */
export interface LogStreamInfo {
  /** The Log Stream's name, as its node's. */
  name: string
  /** Whether it has a Previous Log to switch to, having restarted; only from a Source Type with Previous Logs. */
  hasPreviousLog?: boolean
  /**
   * Set, to why, when its log can't be read at all, nor will be by waiting: say a Docker container whose log driver
   * sends its log somewhere the engine can't read it back from.
   */
  unreadable?: string
  /** Set by a Kubernetes Logs Source: the container's pod and name, and how many times it has restarted. */
  kubernetes?: { pod: string; container: string; restarts: number }
}

/**
 * The contract every Log Source Type implements, checked by the shared suite in log-source-contract.ts, which checks
 * what it offers beyond that only as far as its `capabilities` say.
 * Paths are Source-relative ('/'-separated, '' for the root); implementations throw CoreError on failure.
 * A Previous Log is read through its Log Stream's path.
 */
export interface LogSource {
  readonly capabilities: LogCapabilities
  /**
   * The nodes under a node: under the root, then down through groups to Log Streams, which have none unless they
   * say they have (`hasChildren`). A node folding in its only child still lists it as its child.
   * Previous Logs aren't listed: they're read through their Log Streams' paths.
   * Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_FOLDER for a Log Stream's that has no children.
   */
  listChildren(path: SourcePath): Promise<LogNode[]>
  /**
   * What a log's path points at, and whether its log can be read. Fails with NOT_FOUND for a path that isn't in the
   * tree, NOT_A_LOG_STREAM for one that isn't a log's.
   */
  logStreamAt(path: SourcePath): Promise<LogStreamInfo>
  /**
   * A Log Stream's log as text, lines ending in '\n'. Fails like logStreamAt, with LOG_UNAVAILABLE when there's no log to
   * give yet (for a Previous Log, no run before the current one) or ever (`unreadable`), or with PREVIOUS_LOG_GONE for a Previous Log whose
   * run is no longer kept. Asked for a Previous Log only when the Source Type has them.
   */
  readLog(path: SourcePath, options?: LogReadOptions): Promise<string>
  /**
   * Starts following a Log Stream's current log, resolving once the backend is sending; `onText` gets
   * what arrives, in pieces that needn't end at a line break. Fails like readLog.
   */
  followLog(path: SourcePath, options: LogFollowOptions, onText: (text: string) => void): Promise<LogConnection>
  /**
   * A Log Stream's current run, looked at often while a Follow waits for a restart, so it may trust the path to be a
   * Log Stream's. Fails with NOT_FOUND once it's gone. Only, and always, from a Source Type with restarts.
   */
  currentRun?(path: SourcePath): Promise<LogStreamRun>
  /**
   * Lets go of what the Log Source holds open (a Docker Logs Source's SSH connection to its engine's host) once it's no
   * longer used. Left out by Source Types that hold nothing open.
   */
  close?(): void
  /**
   * Calls `listener` once what the Log Source holds open drops by itself, after which it can't be used: straight away if
   * it already has. Left out by Source Types that hold nothing open.
   */
  onDropped?(listener: () => void): void
}

/** A Log Source's way to look at a Log Stream's current run; undefined unless its Source Type has restarts. */
export const currentRunOf = (logSource: LogSource) => (logSource.capabilities.restarts ? logSource.currentRun?.bind(logSource) : undefined)
