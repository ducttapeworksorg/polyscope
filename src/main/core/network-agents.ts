// The agents requests to an object store (S3, Azure Blob Storage) go out through, trusting a CA bundle and going
// through a proxy as the Source says, shared by the Source Types that have those settings.

import { readFile } from 'node:fs/promises'
import { Agent as HttpAgent, type AgentOptions, type ClientRequest, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from 'node:https'
import { isIP } from 'node:net'
import { createSecureContext, getCACertificates, type SecureContext } from 'node:tls'
import { CoreError } from './core-error'
import { proxyFromEnv } from './proxy-env'

/** What a Source's trust and proxy settings come to, with its CA bundle read in. */
export interface NetworkSettings {
  /** Whether the server's TLS certificate is checked. */
  verifyTls: boolean
  /** PEM CA certificates to trust as well as Node's own and the OS trust store. */
  caBundle?: string
  /** A proxy for every request; blank to follow HTTPS_PROXY / NO_PROXY. */
  proxyUrl: string
}

/** Reads a CA bundle, which must hold at least one PEM certificate. */
export async function readCaBundle(path: string) {
  let bundle: string
  try {
    bundle = await readFile(path, 'utf8')
  } catch (error) {
    throw new CoreError('CA_BUNDLE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  if (!bundle.includes('-----BEGIN CERTIFICATE-----')) throw new CoreError('CA_BUNDLE_UNREADABLE', `No PEM certificates in ${path}`)
  return bundle
}

// Secure contexts by the CA certificates they trust. Parsing the hundreds of them takes a few hundred milliseconds, so
// it's done once for every Source trusting the same ones, not for each Source, nor (as an agent given `ca` would) for
// each connection.
const secureContexts = new Map<string, SecureContext>()

/** A secure context trusting Node's CAs, the OS's, and `caBundle`'s. */
function secureContextFor(caBundle: string | undefined) {
  const ca = [...new Set([...getCACertificates('default'), ...getCACertificates('system')]), ...(caBundle ? [caBundle] : [])]
  // Keyed by the certificates themselves, which change if Node's are replaced, rather than by the bundle alone.
  const key = ca.join('\n')
  let context = secureContexts.get(key)
  if (!context) secureContexts.set(key, (context = createSecureContext({ ca })))
  return context
}

// Node hands a request to its agent through this, which its types leave out.
interface RequestQueue {
  addRequest(request: ClientRequest, options: RequestOptions): void
}

/**
 * The proxy the environment gives the host a request is for, as it is now and as kubectl reads it (`proxyFromEnv`):
 * `''` for none.
 */
function proxyFor(protocol: string, options: RequestOptions) {
  return proxyFromEnv(origin(protocol, options)) ?? ''
}

/** Where a request goes, as a URL with no path: `https://[::1]:8443`, say. */
function origin(protocol: string, { hostname, host, port }: RequestOptions) {
  const name = hostname ?? host ?? 'localhost'
  return `${protocol}//${isIP(name) === 6 ? `[${name}]` : name}:${port ?? (protocol === 'https:' ? 443 : 80)}`
}

/** Hands a request to the agent `agents` keeps for `proxy` (`''` for none), which `make` makes when first needed. */
function queue(agents: Map<string, HttpAgent>, proxy: string, make: (proxyEnv: NodeJS.ProcessEnv) => HttpAgent, request: ClientRequest, options: RequestOptions) {
  let agent = agents.get(proxy)
  if (!agent) agents.set(proxy, (agent = make(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {})))
  ;(agent as unknown as RequestQueue).addRequest(request, options)
}

/**
 * Readies a plain http request for going through `proxy`, as Node does for a request given an agent with a proxy of
 * its own: asking for its full URL rather than its path, and signing in to the proxy as its URL says. An https request
 * needs none of it: its agent asks the proxy for a tunnel.
 */
function addressToProxy(request: ClientRequest, options: RequestOptions, proxy: string) {
  // Its headers are fixed already when it asks to be let send its body (Expect: 100-continue), which nothing here asks.
  if (request.headersSent) throw new Error(`Can't send a request whose headers are fixed already through ${proxy}`)
  const { username, password } = new URL(proxy)
  if (username || password) {
    const credentials = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`
    request.setHeader('proxy-authorization', `Basic ${Buffer.from(credentials).toString('base64')}`)
  }
  request.setHeader('proxy-connection', request.shouldKeepAlive ? 'keep-alive' : 'close')
  // The host and port the proxy was chosen for, rather than the Host header, which could name another.
  request.path = new URL(request.path, origin('http:', options)).href
}

/** An http agent following the environment's proxy settings for each request. */
class EnvironmentHttpAgent extends HttpAgent {
  readonly #agents = new Map<string, HttpAgent>()
  readonly #options: AgentOptions

  constructor(options: AgentOptions) {
    super(options)
    this.#options = options
  }

  addRequest(request: ClientRequest, options: RequestOptions) {
    const proxy = proxyFor('http:', options)
    if (proxy) addressToProxy(request, options, proxy)
    queue(this.#agents, proxy, (proxyEnv) => new HttpAgent({ ...this.#options, proxyEnv }), request, options)
  }

  override destroy() {
    for (const agent of this.#agents.values()) agent.destroy()
    super.destroy()
  }
}

/** An https agent following the environment's proxy settings for each request. */
class EnvironmentHttpsAgent extends HttpsAgent {
  readonly #agents = new Map<string, HttpAgent>()
  readonly #options: HttpsAgentOptions

  constructor(options: HttpsAgentOptions) {
    super(options)
    this.#options = options
  }

  addRequest(request: ClientRequest, options: RequestOptions) {
    queue(this.#agents, proxyFor('https:', options), (proxyEnv) => new HttpsAgent({ ...this.#options, proxyEnv }), request, options)
  }

  override destroy() {
    for (const agent of this.#agents.values()) agent.destroy()
    super.destroy()
  }
}

/** The agents requests go out through: trusting Node's CAs, the OS's and the Source's own, and via its proxy. */
export function networkAgents({ verifyTls, caBundle, proxyUrl }: NetworkSettings) {
  const secureContext = secureContextFor(caBundle)
  const https: HttpsAgentOptions = { keepAlive: true, secureContext, rejectUnauthorized: verifyTls }
  // A proxy of the Source's own takes every request; otherwise the environment's settings decide for each.
  if (proxyUrl) {
    const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }
    return { httpAgent: new HttpAgent({ keepAlive: true, proxyEnv }), httpsAgent: new HttpsAgent({ ...https, proxyEnv }) }
  }
  return { httpAgent: new EnvironmentHttpAgent({ keepAlive: true }), httpsAgent: new EnvironmentHttpsAgent(https) }
}
