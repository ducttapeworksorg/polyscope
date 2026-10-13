// Test support: a stand-in for CloudWatch Logs, in the test process, speaking its JSON protocol for the four operations
// Polyscope may call (ADR 0008) over plain HTTP, for an SDK client pointed at it through its endpoint. It holds the log
// groups it's seeded with, records every operation it's asked for, and turns away any other as AWS turns away one it
// doesn't know. Given an access key, it turns away requests signed with another. It can be told to throttle, as AWS
// does once an account's requests go over its quota, and to deny operations, as IAM does those a policy doesn't allow.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The only CloudWatch Logs operations Polyscope may call: none of them billed per use (ADR 0008). */
export const allowedCloudWatchOperations = ['DescribeLogGroups', 'DescribeLogStreams', 'GetLogEvents', 'FilterLogEvents'] as const

export interface TestLogEvent {
  /** Milliseconds since the epoch. */
  timestamp: number
  message: string
}

export interface TestLogStream {
  name: string
  /** In the order they were logged. */
  events?: TestLogEvent[]
  /** Milliseconds since the epoch; its first event's time, or else the epoch, when left out. */
  createdAt?: number
}

export interface TestLogGroup {
  name: string
  streams?: TestLogStream[]
  /** Left out for a group that keeps its events for ever. */
  retentionDays?: number
  storedBytes?: number
  createdAt?: number
}

export interface TestCloudWatchEndpoint {
  /** Where to point an SDK client, e.g. `http://127.0.0.1:41234`. */
  url: string
  /** Every operation asked for, in order, allowed or not. */
  operations: string[]
  /** Likewise, with when each was asked for, in milliseconds since the epoch. */
  calls: { operation: string; at: number }[]
  /** While set, turns every request away with a ThrottlingException. */
  throttling: boolean
  /** Operations turned away with an AccessDeniedException, as for a user whose IAM policy doesn't allow them. */
  denied: Set<(typeof allowedCloudWatchOperations)[number]>
  /** The seeded groups, to add events, streams or groups to as a test goes on. */
  groups: TestLogGroup[]
  close(): Promise<void>
}

/** The most a Describe operation lists in one page, and the most events GetLogEvents and FilterLogEvents give in one. */
const describeLimit = 50
const eventsLimit = 10_000

type Request = Record<string, unknown>

class AwsError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

const numberOf = (value: unknown) => (typeof value === 'number' ? value : undefined)
const stringOf = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** A page of `items` from the offset `token` names, of at most `limit`, with the token for the next if there is one. */
function paged<T>(items: T[], token: unknown, limit: number) {
  const from = token === undefined ? 0 : Number(token)
  if (!Number.isInteger(from) || from < 0) throw new AwsError('InvalidParameterException', 'The specified nextToken is invalid.')
  const page = items.slice(from, from + limit)
  return { page, ...(from + limit < items.length && { nextToken: String(from + limit) }) }
}

function limitOf(request: Request, most: number) {
  const limit = numberOf(request['limit']) ?? most
  if (limit < 1 || limit > most) throw new AwsError('InvalidParameterException', `limit must be between 1 and ${most}`)
  return limit
}

/**
 * The events of a stream from `startTime` (inclusive) up to `endTime`: exclusive, as GetLogEvents takes it, or
 * inclusive, as FilterLogEvents does.
 */
const eventsBetween = (events: TestLogEvent[], request: Request, { endInclusive = false } = {}) => {
  const start = numberOf(request['startTime']) ?? -Infinity
  const end = numberOf(request['endTime']) ?? Infinity
  return events.filter(({ timestamp }) => timestamp >= start && (endInclusive ? timestamp <= end : timestamp < end))
}

/** Starts a stand-in CloudWatch Logs endpoint holding `groups`; with `accessKeyId`, it turns away requests signed with any other. */
export async function startTestCloudWatchEndpoint(groups: TestLogGroup[], { accessKeyId }: { accessKeyId?: string } = {}): Promise<TestCloudWatchEndpoint> {
  const operations: string[] = []
  const calls: TestCloudWatchEndpoint['calls'] = []

  const groupNamed = (request: Request) => {
    const name = stringOf(request['logGroupName']) ?? stringOf(request['logGroupIdentifier'])
    const group = groups.find((g) => g.name === name)
    if (!group) throw new AwsError('ResourceNotFoundException', 'The specified log group does not exist.')
    return group
  }

  const streamNamed = (request: Request) => {
    const group = groupNamed(request)
    const stream = group.streams?.find((s) => s.name === request['logStreamName'])
    if (!stream) throw new AwsError('ResourceNotFoundException', 'The specified log stream does not exist.')
    return stream
  }

  const describeStream = (stream: TestLogStream) => {
    const events = stream.events ?? []
    const first = events[0]?.timestamp
    const last = events.at(-1)?.timestamp
    return {
      logStreamName: stream.name,
      creationTime: stream.createdAt ?? first ?? 0,
      ...(first !== undefined && { firstEventTimestamp: first, lastEventTimestamp: last, lastIngestionTime: last }),
      storedBytes: 0
    }
  }

  const handlers: Record<(typeof allowedCloudWatchOperations)[number], (request: Request) => unknown> = {
    DescribeLogGroups(request) {
      const prefix = stringOf(request['logGroupNamePrefix']) ?? ''
      const matching = groups.filter((g) => g.name.startsWith(prefix)).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const { page, nextToken } = paged(matching, request['nextToken'], limitOf(request, describeLimit))
      return {
        logGroups: page.map((g) => ({
          logGroupName: g.name,
          arn: `arn:aws:logs:us-east-1:123456789012:log-group:${g.name}:*`,
          creationTime: g.createdAt ?? 0,
          storedBytes: g.storedBytes ?? 0,
          ...(g.retentionDays !== undefined && { retentionInDays: g.retentionDays })
        })),
        ...(nextToken && { nextToken })
      }
    },

    DescribeLogStreams(request) {
      const group = groupNamed(request)
      const prefix = stringOf(request['logStreamNamePrefix'])
      const byLastEvent = request['orderBy'] === 'LastEventTime'
      if (byLastEvent && prefix !== undefined) {
        throw new AwsError('InvalidParameterException', 'Cannot order by LastEventTime with a logStreamNamePrefix.')
      }
      const described = (group.streams ?? []).filter((s) => s.name.startsWith(prefix ?? '')).map(describeStream)
      const key = (s: ReturnType<typeof describeStream>) => (byLastEvent ? (s.lastEventTimestamp ?? 0) : s.logStreamName)
      const sorted = described.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      if (request['descending'] === true) sorted.reverse()
      const { page, nextToken } = paged(sorted, request['nextToken'], limitOf(request, describeLimit))
      return { logStreams: page, ...(nextToken && { nextToken }) }
    },

    // Its tokens are `f/` or `b/` and an index into the events asked for: forward from it, or back from it. As AWS
    // does, it gives back the token it was given once there's nothing more that way.
    GetLogEvents(request) {
      const events = eventsBetween(streamNamed(request).events ?? [], request)
      const limit = limitOf(request, eventsLimit)
      const token = stringOf(request['nextToken'])
      let from: number
      let to: number
      if (token) {
        const [, direction, at] = /^([fb])\/(\d+)$/.exec(token) ?? []
        if (!direction) throw new AwsError('InvalidParameterException', 'The specified nextToken is invalid.')
        const index = Math.min(Number(at), events.length)
        ;[from, to] = direction === 'f' ? [index, Math.min(events.length, index + limit)] : [Math.max(0, index - limit), index]
      } else if (request['startFromHead'] === true) [from, to] = [0, Math.min(events.length, limit)]
      else [from, to] = [Math.max(0, events.length - limit), events.length]
      const page = events.slice(from, to)
      return {
        events: page.map(({ timestamp, message }) => ({ timestamp, message, ingestionTime: timestamp })),
        nextForwardToken: !page.length && token?.startsWith('f/') ? token : `f/${to}`,
        nextBackwardToken: !page.length && token?.startsWith('b/') ? token : `b/${from}`
      }
    },

    FilterLogEvents(request) {
      const group = groupNamed(request)
      const named = request['logStreamNames'] as string[] | undefined
      const streams = (group.streams ?? []).filter((s) => !named || named.includes(s.name))
      const events = streams
        // An event's id is its own, whatever is asked for.
        .flatMap((stream) =>
          eventsBetween(
            (stream.events ?? []).map((event, i) => ({ ...event, logStreamName: stream.name, eventId: `${stream.name}/${i}` })),
            request,
            { endInclusive: true }
          )
        )
        .toSorted((a, b) => a.timestamp - b.timestamp)
      const { page, nextToken } = paged(events, request['nextToken'], limitOf(request, eventsLimit))
      return { events: page.map((event) => ({ ...event, ingestionTime: event.timestamp })), ...(nextToken && { nextToken }) }
    }
  }

  const respond = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' })
    response.end(JSON.stringify(body))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const target = String(request.headers['x-amz-target'] ?? '')
    const operation = target.replace(/^Logs_20140328\./, '')
    operations.push(operation)
    calls.push({ operation, at: Date.now() })
    try {
      if (endpoint.throttling) throw new AwsError('ThrottlingException', 'Rate exceeded')
      const signedWith = /Credential=([^/]+)\//.exec(String(request.headers['authorization'] ?? ''))?.[1]
      if (accessKeyId !== undefined && signedWith !== accessKeyId) {
        throw new AwsError('UnrecognizedClientException', 'The security token included in the request is invalid.')
      }
      if ((endpoint.denied as Set<string>).has(operation)) {
        throw new AwsError(
          'AccessDeniedException',
          `User: arn:aws:iam::123456789012:user/reader is not authorized to perform: logs:${operation} because no identity-based policy allows the logs:${operation} action`
        )
      }
      const handler = handlers[operation as keyof typeof handlers] as ((request: Request) => unknown) | undefined
      if (!handler) throw new AwsError('UnknownOperationException', `Polyscope may not call ${operation || target}`)
      respond(response, 200, handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Request))
    } catch (error) {
      if (!(error instanceof AwsError)) throw error
      respond(response, error.status, { __type: error.type, message: error.message })
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: Error) => respond(response, 500, { __type: 'ServiceUnavailableException', message: error.message }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const endpoint: TestCloudWatchEndpoint = {
    url: `http://127.0.0.1:${port}`,
    operations,
    calls,
    groups,
    throttling: false,
    denied: new Set(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  return endpoint
}
