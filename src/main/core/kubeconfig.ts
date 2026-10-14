import { existsSync, readFileSync } from 'node:fs'
import type { AgentOptions } from 'node:https'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getCACertificates } from 'node:tls'
import { type Cluster, KubeConfig } from '@kubernetes/client-node'
import type { KubeContext } from '@shared/core-api'
import { CoreError } from './core-error'
import { proxyFromEnv } from './proxy-env'

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The kubeconfig files kubectl would read: those KUBECONFIG names, or else ~/.kube/config; only those that are there. */
function kubeconfigFiles() {
  const listed = process.env['KUBECONFIG']
  const files = listed ? listed.split(delimiter).filter(Boolean) : [join(homedir(), '.kube', 'config')]
  return files.filter((file) => existsSync(file))
}

/**
 * The user's kubeconfig, merged the way kubectl merges it: the first file to name a cluster, user or
 * context (or the current context) wins. Empty when there are no kubeconfig files.
 */
export function loadKubeConfig(): KubeConfig {
  const merged = new KubeConfig()
  for (const file of kubeconfigFiles()) {
    const config = new KubeConfig()
    try {
      config.loadFromFile(file)
    } catch (error) {
      throw new CoreError('KUBECONFIG_UNREADABLE', `${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const known = (list: { name: string }[], name: string) => list.some((item) => item.name === name)
    for (const cluster of config.clusters) if (!known(merged.clusters, cluster.name)) merged.addCluster(cluster)
    for (const user of config.users) if (!known(merged.users, user.name)) merged.addUser(user)
    for (const context of config.contexts) if (!known(merged.contexts, context.name)) merged.addContext(context)
    if (!merged.currentContext && config.currentContext) merged.currentContext = config.currentContext
  }
  return merged
}

/** The kubeconfig's contexts, by name. */
export async function listKubeContexts(): Promise<KubeContext[]> {
  const config = loadKubeConfig()
  return config.contexts
    .map(({ name, namespace }) => ({ name, ...(namespace && { namespace }), current: name === config.currentContext }))
    .sort((a, b) => byName.compare(a.name, b.name))
}

/** The CA a cluster names in its kubeconfig, as PEM; none if it names none. */
function namedCa({ caData, caFile }: Cluster) {
  if (caFile) {
    try {
      return readFileSync(caFile, 'utf8')
    } catch (error) {
      throw new CoreError('CA_BUNDLE_UNREADABLE', error instanceof Error ? error.message : String(error))
    }
  }
  return caData ? Buffer.from(caData, 'base64').toString('utf8') : ''
}

/**
 * What a cluster is trusted by, base64 PEM: Node's CAs, the OS's and the one it names. kubectl trusts only the one it
 * names, if any; but a company's cluster often names its issuing CA, whose root only the OS holds, and Node, unlike
 * kubectl, won't trust a CA that isn't a root.
 */
const caDataFor = (cluster: Cluster) => {
  const cas = [...new Set([...getCACertificates('default'), ...getCACertificates('system')]), namedCa(cluster)]
  return Buffer.from(cas.filter(Boolean).join('\n')).toString('base64')
}

type CreateDispatcher = (cluster: Cluster | null, agentOptions: AgentOptions) => unknown

/** Whether two TLS settings are the same: strings and flags equal, Buffers of the same bytes, lists of the same items. */
const sameSetting = (a: unknown, b: unknown): boolean => {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameSetting(item, b[i]))
  return a === b
}

/**
 * Has `config` make one dispatcher and reuse it while its TLS settings stay the same. The client makes one per call,
 * and so a TLS context of every CA a cluster is trusted by, some 150ms of CPU each, and never reuses a connection. An
 * exec plugin may hand over a new client certificate, which then gets a dispatcher of its own.
 */
function reuseDispatcher(config: KubeConfig) {
  const internals = config as unknown as { createDispatcher: CreateDispatcher }
  const create = internals.createDispatcher.bind(config)
  // The settings themselves are kept to compare against, in memory only, rather than a hash of them: a passphrase is
  // among them.
  let reused: { settings: unknown[]; dispatcher: unknown } | undefined
  internals.createDispatcher = (cluster, agentOptions) => {
    const { ca, cert, key, pfx, passphrase, servername, rejectUnauthorized } = agentOptions
    const settings = [cluster?.server, cluster?.proxyUrl, ca, cert, key, pfx, passphrase, servername, rejectUnauthorized]
    if (!reused || !sameSetting(reused.settings, settings)) reused = { settings, dispatcher: create(cluster, agentOptions) }
    return reused.dispatcher
  }
}

/**
 * The user's kubeconfig set to `context`; fails if it has no such context. Its cluster goes through its own
 * `proxy-url`, or else the proxy HTTPS_PROXY / NO_PROXY give it, as they are now; and trusts the OS's CAs and Node's
 * as well as any it names (Node alone trusts neither the OS's CAs, so company CAs would go unrecognised, nor a CA
 * that isn't a root).
 */
export function kubeConfigFor(context: string): KubeConfig {
  const config = loadKubeConfig()
  const found = config.getContextObject(context)
  if (!found) throw new CoreError('CONTEXT_NOT_FOUND', `No context named ${context} in the kubeconfig`)
  config.setCurrentContext(context)
  config.clusters = config.clusters.map((cluster) => {
    if (cluster.name !== found.cluster) return cluster
    const proxyUrl = cluster.proxyUrl || proxyFromEnv(cluster.server)
    const { caFile: _, ...rest } = cluster
    return { ...rest, ...(proxyUrl && { proxyUrl }), ...(!cluster.skipTLSVerify && { caData: caDataFor(cluster) }) }
  })
  reuseDispatcher(config)
  return config
}
