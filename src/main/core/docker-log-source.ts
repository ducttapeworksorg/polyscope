import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { LogGroupNode, LogNode, LogStreamNode, SourcePath } from '@shared/core-api'
import { defaultDockerContext, dockerStandaloneGroup as standalone } from '@shared/core-api'
import { CoreError } from './core-error'
import type { LogConnection, LogFollowOptions, LogReadOptions, LogSource, LogStreamInfo } from './log-source'

/** Where a Docker Engine's API is served: a Unix socket, or a named pipe on Windows. */
export interface DockerEndpoint {
  socketPath: string
}

/** The newest Engine API version Polyscope speaks; an older engine is spoken to in its own. */
const newestApiVersion = '1.47'

const composeProject = 'com.docker.compose.project'
const composeService = 'com.docker.compose.service'

/** A Compose project's or service's name, as one path segment: a label that isn't one leaves its container standalone. */
const isSegment = (name: string | undefined): name is string => name !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)

/**
 * The engine a Docker context reaches. The default context is DOCKER_HOST's engine, as the Docker CLI's is, or else
 * the local one: its Unix socket, or its named pipe on Windows. Only engines on this computer are reached so far.
 */
export function dockerEndpointOf(context: string, env: NodeJS.ProcessEnv = process.env): DockerEndpoint {
  if (context !== defaultDockerContext) throw new CoreError('CONTEXT_NOT_FOUND', `Only the default Docker context can be used so far, not ${context}`)
  const host = env['DOCKER_HOST']?.trim()
  if (!host) return { socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock' }
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) }
  // npipe:////./pipe/docker_engine, as the Docker CLI writes it, is the pipe \\.\pipe\docker_engine.
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length).replaceAll('/', '\\').replace(/^\\*/, '\\\\') }
  throw new CoreError('UNSUPPORTED_DOCKER_HOST', host)
}

/** A failure to reach the engine at all, by the code Node gives, as a CoreError. */
function reachError(error: NodeJS.ErrnoException, { socketPath }: DockerEndpoint): CoreError {
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    const group = process.platform === 'linux' ? ': add your user to the docker group, then sign in again' : ''
    return new CoreError('PERMISSION_DENIED', `Not allowed to use the Docker socket ${socketPath}${group}`)
  }
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return new CoreError('UNREACHABLE', `Docker isn’t running, or isn’t listening at ${socketPath}`)
  }
  return new CoreError('UNREACHABLE', error.message)
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
function get(endpoint: DockerEndpoint, path: string, query: Record<string, string> = {}): Promise<{ response: IncomingMessage; stop(): void }> {
  const search = new URLSearchParams(query).toString()
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: endpoint.socketPath, path: `${path}${search ? `?${search}` : ''}`, method: 'GET', headers: { host: 'docker' } }, (response) => {
      const status = response.statusCode ?? 500
      if (status >= 200 && status < 300) return resolve({ response, stop: () => request.destroy() })
      void bodyOf(response).then(
        (body) => {
          const message = messageOf(body) || `HTTP ${status}`
          reject(new CoreError(status === 404 ? 'NOT_FOUND' : 'UNKNOWN', message))
        },
        (error: Error) => reject(reachError(error, endpoint))
      )
    })
    request.on('error', (error) => reject(reachError(error, endpoint)))
    request.end()
  })
}

async function getJson<T>(endpoint: DockerEndpoint, path: string, query?: Record<string, string>): Promise<T> {
  const { response } = await get(endpoint, path, query)
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
interface ContainerInspect {
  Config?: { Tty?: boolean }
  State?: { StartedAt?: string }
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

/**
 * A Docker Engine's containers, running and stopped, as a Log Source whose Log Streams are containers. Paths name a
 * Compose project, its service, then the container, e.g. `shop/web/shop-web-1`; containers outside Compose are under
 * `_standalone`. A project with one service and a service with one container carry it folded in, paths keeping every
 * level. It has no capabilities yet: Docker keeps every run of a container in one log, so has no Previous Log.
 */
function createDockerLogSource(endpoint: DockerEndpoint, apiVersion: string): LogSource {
  const api = (path: string) => `/v${apiVersion}${path}`

  const tree = async () => treeOf(await getJson<ContainerSummary[]>(endpoint, api('/containers/json'), { all: 'true' }))

  /** The container at a Log Stream's path: its id, and whether it runs with a TTY. */
  const containerAt = async (path: SourcePath) => {
    const entry = (await tree()).get(path)
    if (!entry) throw new CoreError('NOT_FOUND', `No container at ${path}`)
    if (entry.node?.kind !== 'logStream' || !entry.id) throw new CoreError('NOT_A_LOG_STREAM', `Only containers have logs: ${path}`)
    const inspected = await getJson<ContainerInspect>(endpoint, api(`/containers/${entry.id}/json`))
    return { id: entry.id, name: entry.node.name, tty: inspected.Config?.Tty ?? false, startedAt: inspected.State?.StartedAt }
  }

  const logsOf = (id: string, query: Record<string, string>) =>
    get(endpoint, api(`/containers/${id}/logs`), { stdout: 'true', stderr: 'true', ...query })

  return {
    capabilities: { previousLog: false, restarts: false, status: false },

    async listChildren(path) {
      const entry = (await tree()).get(path)
      if (!entry) throw new CoreError('NOT_FOUND', `Nothing at ${path} in the engine`)
      if (entry.node?.kind === 'logStream') throw new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`)
      return entry.children
    },

    async logStreamAt(path): Promise<LogStreamInfo> {
      return { name: (await containerAt(path)).name }
    },

    async readLog(path, { tailLines, limitBytes, timestamps = false }: LogReadOptions = {}) {
      const { id, tty } = await containerAt(path)
      const { response, stop } = await logsOf(id, { tail: tailLines === undefined ? 'all' : String(tailLines), timestamps: String(timestamps) })
      let text = ''
      const decoder = logDecoder(tty, (piece) => (text += piece), limitBytes)
      for await (const chunk of response) {
        decoder.push(chunk as Buffer)
        if (!decoder.full) continue
        stop()
        break
      }
      return text
    },

    async followLog(path, { sinceTime }: LogFollowOptions, onText): Promise<LogConnection> {
      const { id, tty, startedAt } = await containerAt(path)
      // From the start of the current run, to the second: a container's first lines may come before the engine notes it started.
      // A container that never started has the zero time for StartedAt: its whole log, then.
      const since = sinceTime ?? (startedAt?.startsWith('0001-') ? undefined : startedAt?.replace(/\.\d+/, ''))
      const { response, stop } = await logsOf(id, { follow: 'true', timestamps: 'true', ...(since && { since: sinceOf(since) }) })
      const decoder = logDecoder(tty, onText)
      const ended = new Promise<void>((done, fail) => {
        response.on('data', (chunk: Buffer) => decoder.push(chunk))
        response.on('end', done)
        response.on('error', (error) => fail(reachError(error, endpoint)))
        // Closed before its end: the engine went away, or the stream was stopped.
        response.on('close', () => fail(new CoreError('UNREACHABLE', 'The log stream was cut off')))
      })
      // Settled whether or not anyone is still waiting on it, say after stopping.
      ended.catch(() => undefined)
      return { ended, stop }
    }
  }
}

/** Reaches a Docker Engine, agreeing on the API version to speak: a Log Source over it, and what the engine says it is. */
export async function connectDockerEngine(endpoint: DockerEndpoint): Promise<{ logSource: LogSource; version: string }> {
  const engine = await getJson<EngineVersion>(endpoint, '/version')
  const apiVersion = olderApiVersion(engine.ApiVersion ?? newestApiVersion, newestApiVersion)
  return { logSource: createDockerLogSource(endpoint, apiVersion), version: describeEngine(engine) }
}
