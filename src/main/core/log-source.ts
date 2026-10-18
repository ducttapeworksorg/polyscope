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
  /** Only lines logged since this RFC 3339 time, `tailLines` taking the last of those; asked only of a Source Type with Since. */
  sinceTime?: string
}

/** Where following a log starts: from the start of the Log Stream's current run unless told. Lines always come with their timestamps, as with `timestamps` when reading. */
export interface LogFollowOptions {
  /** Only lines logged since this RFC 3339 time; the backend may go back to the start of its second. */
  sinceTime?: string
  /**
   * Called by a backend that polls when it's slowed down (CloudWatch Logs, when AWS throttles it) with true, and with
   * false once it no longer is.
   */
  onSlowed?(slowed: boolean): void
}

/** The connection a log is followed over. */
export interface LogConnection {
  /** Resolves when the backend stops sending (say, the container ended); rejects with a CoreError if the stream fails. */
  ended: Promise<void>
  /** Hangs up; `ended` settles either way, and nothing more arrives. */
  stop(): void
}

/** How many of a log's lines to read back from where `before` says; see LogSource.readLogBack. */
export interface LogReadBackOptions {
  tailLines: number
  /** Where to read back from: a `before` that readLogBack gave; the log's end when left out. */
  before?: string
  /** Starts each line with when it was logged, as for readLog. */
  timestamps?: boolean
  /**
   * Only lines logged since this RFC 3339 time, as for readLog; the `before` it gives reads back no further than that.
   * Left out with a `before`, which keeps the Since it was read with. Asked only of a Source Type with Since.
   */
  sinceTime?: string
}

/** Lines read back, and where the lines before them end. */
export interface LogReadBack {
  /** Lines ending in '\n', at most as many as asked for. */
  text: string
  /** Where the lines before these end, to read them with; left out at the log's start, or at the Since it was read with. */
  before?: string
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

/** A page of the nodes under a node, with where the next page starts if there are more. */
export interface LogPage {
  nodes: LogNode[]
  /** Lists the next page; left out on the last. */
  cursor?: string
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
   * A page of the nodes under a node, which listChildren lists all at once, from where `cursor` says (the first page when
   * left out): from a Source Type with nodes too many to list at once, like CloudWatch Logs' log groups and streams.
   * Fails as listChildren does. Left out by Source Types that list them all at once.
   */
  listPage?(path: SourcePath, cursor?: string): Promise<LogPage>
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
   * A Log Stream's last lines before where `before` says (as readLog's `tailLines` reads them, when left out), with
   * where the lines before those end: from a Source Type that can read further back. Fails as readLog does. Left out
   * by Source Types that can't.
   */
  readLogBack?(path: SourcePath, options: LogReadBackOptions): Promise<LogReadBack>
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
