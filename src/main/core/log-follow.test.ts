import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowUpdate } from '@shared/core-api'
import { CoreError } from './core-error'
import { followTiming, startFollow, type FollowOptions } from './log-follow'
import type { ContainerInstance, LogFollowOptions, LogSource } from './log-source'

const path = 'pods/web/app'

/** A stream the test drives: text arrives, then it ends or fails. */
interface FakeStream {
  options: LogFollowOptions
  send(text: string): void
  end(): void
  fail(error: CoreError): void
  stopped: boolean
}

/** A Log Source with one container, whose runs and streams the test drives. */
function fakeLogSource() {
  const instance: ContainerInstance = { restarts: 0, state: 'running', finished: false }
  const streams: FakeStream[] = []
  let gone = false
  /** Failures to answer the next attempts to follow with, one each. */
  const failures: CoreError[] = []
  /** Failures to answer the next looks at the container with, one each. */
  const lookFailures: CoreError[] = []

  const logSource: LogSource = {
    listChildren: () => Promise.reject(new Error('not used')),
    logStreamAt: () => Promise.reject(new Error('not used')),
    readLog: () => Promise.reject(new Error('not used')),
    async followLog(_path, options, onText) {
      const failure = failures.shift()
      if (failure) throw failure
      if (gone) throw new CoreError('NOT_FOUND', 'gone')
      let resolve!: () => void
      let reject!: (error: CoreError) => void
      const ended = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
      const stream: FakeStream = {
        options,
        stopped: false,
        send: (text) => !stream.stopped && onText(text),
        end: resolve,
        fail: reject
      }
      streams.push(stream)
      return {
        ended,
        stop: () => {
          stream.stopped = true
          resolve()
        }
      }
    },
    async containerInstance() {
      const failure = lookFailures.shift()
      if (failure) throw failure
      if (gone) throw new CoreError('NOT_FOUND', 'gone')
      return { ...instance }
    }
  }

  return {
    logSource,
    instance,
    streams,
    failures,
    lookFailures,
    /** The stream being followed now. */
    get stream() {
      return streams.at(-1)!
    },
    goAway: () => (gone = true)
  }
}

const at = (second: number) => `2026-09-27T10:00:${String(second).padStart(2, '0')}.000000001Z`
/** Log lines as the backend sends them: each with its timestamp, logged a second apart from `from`. */
const logged = (from: number, ...lines: string[]) => lines.map((line, i) => `${at(from + i)} ${line}\n`).join('')

let updates: FollowUpdate[]
let source: ReturnType<typeof fakeLogSource>

beforeEach(() => {
  vi.useFakeTimers()
  updates = []
  source = fakeLogSource()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Starts following the fake container, as if its snapshot ended with the line logged at `after`. */
async function follow(options: Partial<FollowOptions> = {}) {
  const follow = startFollow(source.logSource, path, {
    after: at(5),
    restarts: 0,
    timestamps: false,
    cap: 1_000,
    emit: (update) => updates.push(update),
    ...options
  })
  await settle()
  return follow
}

/** Lets pending work run, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

const lines = () => updates.flatMap((update) => (update.kind === 'lines' ? update.lines : [`<${update.kind}>`]))

describe('following a Log Stream', () => {
  it('carries on from the snapshot’s last line, leaving out what the snapshot had', async () => {
    await follow()

    expect(source.stream.options).toEqual({ sinceTime: at(5) })
    source.stream.send(logged(4, 'old', 'last shown', 'new', 'newer'))
    await settle()

    expect(updates).toEqual([{ kind: 'lines', lines: ['new', 'newer'] }])
  })

  it('keeps a new line logged at the same time as the last ones shown', async () => {
    await follow({ afterCount: 2 })

    source.stream.send([`${at(5)} shown`, `${at(5)} also shown`, `${at(5)} new`, `${at(6)} newer`, ''].join('\n'))
    await settle()

    expect(lines()).toEqual(['new', 'newer'])
  })

  it('keeps an empty line whose timestamp has nothing after it', async () => {
    await follow()

    source.stream.send(`${at(6)}\n${at(7)} next\n`)
    await settle()

    expect(lines()).toEqual(['', 'next'])
  })

  it('keeps each line’s timestamp when asked to', async () => {
    await follow({ timestamps: true })

    source.stream.send(logged(6, 'new'))
    await settle()

    expect(lines()).toEqual([`${at(6)} new`])
  })

  it('puts together lines that arrive in pieces', async () => {
    await follow()

    const text = logged(6, 'one', 'two')
    source.stream.send(text.slice(0, 10))
    source.stream.send(text.slice(10, -8))
    await settle()
    expect(lines()).toEqual(['one'])

    source.stream.send(text.slice(-8))
    await settle()
    expect(lines()).toEqual(['one', 'two'])
  })

  it('follows from the start of the current run when the snapshot had no lines', async () => {
    await follow({ after: undefined })

    expect(source.stream.options).toEqual({})
    source.stream.send(logged(1, 'first'))
    await settle()
    expect(lines()).toEqual(['first'])
  })
})

describe('a container that restarts', () => {
  it('marks the restart, then follows the new run from its start', async () => {
    await follow()
    source.stream.send(logged(6, 'crashing'))
    source.instance.state = 'terminated'
    source.stream.end()
    await vi.advanceTimersByTimeAsync(10_000)

    Object.assign(source.instance, { restarts: 1, state: 'running' })
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(source.streams).toHaveLength(2)
    expect(source.stream.options).toEqual({})
    // The new run's clock is no later than the old one's last line: its lines are all new all the same.
    source.stream.send(logged(6, 'starting again'))
    await settle()
    expect(lines()).toEqual(['crashing', '<restarted>', 'starting again'])
  })

  it('marks a restart it missed while reconnecting, as soon as it sees it', async () => {
    await follow()
    source.stream.end()
    source.instance.restarts = 2
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(lines()).toEqual(['<restarted>'])
    expect(source.stream.options).toEqual({})
  })

  it('reconnects without a mark when the stream ends but the container goes on', async () => {
    await follow()
    source.stream.send(logged(6, 'one'))
    source.stream.end()
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(source.streams).toHaveLength(2)
    expect(source.stream.options).toEqual({ sinceTime: at(6) })
    source.stream.send(logged(6, 'one', 'two'))
    await settle()
    expect(lines()).toEqual(['one', 'two'])
  })

  it('ends when the container has finished for good', async () => {
    await follow()
    Object.assign(source.instance, { state: 'terminated', finished: true })
    source.stream.end()
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(updates).toEqual([{ kind: 'ended', reason: 'exited' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(source.streams).toHaveLength(1)
  })

  it('ends when the container or its pod is gone', async () => {
    await follow()
    source.goAway()
    source.stream.end()
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(updates).toEqual([{ kind: 'ended', reason: 'gone' }])
  })

  it('gives out a last line that has no line break once the run ends', async () => {
    await follow()
    source.stream.send(logged(6, 'no newline').slice(0, -1))
    source.instance.state = 'terminated'
    source.stream.end()
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(lines()).toEqual(['no newline'])
  })

  it('waits for the rest of a line when the stream ends but the run goes on', async () => {
    await follow()
    source.stream.send(logged(6, 'whole line').slice(0, 30))
    source.stream.end()
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    source.stream.send(logged(6, 'whole line'))
    await settle()
    expect(lines()).toEqual(['whole line'])
  })
})

describe('a stream that fails', () => {
  const dropped = () => new CoreError('UNREACHABLE', 'connection reset')

  it('says so, and tries again after a second, from the last line', async () => {
    await follow()
    source.stream.send(logged(6, 'before'))
    source.stream.fail(dropped())
    await settle()

    expect(updates.at(-1)).toEqual({ kind: 'failed', code: 'UNREACHABLE', message: 'connection reset', retryIn: 1_000 })
    await vi.advanceTimersByTimeAsync(999)
    expect(source.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(source.stream.options).toEqual({ sinceTime: at(6) })
    source.stream.send(logged(6, 'before', 'after'))
    await settle()
    expect(lines()).toEqual(['before', '<failed>', '<recovered>', 'after'])
  })

  it('waits twice as long after each failure in a row, up to half a minute', async () => {
    await follow()
    source.failures.push(...Array.from({ length: 7 }, dropped))
    source.stream.fail(dropped())
    await settle()

    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(wait)
    await vi.advanceTimersByTimeAsync(30_000)

    const waits = updates.flatMap((update) => (update.kind === 'failed' ? [update.retryIn] : []))
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(updates.at(-1)).toEqual({ kind: 'recovered' })
  })

  it('starts waiting a second again once it has recovered', async () => {
    await follow()
    source.failures.push(dropped())
    source.stream.fail(dropped())
    await vi.advanceTimersByTimeAsync(1_000 + 2_000)

    source.stream.fail(dropped())
    await settle()
    expect(updates.at(-1)).toMatchObject({ kind: 'failed', retryIn: 1_000 })
  })

  it('also tries again when it cannot look at the container', async () => {
    await follow()
    source.stream.end()
    source.lookFailures.push(dropped())
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)

    expect(updates).toEqual([expect.objectContaining({ kind: 'failed', retryIn: 1_000 })])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.streams).toHaveLength(2)
    expect(updates.at(-1)).toEqual({ kind: 'recovered' })
  })

  it('treats a container with no log to give yet like one that is not running', async () => {
    await follow()
    source.instance.state = 'waiting'
    source.failures.push(new CoreError('LOG_UNAVAILABLE', 'waiting to start'))
    source.stream.end()
    source.instance.restarts = 1
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval * 3)
    expect(source.streams).toHaveLength(1)

    source.instance.state = 'running'
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)
    expect(lines()).toEqual(['<restarted>'])
    expect(source.streams).toHaveLength(2)
    expect(source.stream.options).toEqual({})
  })
})

describe('pausing', () => {
  it('holds updates back until resumed, then sends them in order', async () => {
    const following = await follow()
    following.pause()
    source.stream.send(logged(6, 'one'))
    source.stream.fail(new CoreError('UNREACHABLE', 'dropped'))
    await vi.advanceTimersByTimeAsync(1_000)
    source.stream.send(logged(7, 'two'))
    await settle()
    expect(updates).toEqual([])

    following.resume()
    expect(lines()).toEqual(['one', '<failed>', '<recovered>', 'two'])

    source.stream.send(logged(8, 'three'))
    await settle()
    expect(lines().at(-1)).toBe('three')
  })

  it('holds back at most the last N lines', async () => {
    const following = await follow({ cap: 3 })
    following.pause()
    source.stream.send(logged(6, 'a', 'b'))
    source.stream.send(logged(8, 'c', 'd', 'e'))
    await settle()

    following.resume()
    expect(lines()).toEqual(['c', 'd', 'e'])
  })

  it('keeps the marks among the lines it holds back', async () => {
    const following = await follow({ cap: 2 })
    following.pause()
    source.stream.send(logged(6, 'a', 'b'))
    source.stream.end()
    source.instance.restarts = 1
    await vi.advanceTimersByTimeAsync(followTiming.pollInterval)
    source.stream.send(logged(1, 'c'))
    await settle()

    following.resume()
    expect(lines()).toEqual(['b', '<restarted>', 'c'])
  })

  it('holds back every line when the Last N lines is all', async () => {
    const following = await follow({ cap: 'all' })
    following.pause()
    source.stream.send(logged(6, ...Array.from({ length: 50 }, (_, i) => `line ${i}`)))
    await settle()

    following.resume()
    expect(lines()).toHaveLength(50)
  })
})

describe('stopping', () => {
  it('hangs up, and sends nothing more', async () => {
    const following = await follow()
    const stream = source.stream

    following.stop()
    stream.send(logged(6, 'late'))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(stream.stopped).toBe(true)
    expect(updates).toEqual([])
    expect(source.streams).toHaveLength(1)
  })

  it('stops while waiting to try again', async () => {
    const following = await follow()
    source.stream.fail(new CoreError('UNREACHABLE', 'dropped'))
    await settle()

    following.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(source.streams).toHaveLength(1)
  })
})
