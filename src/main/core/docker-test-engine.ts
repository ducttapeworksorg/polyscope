// Test support: a stand-in for a Docker Engine in the test process, just enough of its HTTP API to list containers and
// read and follow their logs, on a Unix socket (a named pipe on Windows) that DOCKER_HOST can point at. It runs
// anywhere, with no engine; CI also runs the tests against a real one (see docker-test-seed.ts).

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One line a container logged: to stdout or stderr, at an RFC 3339 time with nanoseconds, as the engine keeps it. */
export interface TestLogEntry {
  stream: 'stdout' | 'stderr'
  time: string
  text: string
}

export interface TestContainer {
  name: string
  /** Its labels: Compose's `com.docker.compose.project` and `com.docker.compose.service` put it in a Compose project. */
  labels?: Record<string, string>
  /** Running unless given; an exited container's log can still be read. */
  state?: 'running' | 'exited'
  /** Whether it runs with a TTY, so its log comes as it was written, not multiplexed; off unless given. */
  tty?: boolean
  /** When its current run started; the first entry's time, or else now, unless given. */
  startedAt?: string
  logs?: TestLogEntry[]
}

export interface TestDockerEngine {
  /** What DOCKER_HOST is set to, to reach it: `unix://…`, or `npipe://…` on Windows. */
  host: string
  /** The engine's version, as `docker version` gives it. */
  version: string
  /** Adds a container. */
  add(container: TestContainer): void
  /** Has a container log a line now, sending it to whoever follows its log. */
  log(name: string, text: string, stream?: TestLogEntry['stream']): void
  /** Stops a running container, ending every Follow of its log. */
  stop(name: string): void
  close(): Promise<void>
}

const version = '27.3.1'
const apiVersion = '1.47'

/** An RFC 3339 time with nanoseconds, as the engine timestamps log lines. */
const nanoTime = (date: Date) => date.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')

/** A time in nanoseconds since the epoch, from an RFC 3339 time or a `since` query's `seconds[.nanoseconds]`. */
function nanosOf(time: string) {
  if (/^\d+(\.\d+)?$/.test(time)) {
    const [seconds, fraction = ''] = time.split('.')
    return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9))
  }
  const [whole, fraction = ''] = time.replace(/Z$/, '').split('.')
  return BigInt(Date.parse(`${whole}Z`)) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9))
}

/** A frame of a multiplexed log stream: its stream's id (1 stdout, 2 stderr) and length, then the payload. */
function frame(stream: TestLogEntry['stream'], payload: string) {
  const body = Buffer.from(payload)
  const header = Buffer.alloc(8)
  header[0] = stream === 'stdout' ? 1 : 2
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

export async function startTestDockerEngine(containers: TestContainer[] = []): Promise<TestDockerEngine> {
  interface Held extends Required<Omit<TestContainer, 'labels'>> {
    id: string
    labels: Record<string, string>
    followers: Set<{ send(entry: TestLogEntry): void; end(): void }>
  }
  const held: Held[] = []
  const add = (container: TestContainer) => {
    const logs = container.logs ?? []
    held.push({
      id: randomUUID().replaceAll('-', '').repeat(2),
      labels: {},
      state: 'running',
      tty: false,
      startedAt: logs[0]?.time ?? nanoTime(new Date()),
      logs,
      followers: new Set(),
      ...container
    })
  }
  containers.forEach(add)

  const named = (name: string) => {
    const container = held.find((c) => c.name === name)
    if (!container) throw new Error(`No test container ${name}`)
    return container
  }
  /** A container by its id, a prefix of it, or its name, as the engine finds them. */
  const find = (ref: string) => held.find((c) => c.name === ref || c.id.startsWith(ref))

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'api-version': apiVersion })
    response.end(JSON.stringify(body))
  }
  const noSuchContainer = (response: ServerResponse, ref: string) => json(response, 404, { message: `No such container: ${ref}` })

  const summary = (c: Held) => ({
    Id: c.id,
    Names: [`/${c.name}`],
    Image: 'busybox:1.36',
    Labels: c.labels,
    State: c.state,
    Status: c.state === 'running' ? 'Up 5 minutes' : 'Exited (0) 2 minutes ago'
  })

  const inspect = (c: Held) => ({
    Id: c.id,
    Name: `/${c.name}`,
    Config: { Image: 'busybox:1.36', Tty: c.tty, Labels: c.labels },
    State: { Status: c.state, Running: c.state === 'running', ExitCode: 0, StartedAt: c.startedAt, FinishedAt: '0001-01-01T00:00:00Z' }
  })

  const logs = (request: IncomingMessage, response: ServerResponse, c: Held, query: URLSearchParams) => {
    const timestamps = ['1', 'true'].includes(query.get('timestamps') ?? '')
    const follow = ['1', 'true'].includes(query.get('follow') ?? '') && c.state === 'running'
    const streams = new Set((['stdout', 'stderr'] as const).filter((s) => ['1', 'true'].includes(query.get(s) ?? '')))
    if (streams.size === 0) return json(response, 400, { message: 'Bad parameters: you must choose at least one stream' })
    const since = query.get('since')
    const tail = query.get('tail') ?? 'all'
    let entries = c.logs.filter((entry) => streams.has(entry.stream) && (!since || nanosOf(entry.time) >= nanosOf(since)))
    if (tail !== 'all') entries = Number(tail) > 0 ? entries.slice(-Number(tail)) : []
    response.writeHead(200, {
      'content-type': c.tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream',
      'api-version': apiVersion
    })
    // As the engine does, the headers go at once, before any line: a Follow is under way even with nothing to send yet.
    response.flushHeaders()
    const send = (entry: TestLogEntry) => {
      const payload = `${timestamps ? `${entry.time} ` : ''}${entry.text}\n`
      response.write(c.tty ? Buffer.from(payload) : frame(entry.stream, payload))
    }
    entries.forEach(send)
    if (!follow) return response.end()
    const follower = { send: (entry: TestLogEntry) => streams.has(entry.stream) && send(entry), end: () => response.end() }
    c.followers.add(follower)
    request.on('close', () => c.followers.delete(follower))
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://docker')
    // The engine serves every version's routes, and the unversioned ones as its own.
    const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, '')
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { message: 'read-only test engine' })
    if (path === '/_ping') {
      response.writeHead(200, { 'content-type': 'text/plain', 'api-version': apiVersion })
      return response.end('OK')
    }
    if (path === '/version') {
      return json(response, 200, {
        Platform: { Name: 'Docker Engine - Community' },
        Components: [{ Name: 'Engine', Version: version }],
        Version: version,
        ApiVersion: apiVersion,
        MinAPIVersion: '1.24',
        Os: 'linux',
        Arch: 'amd64'
      })
    }
    if (path === '/containers/json') {
      const all = ['1', 'true'].includes(url.searchParams.get('all') ?? '')
      return json(response, 200, held.filter((c) => all || c.state === 'running').map(summary))
    }
    const match = /^\/containers\/([^/]+)\/(json|logs)$/.exec(path)
    if (!match) return json(response, 404, { message: 'page not found' })
    const ref = decodeURIComponent(match[1]!)
    const container = find(ref)
    if (!container) return noSuchContainer(response, ref)
    return match[2] === 'json' ? json(response, 200, inspect(container)) : logs(request, response, container, url.searchParams)
  })

  const windows = process.platform === 'win32'
  const socket = windows ? `\\\\.\\pipe\\polyscope-test-docker-${randomUUID()}` : join(tmpdir(), `polyscope-docker-${randomUUID()}.sock`)
  await new Promise<void>((resolve) => server.listen(socket, resolve))

  return {
    host: windows ? `npipe://${socket.replaceAll('\\', '/')}` : `unix://${socket}`,
    version,
    add,
    log(name, text, stream = 'stdout') {
      const entry = { stream, time: nanoTime(new Date()), text }
      const container = named(name)
      container.logs.push(entry)
      for (const follower of container.followers) follower.send(entry)
    },
    stop(name) {
      const container = named(name)
      container.state = 'exited'
      for (const follower of container.followers) follower.end()
      container.followers.clear()
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      if (!windows) await rm(socket, { force: true })
    }
  }
}
