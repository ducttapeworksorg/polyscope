import type { LogNode, SourcePath } from '@shared/core-api'

/** How much of a log to read. */
export interface LogReadOptions {
  /** Only this many of the last lines; all of them when left out. */
  tailLines?: number
  /** Stops after about this many bytes from the start (the backend may overshoot a little); no limit when left out. */
  limitBytes?: number
}

/**
 * The contract every Log Source Type implements, checked by the shared suite in log-source-contract.ts.
 * Paths are Source-relative ('/'-separated, '' for the root); implementations throw CoreError on failure.
 */
export interface LogSource {
  /**
   * The nodes under a node: groups under the root, then down through Workloads and pods to containers,
   * which have none. Containers come in their pod's order, everything else in no particular order.
   * Fails with NOT_FOUND for a path that isn't in the tree, NOT_A_FOLDER for a container's.
   */
  listChildren(path: SourcePath): Promise<LogNode[]>
  /**
   * A container's log as text, lines ending in '\n'. Fails with NOT_FOUND for a path that isn't in the tree,
   * NOT_A_LOG_STREAM for one that isn't a container.
   */
  readLog(path: SourcePath, options?: LogReadOptions): Promise<string>
}
