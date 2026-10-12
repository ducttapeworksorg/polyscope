// The agents requests to an object store (S3, Azure Blob Storage) go out through, trusting a CA bundle and going
// through a proxy as the Source says, shared by the Source Types that have those settings.

import { readFile } from 'node:fs/promises'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createSecureContext, getCACertificates, type SecureContext } from 'node:tls'
import { CoreError } from './core-error'

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

/** The agents requests go out through: trusting Node's CAs, the OS's and the Source's own, and via its proxy. */
export function networkAgents({ verifyTls, caBundle, proxyUrl }: NetworkSettings) {
  // A proxy of the Source's own takes every request; otherwise the environment's settings, as they are now, decide.
  const proxyEnv = proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : { ...process.env }
  const secureContext = secureContextFor(caBundle)
  return {
    httpAgent: new HttpAgent({ keepAlive: true, proxyEnv }),
    httpsAgent: new HttpsAgent({ keepAlive: true, proxyEnv, secureContext, rejectUnauthorized: verifyTls })
  }
}
