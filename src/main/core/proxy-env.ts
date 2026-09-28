// The proxy settings of the process's environment variables, read the way kubectl (Go's net/http) reads them.

import { BlockList, isIP } from 'node:net'

type Env = Record<string, string | undefined>

/** The first of `names` set to something other than blank. */
const envAny = (env: Env, ...names: string[]) => names.map((name) => env[name]?.trim()).find(Boolean)

const ipType = (address: string) => (isIP(address) === 6 ? 'ipv6' : 'ipv4')

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

/** Whether a host is this machine: localhost, 127.0.0.0/8 or ::1. */
const isLoopback = (host: string) => host === 'localhost' || (isIP(host) > 0 && loopback.check(host, ipType(host)))

/** A NO_PROXY entry's host and port, e.g. `kube.corp:6443` or `[fd00::5]:6443`; the port blank if it names none. */
function hostAndPort(entry: string): [string, string] {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(entry)
  if (bracketed) return [bracketed[1]!, bracketed[2] ?? '']
  const withPort = /^([^:]+):(\d+)$/.exec(entry)
  return withPort ? [withPort[1]!, withPort[2]!] : [entry, '']
}

/** Whether a NO_PROXY entry covers a host (lowercase, no brackets) and port. */
function covers(entry: string, host: string, port: string) {
  if (entry === '*') return true
  const cidr = /^(.+)\/(\d+)$/.exec(entry)
  if (cidr) {
    const [, network, prefix] = cidr
    if (!isIP(network!) || !isIP(host) || ipType(network!) !== ipType(host)) return false
    const range = new BlockList()
    range.addSubnet(network!, Number(prefix), ipType(network!))
    return range.check(host, ipType(host))
  }
  const [name, entryPort] = hostAndPort(entry)
  if (entryPort && entryPort !== port) return false
  if (isIP(name)) return name === host
  // `.corp` and `*.corp` cover only its subdomains; `corp` covers it too.
  const domain = name.replace(/^\*(?=\.)/, '')
  return domain.startsWith('.') ? host.endsWith(domain) : host === domain || host.endsWith(`.${domain}`)
}

/**
 * The proxy kubectl would take from the environment to reach `server`: HTTPS_PROXY for an https server,
 * HTTP_PROXY for an http one (lowercase names too), http if it names no scheme. None for this machine, as
 * with kubectl, or for a host NO_PROXY covers: `*`, a domain and its subdomains (`.corp` or `*.corp` just
 * its subdomains), an address or CIDR range, any of them with a `:port`.
 */
export function proxyFromEnv(server: string, env: Env = process.env): string | undefined {
  const url = new URL(server)
  const https = url.protocol === 'https:'
  const proxy = https ? envAny(env, 'HTTPS_PROXY', 'https_proxy') : envAny(env, 'HTTP_PROXY', 'http_proxy')
  if (!proxy) return undefined
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (isLoopback(host)) return undefined
  const port = url.port || (https ? '443' : '80')
  const noProxy = (envAny(env, 'NO_PROXY', 'no_proxy') ?? '').toLowerCase().split(',')
  if (noProxy.map((entry) => entry.trim()).some((entry) => entry && covers(entry, host, port))) return undefined
  return /^[a-z][a-z\d+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`
}
