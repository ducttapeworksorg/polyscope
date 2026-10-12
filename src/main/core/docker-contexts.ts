import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultDockerContext, type DockerContext } from '@shared/core-api'
import { CoreError } from './core-error'

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The Docker CLI's config folder: DOCKER_CONFIG, or else ~/.docker. */
export const dockerConfigDir = (env: NodeJS.ProcessEnv) => env['DOCKER_CONFIG']?.trim() || join(homedir(), '.docker')

/** A file's text; undefined if it isn't there. */
async function textOf(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** What the CLI keeps about a context, in `contexts/meta/<its name's SHA-256>/meta.json`. */
interface ContextMeta {
  Name?: string
  Endpoints?: { docker?: { Host?: string; SkipTLSVerify?: boolean } }
}

/** The contexts in the CLI's config folder, each with the folder it's kept in; those that can't be read are left out. */
async function readContexts(configDir: string) {
  const metaDir = join(configDir, 'contexts', 'meta')
  let ids: string[]
  try {
    ids = await readdir(metaDir)
  } catch {
    return []
  }
  const contexts = await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = JSON.parse((await textOf(join(metaDir, id, 'meta.json'))) ?? 'null') as ContextMeta | null
        const endpoint = meta?.Endpoints?.docker
        if (!meta?.Name || !endpoint?.Host) return undefined
        return { id, name: meta.Name, host: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify === true }
      } catch {
        return undefined
      }
    })
  )
  return contexts.filter((context) => context !== undefined)
}

/** The context the CLI uses when told none: DOCKER_CONTEXT, or else its config's current context; `default` if neither. */
async function currentContextOf(configDir: string, env: NodeJS.ProcessEnv) {
  const named = env['DOCKER_CONTEXT']?.trim()
  if (named) return named
  try {
    const config = JSON.parse((await textOf(join(configDir, 'config.json'))) ?? '{}') as { currentContext?: unknown }
    return typeof config.currentContext === 'string' && config.currentContext ? config.currentContext : 'default'
  } catch {
    return 'default'
  }
}

/** The contexts the Docker CLI knows, by name, marking the one it uses when told none (DOCKER_HOST aside). */
export async function listDockerContexts(env: NodeJS.ProcessEnv = process.env): Promise<DockerContext[]> {
  const configDir = dockerConfigDir(env)
  const current = await currentContextOf(configDir, env)
  return (await readContexts(configDir))
    .map(({ name, host }) => ({ name, host, current: name === current }))
    .sort((a, b) => byName.compare(a.name, b.name))
}

/** How an engine is reached over TLS: the CA to trust (else the OS's and Node's), and the client's certificate and key, as PEM. */
export interface DockerTls {
  ca?: string
  cert?: string
  key?: string
  /** Whether the engine's certificate is checked; a context may skip that. */
  verify: boolean
}

/** Where a Docker Engine's API is served: a Unix socket, a named pipe on Windows, or a TCP port, maybe over TLS. */
export type DockerEndpoint = { socketPath: string } | { host: string; port: number; tls?: DockerTls }

/** How a Docker endpoint is named in messages: its socket, or its `tcp://` address. */
export const describeEndpoint = (endpoint: DockerEndpoint) =>
  'socketPath' in endpoint ? endpoint.socketPath : `tcp://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`

/** The TLS material in a folder, as `ca.pem`, `cert.pem` and `key.pem`; those that aren't there are left out. */
async function tlsFilesIn(dir: string) {
  const [ca, cert, key] = await Promise.all(['ca', 'cert', 'key'].map((name) => textOf(join(dir, `${name}.pem`))))
  return { ...(ca && { ca }), ...(cert && { cert }), ...(key && { key }) }
}

/** The engine a `unix://`, `npipe://` or `tcp://` host names, as DOCKER_HOST or a context's endpoint gives it. */
function endpointAt(host: string, tls?: DockerTls): DockerEndpoint {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) }
  // npipe:////./pipe/docker_engine, as the Docker CLI writes it, is the pipe \\.\pipe\docker_engine.
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length).replaceAll('/', '\\').replace(/^\\*/, '\\\\') }
  if (host.startsWith('tcp://')) {
    let url: URL
    try {
      url = new URL(host)
    } catch {
      throw new CoreError('UNSUPPORTED_DOCKER_HOST', host)
    }
    // As the CLI does: the engine's TLS port unless one is given, or its plain one without TLS.
    const port = url.port ? Number(url.port) : tls ? 2376 : 2375
    return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port, ...(tls && { tls }) }
  }
  throw new CoreError('UNSUPPORTED_DOCKER_HOST', host)
}

/** The local engine: its Unix socket, or its named pipe on Windows. */
const localEndpoint = (): DockerEndpoint => ({ socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock' })

/**
 * DOCKER_HOST's engine, over TLS when DOCKER_TLS_VERIFY (checking its certificate) or DOCKER_TLS is set, as the CLI
 * reaches it: with the CA, certificate and key in DOCKER_CERT_PATH, or else the config folder.
 */
async function hostEndpoint(host: string, configDir: string, env: NodeJS.ProcessEnv) {
  const verify = Boolean(env['DOCKER_TLS_VERIFY']?.trim())
  if (!verify && !env['DOCKER_TLS']?.trim()) return endpointAt(host)
  const certPath = env['DOCKER_CERT_PATH']?.trim() || configDir
  const files = await tlsFilesIn(certPath)
  // The CLI won't check the engine's certificate against nothing.
  if (verify && !files.ca) throw new CoreError('CA_BUNDLE_UNREADABLE', `DOCKER_TLS_VERIFY is set, but there's no ${join(certPath, 'ca.pem')}`)
  return endpointAt(host, { ...files, verify })
}

/**
 * The engine a Docker Logs Source's context reaches. Its default is the engine the Docker CLI reaches when told none:
 * DOCKER_HOST's, or else DOCKER_CONTEXT's context, or else the CLI's current one, or else the local engine. A context
 * named `default` is the CLI's own: DOCKER_HOST's engine or the local one. A context's TLS material is kept beside it,
 * in `contexts/tls/<its id>/docker`; it's reached over TLS if it has any, or skips checking the engine's certificate.
 */
export async function dockerEndpointOf(context: string, env: NodeJS.ProcessEnv = process.env): Promise<DockerEndpoint> {
  const host = env['DOCKER_HOST']?.trim()
  const configDir = dockerConfigDir(env)
  const name = context === defaultDockerContext && !host ? await currentContextOf(configDir, env) : context
  if (name === defaultDockerContext) return host ? hostEndpoint(host, configDir, env) : localEndpoint()
  const found = (await readContexts(configDir)).find((c) => c.name === name)
  if (!found) throw new CoreError('CONTEXT_NOT_FOUND', `No Docker context named ${name} in ${configDir}`)
  const files = await tlsFilesIn(join(configDir, 'contexts', 'tls', found.id, 'docker'))
  const { skipTlsVerify } = found
  return endpointAt(found.host, Object.keys(files).length > 0 || skipTlsVerify ? { ...files, verify: !skipTlsVerify } : undefined)
}
