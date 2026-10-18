import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { getCACertificates } from 'node:tls'
import type { LogGroupNode, LogNode, LogStreamNode, SourcePath } from '@shared/core-api'
import { dockerStandaloneGroup as standalone } from '@shared/core-api'
import { containerDetailsOf, containerRunOf, containerStatusOf, engineMillis, type ContainerInspect } from './container-status'
import { CoreError } from './core-error'
import { describeEndpoint, type DockerEndpoint } from './docker-contexts'
import type { DockerDialer } from './docker-ssh'
import type { LogConnection, LogFollowOptions, LogReadOptions, LogSource, LogStreamInfo } from './log-source'
import { certificateCodes } from './network-errors'

/** The newest Engine API version Polyscope speaks; an older engine is spoken to in its own. */
const newestApiVersion = '1.47'

/** Log drivers whose logs the engine reads back itself. */
const readableDrivers = new Set(['json-file', 'local', 'journald'])

const composeProject = 'com.docker.compose.project'
const composeService = 'com.docker.compose.service'

/** A Compose project's or service's name, as one path segment: a label that isn't one leaves its container standalone. */
const isSegment = (name: string | undefined): name is string => name !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)

/** A failure to reach the engine at all, by the code Node gives, as a CoreError. */
function reachError(error: NodeJS.ErrnoException, endpoint: DockerEndpoint): CoreError {
  // Already told, as a connection dialled over SSH tells why it ended.
  if (error instanceof CoreError) return error
  const where = describeEndpoint(endpoint)
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    const group = process.platform === 'linux' ? ': add your user to the docker group, then sign in again' : ''
    if (!('socketPath' in endpoint)) return new CoreError('PERMISSION_DENIED', `Not allowed to reach ${where}: ${error.message}`)
    return new CoreError('PERMISSION_DENIED', `Not allowed to use the Docker socket ${where}${group}`)
  }
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return new CoreError('UNREACHABLE', `Docker isn’t running, or isn’t listening at ${where}`)
  }
  if (error.code && certificateCodes.has(error.code)) return new CoreError('CERTIFICATE_UNTRUSTED', `${where}: ${error.message}`)
  // The engine ended the TLS handshake, as one run with --tlsverify does for a client with no certificate it trusts.
  if (error.code?.startsWith('ERR_SSL_')) {
    return new CoreError('UNREACHABLE', `${where} refused the TLS connection, maybe for want of a client certificate it trusts: ${error.message}`)
  }
  return new CoreError('UNREACHABLE', `${where}: ${error.message}`)
}

/** What a TLS connection trusts when it names no CA: the OS's CAs and Node's, as the CLI trusts the OS's. */
const defaultCas = () => [...new Set([...getCACertificates('default'), ...getCACertificates('system')])]

/**
 * How an engine is reached: where it is, and for one on a host reached over SSH, how connections to it are dialled. Its
 * short requests share a few connections kept open, as dialling one runs a command on the host; a Follow has its own.
 */
interface Engine {
  endpoint: DockerEndpoint
  dialed?: { dial: DockerDialer; agent: Agent }
}

/** How many connections an engine reached over SSH keeps for short requests: OpenSSH lets a connection run 10 commands at once. */
const dialedConnections = 4

/** Has an HTTP request go over a connection `dial` opens. */
const dialing = (dial: DockerDialer) => (_options: unknown, done: (error: Error | null, stream?: Duplex) => void) =>
  void dial().then((stream) => done(null, stream), (error: Error) => done(error))

/** An engine at `endpoint`; reached over connections `dial` opens, if given. */
function engineAt(endpoint: DockerEndpoint, dial?: DockerDialer): Engine {
  if (!dial) return { endpoint }
  const agent = new Agent({ keepAlive: true, maxSockets: dialedConnections })
  Object.assign(agent, { createConnection: dialing(dial) })
  return { endpoint, dialed: { dial, agent } }
}

/**
 * Starts a GET of `path` from the engine: over its socket, over TCP, with TLS if it's set up for it, or over a
 * connection dialled to it; one that goes on for long (`streaming`, a Follow) over a connection of its own.
 */
function requestTo({ endpoint, dialed }: Engine, path: string, streaming: boolean, onResponse: (response: IncomingMessage) => void): ClientRequest {
  if (dialed) {
    const via = streaming ? { createConnection: dialing(dialed.dial) } : { agent: dialed.agent }
    return httpRequest({ ...via, path, method: 'GET', headers: { host: 'docker' } } as never, onResponse)
  }
  if ('ssh' in endpoint) throw new CoreError('UNSUPPORTED_DOCKER_HOST', describeEndpoint(endpoint))
  if ('socketPath' in endpoint) return httpRequest({ socketPath: endpoint.socketPath, path, method: 'GET', headers: { host: 'docker' } }, onResponse)
  const { host, port, tls } = endpoint
  if (!tls) return httpRequest({ host, port, path, method: 'GET' }, onResponse)
  const { ca, cert, key, verify } = tls
  return httpsRequest({ host, port, path, method: 'GET', ca: ca ?? defaultCas(), cert, key, rejectUnauthorized: verify }, onResponse)
}

/** The whole body of a response. */
async function bodyOf(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** What the engine says went wrong, from its error body, `{ "message": … }`. */
const messageOf = (body: Buffer) => {
  try {
    return String((JSON.parse(body.toString('utf8')) as { message?: unknown }).message ?? '')
  } catch {
    return body.toString('utf8').trim()
  }
}

/** Sends a GET to the engine, resolving with its response once it answers 2xx, or else failing with a CoreError. */
function get(
  engine: Engine,
  path: string,
  query: Record<string, string> = {},
  { streaming = false } = {}
): Promise<{ response: IncomingMessage; stop(): void }> {
  const { endpoint } = engine
  const search = new URLSearchParams(query).toString()
  return new Promise((resolve, reject) => {
    const request = requestTo(engine, `${path}${search ? `?${search}` : ''}`, streaming, (response) => {
      const status = response.statusCode ?? 500
      if (status >= 200 && status < 300) return resolve({ response, stop: () => request.destroy() })
      void bodyOf(response).then(
        (body) => {
          const message = messageOf(body) || `HTTP ${status}`
          // 501, from the logs endpoint: the container's log driver sends its log elsewhere.
          reject(new CoreError(status === 404 ? 'NOT_FOUND' : status === 501 ? 'LOG_UNAVAILABLE' : 'UNKNOWN', message))
        },
        (error: Error) => reject(reachError(error, endpoint))
      )
    })
    request.on('error', (error) => reject(reachError(error, endpoint)))
    request.end()
  })
}

async function getJson<T>(engine: Engine, path: string, query?: Record<string, string>): Promise<T> {
  const { response } = await get(engine, path, query)
  return JSON.parse((await bodyOf(response)).toString('utf8')) as T
}

/** The parts of the engine's answers Polyscope reads. */
interface EngineVersion {
  Version?: string
  ApiVersion?: string
  Components?: { Name?: string; Version?: string }[]
}
interface ContainerSummary {
  Id: string
  Names?: string[]
  Labels?: Record<string, string> | null
}

/** The older of two Engine API versions, like `1.45`. */
const olderApiVersion = (a: string, b: string) => {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number)
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number)
  return aMajor < bMajor || (aMajor === bMajor && aMinor < bMinor) ? a : b
}

/** What an engine says it is: `Docker Engine 27.3.1`, or another's own name for itself, like `Podman Engine 5.2.0`. */
function describeEngine({ Version, Components }: EngineVersion) {
  const engine = Components?.find((component) => component.Name?.endsWith('Engine'))
  const name = !engine?.Name || engine.Name === 'Engine' ? 'Docker Engine' : engine.Name
  return `${name} ${engine?.Version ?? Version ?? ''}`.trim()
}

/** An RFC 3339 time as the logs endpoint's `since` takes it: seconds since the epoch, then its fraction of a second. */
function sinceOf(time: string) {
  const [whole, fraction = ''] = time.replace(/Z$/, '').split('.')
  const seconds = Date.parse(`${whole}Z`) / 1000
  if (!Number.isFinite(seconds)) throw new CoreError('UNKNOWN', `Not an RFC 3339 time: ${time}`)
  return `${seconds}.${fraction.padEnd(9, '0').slice(0, 9)}`
}

/** An RFC 3339 time as nanoseconds since the epoch, to compare. */
const nanosOf = (time: string) => {
  const [seconds, fraction] = sinceOf(time).split('.')
  return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction!)
}

/**
 * Where a Follow of a container's current run starts: when the run started, to the second, as its first lines may come
 * before the engine notes it started; but not before the last run ended, whose lines would come again. Its whole log
 * if it never started.
 */
function runStartOf({ State: state = {} }: ContainerInspect): string | undefined {
  if (engineMillis(state.StartedAt) === undefined) return undefined
  const started = state.StartedAt!
  const second = started.replace(/\.\d+/, '')
  const ended = state.FinishedAt
  const endedBetween = engineMillis(ended) !== undefined && nanosOf(ended!) > nanosOf(second) && nanosOf(ended!) <= nanosOf(started)
  return endedBetween ? ended : second
}

/**
 * Turns a log stream's bytes into text, as they arrive. A container without a TTY has its stdout and stderr multiplexed
 * into frames, each an 8-byte header (the stream's id, then the payload's length) and its payload: they're taken apart
 * and their payloads given in the order they came. A TTY's output comes as it was written. Stops with `full` once
 * `limitBytes` of payload have been given.
 */
function logDecoder(tty: boolean, onText: (text: string) => void, limitBytes = Infinity) {
  const decoders = new Map<number, TextDecoder>()
  let pending: Buffer = Buffer.alloc(0)
  let given = 0
  const give = (stream: number, payload: Buffer) => {
    const part = payload.subarray(0, Math.max(0, limitBytes - given))
    given += part.length
    let decoder = decoders.get(stream)
    if (!decoder) decoders.set(stream, (decoder = new TextDecoder()))
    const text = decoder.decode(part, { stream: true })
    if (text) onText(text)
  }
  return {
    push(chunk: Buffer) {
      if (tty) return give(0, chunk)
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= 8 && given < limitBytes) {
        const length = pending.readUInt32BE(4)
        if (pending.length < 8 + length) break
        give(pending[0]!, pending.subarray(8, 8 + length))
        pending = pending.subarray(8 + length)
      }
    },
    get full() {
      return given >= limitBytes
    }
  }
}

/** The tree of an engine's containers: each node by its path, with its children; the root's is ''. */
type Tree = Map<SourcePath, { node?: LogNode; children: LogNode[]; id?: string }>

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** A container's name, without the `/` the engine puts before it. */
const nameOf = (container: ContainerSummary) => (container.Names?.[0] ?? '').replace(/^\//, '')

/** Folds a group's only child into it, unless it never folds; marks a group with no children empty. */
function folding(group: LogGroupNode, children: LogNode[]): LogGroupNode {
  if (group.unfoldable) return group
  if (children.length === 0) return { ...group, empty: true }
  return children.length === 1 ? { ...group, folded: children[0]! } : group
}

/** Lays an engine's containers out as a tree: Compose project, then service, then container; the rest under Standalone. */
function treeOf(containers: ContainerSummary[]): Tree {
  const tree: Tree = new Map()
  const projects = new Map<string, Map<string, ContainerSummary[]>>()
  const standalones: ContainerSummary[] = []
  for (const container of containers.filter((c) => isSegment(nameOf(c)))) {
    const project = container.Labels?.[composeProject]
    const service = container.Labels?.[composeService]
    if (!isSegment(project) || !isSegment(service)) {
      standalones.push(container)
      continue
    }
    const services = projects.get(project) ?? new Map<string, ContainerSummary[]>()
    projects.set(project, services)
    services.set(service, [...(services.get(service) ?? []), container])
  }

  const containerNodes = (parent: SourcePath, members: ContainerSummary[]) =>
    members
      .toSorted((a, b) => byName.compare(nameOf(a), nameOf(b)))
      .map((container): LogStreamNode => {
        const name = nameOf(container)
        const node: LogStreamNode = { kind: 'logStream', name, path: `${parent}/${name}`, docker: { kind: 'container' } }
        tree.set(node.path, { node, children: [], id: container.Id })
        return node
      })

  const roots: LogNode[] = []
  for (const project of [...projects.keys()].toSorted(byName.compare)) {
    const services = projects.get(project)!
    const serviceNodes = [...services.keys()].toSorted(byName.compare).map((service) => {
      const path = `${project}/${service}`
      const children = containerNodes(path, services.get(service)!)
      const node = folding({ kind: 'group', name: service, path, docker: { kind: 'service' } }, children)
      tree.set(path, { node, children })
      return node
    })
    const node = folding({ kind: 'group', name: project, path: project, docker: { kind: 'project' } }, serviceNodes)
    tree.set(project, { node, children: serviceNodes })
    roots.push(node)
  }
  if (standalones.length > 0) {
    const node: LogGroupNode = { kind: 'group', name: standalone, path: standalone, unfoldable: true, docker: { kind: 'standalone' } }
    tree.set(standalone, { node, children: containerNodes(standalone, standalones) })
    roots.push(node)
  }
  tree.set('', { children: roots })
  return tree
}

/** A container's node with what inspecting it tells: its Container Status, its restarts once it has restarted, and its details. */
function inspectedNode(node: LogStreamNode, container: ContainerInspect): LogStreamNode {
  const status = containerStatusOf(container)
  return { ...node, ...(status.restarts > 0 && { restarts: status.restarts }), status, docker: containerDetailsOf(container) }
}

/**
 * A Docker Engine's containers, running and stopped, as a Log Source whose Log Streams are containers. Paths name a
 * Compose project, its service, then the container, e.g. `shop/web/shop-web-1`; containers outside Compose are under
 * `_standalone`. A project with one service and a service with one container carry it folded in, paths keeping every
 * level. Containers tell their Container Status and restarts, and a Follow carries on across restarts; Docker keeps
 * every run of a container in one log, so it has no Previous Log. Its logs can be read from a time on (Since).
 */
function createDockerLogSource(engine: Engine, apiVersion: string): LogSource {
  const api = (path: string) => `/v${apiVersion}${path}`

  const tree = async () => treeOf(await getJson<ContainerSummary[]>(engine, api('/containers/json'), { all: 'true' }))

  const inspect = (ref: string) => getJson<ContainerInspect>(engine, api(`/containers/${encodeURIComponent(ref)}/json`))

  /** Listed nodes as they're shown: each container, and each folded into a row, inspected for how it's doing. */
  const withStatuses = (nodes: LogNode[], containers: Tree): Promise<LogNode[]> =>
    Promise.all(
      nodes.map(async (node): Promise<LogNode> => {
        if (node.kind === 'group') return node.folded ? { ...node, folded: (await withStatuses([node.folded], containers))[0]! } : node
        const id = containers.get(node.path)?.id
        if (!id) return node
        try {
          return inspectedNode(node, await inspect(id))
        } catch (error) {
          // Removed since it was listed: it's shown as listed, and gone once listed again.
          if (error instanceof CoreError && error.code === 'NOT_FOUND') return node
          throw error
        }
      })
    )

  /** The container at a Log Stream's path: its id, and whether it runs with a TTY. */
  const containerAt = async (path: SourcePath) => {
    const entry = (await tree()).get(path)
    if (!entry) throw new CoreError('NOT_FOUND', `No container at ${path}`)
    if (entry.node?.kind !== 'logStream' || !entry.id) throw new CoreError('NOT_A_LOG_STREAM', `Only containers have logs: ${path}`)
    const inspected = await inspect(entry.id)
    return { id: entry.id, name: entry.node.name, tty: inspected.Config?.Tty ?? false, inspected }
  }

  /** Asks for a container's log, failing with LOG_UNAVAILABLE, naming the log driver, when the engine can't read it back. */
  const logsOf = async ({ id, inspected }: { id: string; inspected: ContainerInspect }, query: Record<string, string>) => {
    try {
      return await get(engine, api(`/containers/${id}/logs`), { stdout: 'true', stderr: 'true', ...query }, { streaming: query['follow'] === 'true' })
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== 'LOG_UNAVAILABLE') throw error
      const driver = inspected.HostConfig?.LogConfig?.Type ?? 'unknown'
      throw new CoreError('LOG_UNAVAILABLE', `its log driver, ${driver}, sends it where Docker can’t read it back`)
    }
  }

  return {
    capabilities: { previousLog: false, restarts: true, status: true, since: true },

    async listChildren(path) {
      const containers = await tree()
      const entry = containers.get(path)
      if (!entry) throw new CoreError('NOT_FOUND', `Nothing at ${path} in the engine`)
      if (entry.node?.kind === 'logStream') throw new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`)
      return withStatuses(entry.children, containers)
    },

    async logStreamAt(path): Promise<LogStreamInfo> {
      const container = await containerAt(path)
      // Other drivers' logs the engine keeps a copy of to read back, unless that's turned off: only asking tells.
      if (readableDrivers.has(container.inspected.HostConfig?.LogConfig?.Type ?? 'json-file')) return { name: container.name }
      try {
        ;(await logsOf(container, { tail: '0' })).stop()
        return { name: container.name }
      } catch (error) {
        if (!(error instanceof CoreError) || error.code !== 'LOG_UNAVAILABLE') throw error
        return { name: container.name, unreadable: error.message }
      }
    },

    async readLog(path, { tailLines, limitBytes, timestamps = false, sinceTime }: LogReadOptions = {}) {
      const container = await containerAt(path)
      const tail = tailLines === undefined ? 'all' : String(tailLines)
      // The engine takes the last lines, then those of them since the time: the last lines of those since it, either way.
      const { response, stop } = await logsOf(container, { tail, timestamps: String(timestamps), ...(sinceTime && { since: sinceOf(sinceTime) }) })
      let text = ''
      const decoder = logDecoder(container.tty, (piece) => (text += piece), limitBytes)
      for await (const chunk of response) {
        decoder.push(chunk as Buffer)
        if (!decoder.full) continue
        stop()
        break
      }
      return text
    },

    async followLog(path, { sinceTime }: LogFollowOptions, onText): Promise<LogConnection> {
      const container = await containerAt(path)
      const { tty, inspected } = container
      // Between runs, its log is all the last run's: there's nothing to follow until the next starts.
      if (inspected.State?.Status === 'restarting') throw new CoreError('LOG_UNAVAILABLE', `Waiting for the engine to restart ${path}`)
      const since = sinceTime ?? runStartOf(inspected)
      const { response, stop } = await logsOf(container, { follow: 'true', timestamps: 'true', ...(since && { since: sinceOf(since) }) })
      const decoder = logDecoder(tty, onText)
      const ended = new Promise<void>((done, fail) => {
        response.on('data', (chunk: Buffer) => decoder.push(chunk))
        response.on('end', done)
        response.on('error', (error) => fail(reachError(error, engine.endpoint)))
        // Closed before its end: the engine went away, or the stream was stopped.
        response.on('close', () => fail(new CoreError('UNREACHABLE', 'The log stream was cut off')))
      })
      // Settled whether or not anyone is still waiting on it, say after stopping.
      ended.catch(() => undefined)
      return { ended, stop }
    },

    /** Inspects the container by its name, the path's last segment, trusting the path. */
    async currentRun(path) {
      return containerRunOf(await inspect(path.slice(path.lastIndexOf('/') + 1)))
    }
  }
}

/**
 * Reaches a Docker Engine, agreeing on the API version to speak: a Log Source over it, and what the engine says it is.
 * An `ssh://` one is reached over connections `dial` opens to it; UNSUPPORTED_DOCKER_HOST without.
 */
export async function connectDockerEngine(endpoint: DockerEndpoint, dial?: DockerDialer): Promise<{ logSource: LogSource; version: string }> {
  const engine = engineAt(endpoint, dial)
  const version = await getJson<EngineVersion>(engine, '/version')
  const apiVersion = olderApiVersion(version.ApiVersion ?? newestApiVersion, newestApiVersion)
  return { logSource: createDockerLogSource(engine, apiVersion), version: describeEngine(version) }
}
