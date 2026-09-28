import type { FollowUpdate, LastNLines, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { LogConnection, LogSource } from './log-source'

export interface FollowOptions {
  /** The timestamp of the last line already shown, which following carries on after; from the start of the current run when left out. */
  after?: string
  /** How many of the lines already shown have that timestamp; 1 when left out. */
  afterCount?: number
  /** How many times the container had restarted when those lines were read. */
  restarts: number
  /** Whether lines keep their timestamps. */
  timestamps: boolean
  /** How many lines a paused Follow holds back at most. */
  cap: LastNLines
  emit(update: FollowUpdate): void
}

/** A Follow under way. */
export interface Follow {
  pause(): void
  resume(): void
  stop(): void
}

/** How long a Follow waits, in milliseconds. */
export const followTiming = {
  /** Between looks at a container that isn't running, to catch it restarting. */
  pollInterval: 2_000,
  /** Before trying a failed stream again the first time; each failure in a row doubles it… */
  firstRetry: 1_000,
  /** …up to this. */
  maxRetry: 30_000
}

/** An RFC 3339 UTC timestamp made comparable as a string: its fraction of a second padded to nanoseconds. */
const comparable = (timestamp: string) => {
  const [whole, fraction = ''] = timestamp.replace(/Z$/, '').split('.')
  return `${whole}.${fraction.padEnd(9, '0')}`
}

export const asCoreError = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))

/**
 * Passes a Follow's updates on to `send`, or, while paused, holds them back until resumed: at most the
 * last `cap` lines, dropping the oldest and any marks before them.
 */
export function holdBack(cap: LastNLines, send: (update: FollowUpdate) => void) {
  // Updates held back while paused, in order; undefined while not.
  let held: FollowUpdate[] | undefined
  return {
    emit(update: FollowUpdate) {
      if (!held) return send(update)
      held.push(update)
      if (cap === 'all') return
      let excess = held.reduce((count, u) => count + (u.kind === 'lines' ? u.lines.length : 0), 0) - cap
      while (excess > 0) {
        const first = held[0]!
        if (first.kind !== 'lines') held.shift()
        else if (first.lines.length <= excess) {
          excess -= first.lines.length
          held.shift()
        } else {
          held[0] = { kind: 'lines', lines: first.lines.slice(excess) }
          excess = 0
        }
      }
    },
    pause() {
      held ??= []
    },
    resume() {
      const updates = held ?? []
      held = undefined
      for (const update of updates) send(update)
    }
  }
}

/**
 * Follows a container's log in a Log Source, sending what comes as updates. When the stream ends it
 * looks at the container: a new run is marked and followed from its start; a run still going is
 * followed on from the last line; a container finished for good, or gone, ends the Follow.
 */
export function startFollow(logSource: LogSource, path: SourcePath, options: FollowOptions): Follow {
  const { timestamps } = options
  const hold = holdBack(options.cap, options.emit)
  const { emit } = hold
  let restarts = options.restarts
  // The last line sent's timestamp (comparable) and as the backend gave it; lines before it were sent already…
  let after = options.after === undefined ? undefined : comparable(options.after)
  let since = options.after
  // …and so were this many lines at it. A stream going on from it sends those again first, which are skipped.
  let atAfter = options.after === undefined ? 0 : (options.afterCount ?? 1)
  let toSkip = 0
  // What arrived after the last line break, waiting for the rest of its line.
  let partial = ''
  let stopped = false
  let connection: LogConnection | undefined
  let wake: (() => void) | undefined

  const sendLines = (pieces: string[]) => {
    const lines: string[] = []
    for (const line of pieces) {
      // An empty line may come as its timestamp alone.
      const space = line.indexOf(' ')
      const cut = space < 0 ? line.length : space
      const timestamp = comparable(line.slice(0, cut))
      if (after !== undefined && timestamp < after) continue
      if (timestamp === after && toSkip > 0) {
        toSkip--
        continue
      }
      if (timestamp === after) atAfter++
      else [after, atAfter] = [timestamp, 1]
      since = line.slice(0, cut)
      lines.push(timestamps ? line : line.slice(cut + 1))
    }
    if (lines.length) emit({ kind: 'lines', lines })
  }

  const receive = (text: string) => {
    if (stopped) return
    const pieces = (partial + text).split('\n')
    partial = pieces.pop()!
    sendLines(pieces)
  }

  /** Waits `ms`, or less if the Follow is stopped meanwhile. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  /** Sends a last line that has no line break, its run being over. */
  const flush = () => {
    if (partial) sendLines([partial])
    partial = ''
  }

  const end = (reason: 'exited' | 'gone') => {
    flush()
    stopped = true
    emit({ kind: 'ended', reason })
  }

  // Failures in a row; each doubles the wait before trying again.
  let failures = 0

  const run = async () => {
    // The first stream goes on from the snapshot, whatever state the container is in.
    let follow = true
    while (!stopped) {
      try {
        if (!follow) {
          const instance = await logSource.containerInstance(path)
          if (stopped) return
          if (instance.restarts > restarts) {
            flush()
            restarts = instance.restarts
            after = since = undefined
            atAfter = 0
            emit({ kind: 'restarted' })
          } else if (instance.state !== 'running') {
            if (instance.finished) return end('exited')
            flush()
            await sleep(followTiming.pollInterval)
            continue
          }
        }
        follow = false
        // A line cut short is sent again whole: following goes on from the line before it.
        partial = ''
        toSkip = atAfter
        try {
          connection = await logSource.followLog(path, since === undefined ? {} : { sinceTime: since }, receive)
        } catch (error) {
          // No log to give yet, say a container waiting to start: look again in a while.
          if (asCoreError(error).code !== 'LOG_UNAVAILABLE') throw error
          await sleep(followTiming.pollInterval)
          continue
        }
        if (stopped) return connection.stop()
        if (failures) emit({ kind: 'recovered' })
        failures = 0
        await connection.ended
        if (stopped) return
        await sleep(followTiming.pollInterval)
      } catch (error) {
        if (stopped) return
        const { code, message } = asCoreError(error)
        if (code === 'NOT_FOUND') return end('gone')
        const retryIn = Math.min(followTiming.firstRetry * 2 ** failures, followTiming.maxRetry)
        failures++
        emit({ kind: 'failed', code, message, retryIn })
        await sleep(retryIn)
      }
    }
  }

  void run()

  return {
    pause: hold.pause,
    resume: hold.resume,
    stop() {
      stopped = true
      connection?.stop()
      wake?.()
    }
  }
}
