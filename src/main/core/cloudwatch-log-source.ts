import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  type LogGroup,
  type LogStream,
  type OutputLogEvent
} from '@aws-sdk/client-cloudwatch-logs'
import type { CoreErrorCode, LogGroupNode, LogStreamNode, SourcePath } from '@shared/core-api'
import { cloudWatchNameOf as nameOf, cloudWatchSegment as segmentOf } from '@shared/core-api'
import { awsClientSettings, awsErrorOf, type AwsCredentials } from './aws-sign-in'
import { CoreError } from './core-error'
import type { LogConnection, LogFollowOptions, LogPage, LogReadOptions, LogSource } from './log-source'
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

/** The most events GetLogEvents gives in one request. */
const eventsLimit = 10_000

/** How often a Follow asks for what's new. */
const followInterval = 2_000

// CloudWatch Logs error codes and what they mean to the user, beyond those of signing in.
const cloudWatchCodes: Record<string, CoreErrorCode> = {
  ResourceNotFoundException: 'NOT_FOUND'
}

/** An event's lines, each with its timestamp if asked for: a message's line breaks are kept, bar a last one ending it. */
const linesOf = ({ timestamp = 0, message = '' }: OutputLogEvent, timestamps: boolean) => {
  const stamp = timestamps ? `${new Date(timestamp).toISOString()} ` : ''
  return message.replace(/\r?\n$/, '').split(/\r?\n/).map((line) => `${stamp}${line}\n`)
}

/** A Log Source over a region's log groups (those starting with the prefix), each a group of its log streams. */
export function createCloudWatchLogSource(target: CloudWatchTarget, { pageSize = cloudWatchPageSize, pollInterval = followInterval } = {}): LogSource {
  const client = new CloudWatchLogsClient({
    region: target.region,
    ...(target.endpoint && { endpoint: target.endpoint }),
    ...awsClientSettings(target.credentials, target)
  })

  const send = async <T>(what: string, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (error) {
      throw awsErrorOf(error, what, cloudWatchCodes)
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

  const groupNode = ({ logGroupName = '', storedBytes, retentionInDays }: LogGroup): LogGroupNode => ({
    kind: 'group',
    name: segmentOf(logGroupName),
    path: segmentOf(logGroupName),
    // A log group isn't its one stream: it holds every stream to come.
    unfoldable: true,
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

  /** Fails with NOT_FOUND unless the log group is there: listed by its name as a prefix, it comes first. */
  const checkGroup = async (group: string) => {
    const { logGroups = [] } = await send(group, () => client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group, limit: 1 })))
    if (logGroups[0]?.logGroupName !== group) throw new CoreError('NOT_FOUND', `No such log group: ${group}`)
  }

  /** Fails with NOT_FOUND unless the log stream is there, as checkGroup does. */
  const checkStream = async (group: string, stream: string) => {
    const where = `${group} ${stream}`
    const { logStreams = [] } = await send(where, () =>
      client.send(new DescribeLogStreamsCommand({ logGroupName: group, logStreamNamePrefix: stream, limit: 1 }))
    )
    if (logStreams[0]?.logStreamName !== stream) throw new CoreError('NOT_FOUND', `No such log stream: ${where}`)
  }

  /** A stream's log group's and its own name; NOT_A_LOG_STREAM for the root's or a log group's path. */
  const streamAt = async (path: SourcePath) => {
    const { group, stream } = partsOf(path)
    if (group === undefined) throw new CoreError('NOT_A_LOG_STREAM', 'The Source’s root isn’t a log stream')
    if (stream === undefined) {
      await checkGroup(group)
      throw new CoreError('NOT_A_LOG_STREAM', `A log group, not a log stream: ${group}`)
    }
    return { group, stream }
  }

  /** A page of the stream's events, from where `nextToken` says or else as `startFromHead` says, starting no sooner than `startTime`. */
  const eventsPage = (group: string, stream: string, page: { nextToken?: string; startFromHead: boolean; startTime?: number; limit?: number }) =>
    send(`${group} ${stream}`, () => client.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, ...page })))

  /** The stream's last `count` lines, read back from its end a page at a time. */
  const lastLines = async (group: string, stream: string, count: number, timestamps: boolean) => {
    let lines: string[] = []
    let token: string | undefined
    while (lines.length < count) {
      const limit = Math.min(count - lines.length, eventsLimit)
      const page = await eventsPage(group, stream, { startFromHead: false, limit, ...(token && { nextToken: token }) })
      lines = [...(page.events ?? []).flatMap((event) => linesOf(event, timestamps)), ...lines]
      // Back at its start, CloudWatch gives back the token it was given.
      if (!page.nextBackwardToken || page.nextBackwardToken === token) break
      token = page.nextBackwardToken
    }
    return lines.slice(-count).join('')
  }

  /** The stream's lines from its start, until about `limitBytes`. */
  const firstLines = async (group: string, stream: string, limitBytes: number, timestamps: boolean) => {
    let text = ''
    let bytes = 0
    let token: string | undefined
    for (;;) {
      const page = await eventsPage(group, stream, { startFromHead: true, ...(token && { nextToken: token }) })
      for (const line of (page.events ?? []).flatMap((event) => linesOf(event, timestamps))) {
        text += line
        bytes += Buffer.byteLength(line)
        if (bytes >= limitBytes) return text
      }
      // At its end, CloudWatch gives back the token it was given.
      if (!page.nextForwardToken || page.nextForwardToken === token) return text
      token = page.nextForwardToken
    }
  }

  const logSource: LogSource = {
    capabilities: { previousLog: false, restarts: false, status: false },

    async listPage(path, cursor): Promise<LogPage> {
      const { group, stream } = partsOf(path)
      const nextToken = cursor && { nextToken: cursor }
      if (group === undefined) {
        const page = await send('Log groups', () =>
          client.send(new DescribeLogGroupsCommand({ ...(target.prefix && { logGroupNamePrefix: target.prefix }), limit: pageSize, ...nextToken }))
        )
        return { nodes: (page.logGroups ?? []).map(groupNode), ...(page.nextToken && { cursor: page.nextToken }) }
      }
      if (stream === undefined) {
        const page = await send(group, () =>
          client.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: 'LastEventTime', descending: true, limit: pageSize, ...nextToken }))
        )
        return { nodes: (page.logStreams ?? []).map((s) => streamNode(group, s)), ...(page.nextToken && { cursor: page.nextToken }) }
      }
      await checkStream(group, stream)
      throw new CoreError('NOT_A_FOLDER', `A log stream has nothing under it: ${group} ${stream}`)
    },

    async listChildren(path) {
      const nodes: (LogGroupNode | LogStreamNode)[] = []
      let cursor: string | undefined
      do {
        const page = await logSource.listPage!(path, cursor)
        nodes.push(...(page.nodes as (LogGroupNode | LogStreamNode)[]))
        cursor = page.cursor
      } while (cursor !== undefined)
      return nodes
    },

    async logStreamAt(path) {
      const { group, stream } = await streamAt(path)
      await checkStream(group, stream)
      return { name: segmentOf(stream) }
    },

    async readLog(path, options: LogReadOptions = {}) {
      const { group, stream } = await streamAt(path)
      const timestamps = options.timestamps === true
      if (options.tailLines !== undefined) return lastLines(group, stream, options.tailLines, timestamps)
      return firstLines(group, stream, options.limitBytes ?? Infinity, timestamps)
    },

    // Asks for what's new every so often, from the last event seen. Its own schedule for now: one shared by all a
    // Source's Follows, backing off when throttled, is to come.
    async followLog(path, { sinceTime }: LogFollowOptions, onText): Promise<LogConnection> {
      const { group, stream } = await streamAt(path)
      const startTime = sinceTime === undefined ? undefined : Date.parse(sinceTime)
      let token: string | undefined
      let stopped = false
      let timer: NodeJS.Timeout | undefined
      const fetchNew = async () => {
        for (;;) {
          // The same request each time, but for the token: CloudWatch's tokens are good only for the request they came of.
          const page = await eventsPage(group, stream, { startFromHead: true, ...(startTime !== undefined && { startTime }), ...(token && { nextToken: token }) })
          const text = (page.events ?? []).flatMap((event) => linesOf(event, true)).join('')
          if (text && !stopped) onText(text)
          if (!page.nextForwardToken || page.nextForwardToken === token) return
          token = page.nextForwardToken
        }
      }
      await fetchNew()
      let end!: { resolve: () => void; reject: (error: unknown) => void }
      const ended = new Promise<void>((resolve, reject) => (end = { resolve, reject }))
      const poll = () => {
        timer = setTimeout(() => {
          fetchNew().then(
            () => !stopped && poll(),
            (error: unknown) => !stopped && end.reject(error)
          )
        }, pollInterval)
      }
      poll()
      return {
        ended,
        stop() {
          stopped = true
          clearTimeout(timer)
          end.resolve()
        }
      }
    }
  }
  return logSource
}
