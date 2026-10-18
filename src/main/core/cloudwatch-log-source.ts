import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  type LogGroup,
  type LogStream
} from '@aws-sdk/client-cloudwatch-logs'
import type { CoreErrorCode, LogStreamNode, SourcePath } from '@shared/core-api'
import { cloudWatchNameOf as nameOf, cloudWatchSegment as segmentOf } from '@shared/core-api'
import { awsClientSettings, awsErrorsOf, type AwsCredentials } from './aws-sign-in'
import { CoreError } from './core-error'
import type { LogConnection, LogFollowOptions, LogPage, LogReadBack, LogReadBackOptions, LogReadOptions, LogSource } from './log-source'
import type { NetworkSettings } from './network-agents'

// Only DescribeLogGroups, DescribeLogStreams, GetLogEvents and FilterLogEvents are ever called: none of them is billed
// per use, as Live Tail and Logs Insights are (ADR 0008).

/** Where a CloudWatch Logs Source points and how it signs in, normalised and with its secret filled in. */
export interface CloudWatchTarget extends NetworkSettings {
  region: string
  /** Shows only the log groups whose names start with it; blank for all of them. */
  prefix: string
  /** A URL with its scheme, or blank for the region's own. */
  endpoint: string
  credentials: AwsCredentials
}

/** The most log groups or streams CloudWatch describes in one request, and so in one page of the tree. */
export const cloudWatchPageSize = 50

/** The most events GetLogEvents and FilterLogEvents give in one request. */
const eventsLimit = 10_000

/** How far back from now a log group's merged log is first read back over; each window further back is wider. */
const firstWindow = 15 * 60_000
const windowGrowth = 4

/** How long before a log group was made its events may have been logged: CloudWatch takes none older than that. */
const backfill = 14 * 24 * 60 * 60_000

/** How far ahead of now an event may have been logged: CloudWatch takes none further ahead. */
const ahead = 2 * 60 * 60_000

/** How often a Source's Follows ask for what's new, in milliseconds. */
export const cloudWatchFollowTiming = {
  /** Between rounds, each asking once for each Followed log… */
  interval: 2_000,
  /** …or, while AWS throttles them, twice as long after each throttled round, up to this. */
  maxInterval: 30_000
}

/** The CloudWatch Logs actions Polyscope may call: none of them billed per use (ADR 0008). */
type CloudWatchAction = 'DescribeLogGroups' | 'DescribeLogStreams' | 'GetLogEvents' | 'FilterLogEvents'

// CloudWatch Logs error codes and what they mean to the user, beyond those of signing in.
const cloudWatchCodes: Record<string, CoreErrorCode> = {
  ResourceNotFoundException: 'NOT_FOUND',
  ThrottlingException: 'THROTTLED'
}

/** An event as GetLogEvents or FilterLogEvents gives it; only the latter tells its stream. */
interface LogEvent {
  timestamp?: number
  message?: string
  logStreamName?: string
  eventId?: string
}

/** A line of an event, without its timestamp, which it keeps apart. */
interface Line {
  timestamp: number
  text: string
}

/**
 * A short form of a log stream's name, starting each of its lines in its log group's merged log: its last part, less
 * a Lambda version's `[…]`, and of a long hexadecimal id (an ECS task's, a Lambda instance's) only the start.
 */
export const shortStreamName = (name: string) => {
  const last = name.slice(name.lastIndexOf('/') + 1).replace(/^\[[^\]]*\]/, '') || name
  return /^[\da-f]{17,}$/i.test(last) ? last.slice(0, 8) : last
}

/**
 * An event's lines: a message's line breaks are kept, bar a last one ending it. In a log group's merged log, each
 * starts with a short form of its stream's name.
 */
const eventLines = ({ timestamp = 0, message = '', logStreamName }: LogEvent, merged: boolean): Line[] => {
  const prefix = merged ? `[${shortStreamName(logStreamName ?? '')}] ` : ''
  return message.replace(/\r?\n$/, '').split(/\r?\n/).map((line) => ({ timestamp, text: `${prefix}${line}` }))
}

/** A line as text, with its timestamp if asked for. */
const lineText = ({ timestamp, text }: Line, timestamps: boolean) => `${timestamps ? `${new Date(timestamp).toISOString()} ` : ''}${text}\n`

/** An event's lines as text. */
const linesOf = (event: LogEvent, merged: boolean, timestamps: boolean) => eventLines(event, merged).map((line) => lineText(line, timestamps))

/**
 * Where lines read back end, as readLogBack's `before`: the time of the first line read, and how many lines at that
 * time were read already (counting from the last line before that time), so the next read back skips them.
 */
const placeText = (time: number, seen: number) => `${time}/${seen}`

const placeOf = (before: string) => {
  const [, time, seen] = /^(\d+)\/(\d+)$/.exec(before) ?? []
  if (time === undefined) throw new CoreError('LOG_UNAVAILABLE', `Not a place in a CloudWatch log: ${before}`)
  return { time: Number(time), seen: Number(seen) }
}

/** The last lines logged before `end` (of all of them, when left out): at least `needed` of them, unless there are fewer. */
type LinesBefore = (end: number | undefined, needed: number) => Promise<{ lines: Line[] }>

/** A Log Source over a region's log groups (those starting with the prefix), each a group of its log streams. */
export function createCloudWatchLogSource(target: CloudWatchTarget, { pageSize = cloudWatchPageSize } = {}): LogSource {
  const clientSettings = {
    region: target.region,
    ...(target.endpoint && { endpoint: target.endpoint }),
    ...awsClientSettings(target.credentials, target)
  }
  const client = new CloudWatchLogsClient(clientSettings)
  // Following asks again each round anyway, backing off when throttled, so its requests aren't tried again: that
  // would only add to what AWS is throttling.
  const followClient = new CloudWatchLogsClient({ ...clientSettings, maxAttempts: 1 })

  const toCoreError = awsErrorsOf(target.credentials, cloudWatchCodes)

  /**
   * Runs a request about `what` for one of the four actions, its failure as a CoreError: a denial names the action
   * the user's IAM policy needs to allow, like `logs:FilterLogEvents`, then AWS's own account of it (an explicit deny,
   * say, or an organisation's policy).
   */
  const send = async <T>(what: string, action: CloudWatchAction, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      const failure = toCoreError(error, what)
      if (failure.code !== 'PERMISSION_DENIED') throw failure
      const said = error instanceof Error && error.message ? `: ${error.message}` : ''
      throw new CoreError('MISSING_PERMISSION', `logs:${action} on ${what}${said}`)
    }
  }

  /** A path's log group's name, and its stream's if it's a stream's; NOT_FOUND for one that can't be in the tree. */
  const partsOf = (path: SourcePath) => {
    if (!path) return {}
    const segments = path.split('/')
    const [group, stream] = segments.map(nameOf)
    if (segments.length > 2 || segments.some((segment) => !segment) || !group!.startsWith(target.prefix)) {
      throw new CoreError('NOT_FOUND', `Not a log group or stream of this Source: ${path}`)
    }
    return { group, stream }
  }

  // A log group is a log of its own, its streams' merged, so folds none of them in.
  const groupNode = ({ logGroupName = '', storedBytes, retentionInDays }: LogGroup): LogStreamNode => ({
    kind: 'logStream',
    name: segmentOf(logGroupName),
    path: segmentOf(logGroupName),
    hasChildren: true,
    cloudwatch: {
      kind: 'logGroup',
      ...(storedBytes !== undefined && { storedBytes }),
      ...(retentionInDays !== undefined && { retentionDays: retentionInDays })
    }
  })

  const streamNode = (group: string, { logStreamName = '', lastEventTimestamp }: LogStream): LogStreamNode => ({
    kind: 'logStream',
    name: segmentOf(logStreamName),
    path: `${segmentOf(group)}/${segmentOf(logStreamName)}`,
    cloudwatch: { kind: 'logStream', ...(lastEventTimestamp !== undefined && { lastEventTime: lastEventTimestamp }) }
  })

  /** The log group, failing with NOT_FOUND unless it's there: listed by its name as a prefix, it comes first. */
  const checkGroup = async (group: string) => {
    const { logGroups = [] } = await send(group, 'DescribeLogGroups', () => client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group, limit: 1 })))
    if (logGroups[0]?.logGroupName !== group) throw new CoreError('NOT_FOUND', `No such log group: ${group}`)
    return logGroups[0]
  }

  /** Fails with NOT_FOUND unless the log stream is there, as checkGroup does. */
  const checkStream = async (group: string, stream: string) => {
    const where = `${group} ${stream}`
    const { logStreams = [] } = await send(where, 'DescribeLogStreams', () =>
      client.send(new DescribeLogStreamsCommand({ logGroupName: group, logStreamNamePrefix: stream, limit: 1 }))
    )
    if (logStreams[0]?.logStreamName !== stream) throw new CoreError('NOT_FOUND', `No such log stream: ${where}`)
  }

  /** Fails with NOT_FOUND unless the log is there: a log group's merged log, or a stream's. */
  const checkLog = (group: string, stream: string | undefined) => (stream === undefined ? checkGroup(group) : checkStream(group, stream))

  /** A log's log group's name, and its stream's unless it's the group's merged log; NOT_A_LOG_STREAM for the root's path. */
  const logAt = (path: SourcePath) => {
    const { group, stream } = partsOf(path)
    if (group === undefined) throw new CoreError('NOT_A_LOG_STREAM', 'The Source’s root isn’t a log stream')
    return { group, stream }
  }

  /** A page of the stream's events, from where `nextToken` says or else as `startFromHead` says, starting no sooner than `startTime`. */
  const eventsPage = (
    group: string,
    stream: string,
    page: { nextToken?: string; startFromHead: boolean; startTime?: number; endTime?: number; limit?: number },
    sender = client
  ) => send(`${group} ${stream}`, 'GetLogEvents', () => sender.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, ...page })))

  /** A page of the log group's events, all its streams' interleaved by time, from `startTime` up to `endTime`. */
  const groupPage = (group: string, page: { nextToken?: string; startTime?: number; endTime?: number }, sender = client) =>
    send(group, 'FilterLogEvents', () => sender.send(new FilterLogEventsCommand({ logGroupName: group, ...page })))

  /** A stream's lines before a time, read back from it a page at a time. */
  const streamLinesBefore =
    (group: string, stream: string): LinesBefore =>
    async (end, needed) => {
      let lines: Line[] = []
      let token: string | undefined
      while (lines.length < needed) {
        const limit = Math.min(needed - lines.length, eventsLimit)
        const page = await eventsPage(group, stream, { startFromHead: false, limit, ...(end !== undefined && { endTime: end }), ...(token && { nextToken: token }) })
        lines = [...(page.events ?? []).flatMap((event) => eventLines(event, false)), ...lines]
        // Back at its start, CloudWatch gives back the token it was given.
        if (!page.nextBackwardToken || page.nextBackwardToken === token) break
        token = page.nextBackwardToken
      }
      return { lines }
    }

  /**
   * The last of a log group's lines from `start` up to (not including) `end`: at least `needed` of them, unless there
   * are fewer. FilterLogEvents gives a span's events oldest first, so a span with more than a page of them is halved,
   * its later half read first, rather than read through to its end. Events logged at the same time come in the order
   * of their streams' names, as CloudWatch promises none.
   */
  const lastInSpan = async (group: string, start: number, end: number, needed: number): Promise<Line[]> => {
    // FilterLogEvents' end time, unlike GetLogEvents', is the last it gives.
    const span = { ...(start > 0 && { startTime: start }), endTime: end - 1 }
    const events: LogEvent[] = []
    let token: string | undefined
    do {
      const page = await groupPage(group, { ...span, ...(token && { nextToken: token }) })
      events.push(...(page.events ?? []))
      token = page.nextToken
      if (token && events.length >= eventsLimit && end - start > 1) {
        const middle = start + Math.floor((end - start) / 2)
        const later = await lastInSpan(group, middle, end, needed)
        if (later.length >= needed) return later
        return [...(await lastInSpan(group, start, middle, needed - later.length)), ...later]
      }
    } while (token)
    const byStream = (a: LogEvent, b: LogEvent) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || ((a.logStreamName ?? '') < (b.logStreamName ?? '') ? -1 : (a.logStreamName ?? '') > (b.logStreamName ?? '') ? 1 : 0)
    return events.toSorted(byStream).flatMap((event) => eventLines(event, true))
  }

  /**
   * A log group's lines before a time, its streams' merged: read back over a recent window, then wider and wider ones
   * further back, until there are enough of them or the window reaches back to the group's start.
   */
  const groupLinesBefore =
    (group: string, created: number): LinesBefore =>
    async (before, needed) => {
      const start = created - backfill
      let end = before ?? Date.now() + ahead
      let width = firstWindow
      let lines: Line[] = []
      for (;;) {
        const from = Math.min(before ?? Date.now(), end) - width
        const atStart = from <= start
        lines = [...(await lastInSpan(group, atStart ? 0 : from, end, needed - lines.length)), ...lines]
        if (lines.length >= needed || atStart) return { lines }
        end = from
        width *= windowGrowth
      }
    }

  /**
   * The log's last `tailLines` lines before where `before` says, and where the lines before them end: a line more is
   * read, to tell whether there are any.
   */
  const readBack = async (linesBefore: LinesBefore, { tailLines, before, timestamps = false }: LogReadBackOptions): Promise<LogReadBack> => {
    const { time, seen } = before === undefined ? { time: undefined, seen: 0 } : placeOf(before)
    const { lines } = await linesBefore(time === undefined ? undefined : time + 1, tailLines + seen + 1)
    const unseen = Math.max(0, lines.length - seen)
    const from = Math.max(0, unseen - tailLines)
    const read = lines.slice(from, unseen)
    const text = read.map((line) => lineText(line, timestamps)).join('')
    if (from === 0) return { text }
    const first = read[0]!.timestamp
    return { text, before: placeText(first, lines.slice(from).filter((line) => line.timestamp === first).length) }
  }

  /** How a log's lines are read back: a stream's, or its log group's merged. */
  const linesBeforeOf = async (path: SourcePath) => {
    const { group, stream } = logAt(path)
    if (stream !== undefined) return streamLinesBefore(group, stream)
    const { creationTime = 0 } = await checkGroup(group)
    return groupLinesBefore(group, creationTime)
  }

  /** The log's lines from its start, until about `limitBytes`. */
  const firstLines = async (group: string, stream: string | undefined, limitBytes: number, timestamps: boolean) => {
    let text = ''
    let bytes = 0
    let token: string | undefined
    for (;;) {
      const nextToken = token && { nextToken: token }
      // At a stream's end, CloudWatch gives back the token it was given; at a group's, none.
      const { events = [], next } =
        stream === undefined ?
          await groupPage(group, { ...nextToken }).then((page) => ({ ...page, next: page.nextToken }))
        : await eventsPage(group, stream, { startFromHead: true, ...nextToken }).then((page) => ({ ...page, next: page.nextForwardToken }))
      for (const line of events.flatMap((event) => linesOf(event, stream === undefined, timestamps))) {
        text += line
        bytes += Buffer.byteLength(line)
        if (bytes >= limitBytes) return text
      }
      if (!next || next === token) return text
      token = next
    }
  }

  /**
   * Asks once for a stream's events from where it got to last, and calls `onText` with what's new. Its tokens are good
   * only for the request they came of, so it's the same request each time, but for the token; at the stream's end,
   * CloudWatch gives back the token it was given, which goes on to what's logged next.
   */
  const streamFetcher = (group: string, stream: string, startTime: number | undefined, onText: (text: string) => void) => {
    let token: string | undefined
    return async () => {
      const page = await eventsPage(group, stream, { startFromHead: true, ...(startTime !== undefined && { startTime }), ...(token && { nextToken: token }) }, followClient)
      const text = (page.events ?? []).flatMap((event) => linesOf(event, false, true)).join('')
      if (text) onText(text)
      token = page.nextForwardToken ?? token
    }
  }

  /**
   * Asks once for a log group's events from the time of the last one seen, or for the next page of those asked for
   * last, and calls `onText` with what's new: those at that time are asked for again, so the ones seen already are
   * told by their event ids and dropped. FilterLogEvents searches all the group's streams, so new ones join in.
   */
  const groupFetcher = (group: string, startTime: number | undefined, onText: (text: string) => void) => {
    let latest = startTime
    let seenAtLatest = new Set<string>()
    // The start time of the request whose next page `token` is, which asking for that page repeats.
    let since = latest
    let token: string | undefined
    return async () => {
      if (!token) since = latest
      const page = await groupPage(group, { ...(since !== undefined && { startTime: since }), ...(token && { nextToken: token }) }, followClient)
      const fresh = (page.events ?? []).filter(({ timestamp = 0, eventId = '' }) => {
        if (timestamp === latest && seenAtLatest.has(eventId)) return false
        if (latest === undefined || timestamp > latest) [latest, seenAtLatest] = [timestamp, new Set()]
        seenAtLatest.add(eventId)
        return true
      })
      const text = fresh.flatMap((event) => linesOf(event, true, true)).join('')
      if (text) onText(text)
      token = page.nextToken
    }
  }

  /** A Followed log, as the poller asks for it. */
  interface Followed {
    /** Asks once for what's new. */
    fetch(): Promise<void>
    /** Tells it, after each round that didn't fail it, whether AWS throttled the round. */
    asked(throttled: boolean): void
    /** Fails its Follow. */
    fail(error: unknown): void
  }

  /**
   * The one schedule all the Source's Follows are asked for on, a round every so often while there are any: each
   * round asks once for each, together. While AWS throttles a round, each next one waits twice as long, up to a
   * ceiling.
   */
  const poller = (() => {
    const followed = new Set<Followed>()
    let timer: NodeJS.Timeout | undefined
    let running = false
    let wait = 0

    const schedule = () => {
      if (timer || running || !followed.size) return
      timer = setTimeout(() => void round(), wait || cloudWatchFollowTiming.interval)
    }

    const round = async () => {
      timer = undefined
      running = true
      const asked = [...followed]
      const results = await Promise.allSettled(asked.map((log) => log.fetch()))
      running = false
      const failed = new Set<Followed>()
      let throttled = false
      results.forEach((result, i) => {
        const log = asked[i]!
        if (result.status === 'fulfilled' || !followed.has(log)) return
        if (result.reason instanceof CoreError && result.reason.code === 'THROTTLED') throttled = true
        else {
          followed.delete(log)
          failed.add(log)
          log.fail(result.reason)
        }
      })
      // The Follows all stopped meanwhile: the next one starts afresh.
      if (!followed.size) return void (wait = 0)
      const { interval, maxInterval } = cloudWatchFollowTiming
      wait = throttled ? Math.min(Math.max(wait, interval) * 2, maxInterval) : 0
      for (const log of asked) if (followed.has(log) && !failed.has(log)) log.asked(throttled)
      schedule()
    }

    return {
      add(log: Followed) {
        followed.add(log)
        schedule()
      },
      delete(log: Followed) {
        followed.delete(log)
        if (followed.size) return
        clearTimeout(timer)
        timer = undefined
        wait = 0
      }
    }
  })()

  const logSource: LogSource = {
    capabilities: { previousLog: false, restarts: false, status: false, since: false },

    async listPage(path, cursor): Promise<LogPage> {
      const { group, stream } = partsOf(path)
      const nextToken = cursor && { nextToken: cursor }
      if (group === undefined) {
        const page = await send('log groups', 'DescribeLogGroups', () =>
          client.send(new DescribeLogGroupsCommand({ ...(target.prefix && { logGroupNamePrefix: target.prefix }), limit: pageSize, ...nextToken }))
        )
        return { nodes: (page.logGroups ?? []).map(groupNode), ...(page.nextToken && { cursor: page.nextToken }) }
      }
      if (stream === undefined) {
        const page = await send(group, 'DescribeLogStreams', () =>
          client.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: 'LastEventTime', descending: true, limit: pageSize, ...nextToken }))
        )
        return { nodes: (page.logStreams ?? []).map((s) => streamNode(group, s)), ...(page.nextToken && { cursor: page.nextToken }) }
      }
      await checkStream(group, stream)
      throw new CoreError('NOT_A_FOLDER', `A log stream has nothing under it: ${group} ${stream}`)
    },

    async listChildren(path) {
      const nodes: LogStreamNode[] = []
      let cursor: string | undefined
      do {
        const page = await logSource.listPage!(path, cursor)
        nodes.push(...(page.nodes as LogStreamNode[]))
        cursor = page.cursor
      } while (cursor !== undefined)
      return nodes
    },

    async logStreamAt(path) {
      const { group, stream } = logAt(path)
      await checkLog(group, stream)
      return { name: segmentOf(stream ?? group) }
    },

    async readLog(path, options: LogReadOptions = {}) {
      const timestamps = options.timestamps === true
      if (options.tailLines !== undefined) return (await logSource.readLogBack!(path, { tailLines: options.tailLines, timestamps })).text
      const { group, stream } = logAt(path)
      if (stream === undefined) await checkGroup(group)
      return firstLines(group, stream, options.limitBytes ?? Infinity, timestamps)
    },

    async readLogBack(path, options) {
      return readBack(await linesBeforeOf(path), options)
    },

    // Asked for what's new on the Source's one schedule, from the last event seen, once its first round has asked:
    // a log that isn't there fails that with NOT_FOUND, so isn't looked for first, which would be one more request to
    // throttle. One whose first round AWS throttled is followed, slowed.
    async followLog(path, { sinceTime, onSlowed }: LogFollowOptions, onText): Promise<LogConnection> {
      const { group, stream } = logAt(path)
      const startTime = sinceTime === undefined ? undefined : Date.parse(sinceTime)
      let stopped = false
      const sendText = (text: string) => !stopped && onText(text)
      let start!: { resolve: () => void; reject: (error: unknown) => void }
      const started = new Promise<void>((resolve, reject) => (start = { resolve, reject }))
      let end!: typeof start
      const ended = new Promise<void>((resolve, reject) => (end = { resolve, reject }))
      let isStarted = false
      const log: Followed = {
        fetch: stream === undefined ? groupFetcher(group, startTime, sendText) : streamFetcher(group, stream, startTime, sendText),
        asked(throttled) {
          isStarted = true
          start.resolve()
          if (!stopped) onSlowed?.(throttled)
        },
        fail: (error) => (isStarted ? !stopped && end.reject(error) : start.reject(error))
      }
      poller.add(log)
      await started
      return {
        ended,
        stop() {
          stopped = true
          poller.delete(log)
          end.resolve()
        }
      }
    }
  }
  return logSource
}
