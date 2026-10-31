import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { networkAgents } from './network-agents'
import { ignoreAmbientProxy, startProxy, startTlsFront } from './test-network'

// Only the test proxies know this name, so whatever reaches the server by it went through one of them.
const host = 'store.polyscope.test'

// An address in a private range nothing answers at, but the test proxies reach.
const address = '10.255.255.1'

const disposals: (() => Promise<void>)[] = []

beforeEach(() => ignoreAmbientProxy())

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
})

/** A server answering every request with its path, over http and over https through a TLS front. */
async function startServer() {
  const server = createServer((request, response) => response.end(request.url))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const listening = server.address()
  if (!listening || typeof listening === 'string') throw new Error('Not listening on a port')
  disposals.push(() => new Promise((resolve) => server.close(() => resolve())))
  const front = await startTlsFront(`http://127.0.0.1:${listening.port}`)
  disposals.push(front.close)
  return { httpPort: listening.port, httpsPort: Number(new URL(front.url).port), caBundle: await readFile(front.caPath, 'utf8') }
}

/** A proxy that reaches `host` (and only it, by that name) and `address` at 127.0.0.1. */
async function proxy() {
  const started = await startProxy({ hosts: { [host]: '127.0.0.1', [address]: '127.0.0.1' } })
  disposals.push(started.close)
  return started
}

/** GETs `url` through the agents for a Source with no proxy of its own, trusting `caBundle`; the response's body. */
function get(url: string, caBundle: string) {
  const { httpAgent, httpsAgent } = networkAgents({ verifyTls: true, caBundle, proxyUrl: '' })
  const https = url.startsWith('https:')
  return new Promise<string>((resolve, reject) => {
    const request = (https ? httpsRequest : httpRequest)(url, { agent: https ? httpsAgent : httpAgent }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve(body))
    })
    request.on('error', reject)
    request.end()
  }).finally(() => {
    httpAgent.destroy()
    httpsAgent.destroy()
  })
}

/** Tries `url` as `get` does, until it fails or 500 ms pass; whether it got a response. */
const attempt = (url: string, caBundle: string) =>
  Promise.race([get(url, caBundle).then(() => true, () => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))])

describe('the agents of a Source with no proxy of its own', () => {
  // Windows' variable names ignore case: there, https_proxy would be HTTPS_PROXY itself.
  it.skipIf(process.platform === 'win32')('go through HTTPS_PROXY over https_proxy when both are set', async () => {
    const { httpsPort, caBundle } = await startServer()
    const upper = await proxy()
    const lower = await proxy()
    vi.stubEnv('HTTPS_PROXY', upper.url)
    vi.stubEnv('https_proxy', lower.url)

    expect(await get(`https://${host}:${httpsPort}/a`, caBundle)).toBe('/a')
    expect(upper.tunnels).toEqual([`${host}:${httpsPort}`])
    expect(lower.tunnels).toEqual([])
  })

  it('go straight to an address in a NO_PROXY range', async () => {
    const { httpsPort, caBundle } = await startServer()
    const { url, tunnels } = await proxy()
    vi.stubEnv('HTTPS_PROXY', url)

    await attempt(`https://${address}:${httpsPort}/`, caBundle)
    expect(tunnels).toEqual([`${address}:${httpsPort}`])

    vi.stubEnv('NO_PROXY', '10.0.0.0/8')
    await attempt(`https://${address}:${httpsPort}/`, caBundle)
    expect(tunnels).toHaveLength(1)
  })

  it('go straight to this machine, whatever HTTPS_PROXY says', async () => {
    const { httpsPort, caBundle } = await startServer()
    const { url, tunnels } = await proxy()
    vi.stubEnv('HTTPS_PROXY', url)

    expect(await get(`https://127.0.0.1:${httpsPort}/a`, caBundle)).toBe('/a')
    expect(await get(`https://localhost:${httpsPort}/b`, caBundle)).toBe('/b')
    expect(tunnels).toEqual([])
  })

  it('ignore ALL_PROXY', async () => {
    const { httpsPort, caBundle } = await startServer()
    const upper = await proxy()
    const lower = await proxy()
    vi.stubEnv('ALL_PROXY', upper.url)
    vi.stubEnv('all_proxy', lower.url)

    expect(await attempt(`https://${host}:${httpsPort}/`, caBundle)).toBe(false)
    expect([...upper.tunnels, ...lower.tunnels]).toEqual([])
  })

  // Windows' variable names ignore case: there, https_proxy would be HTTPS_PROXY itself.
  it.skipIf(process.platform === 'win32')('send an http request through HTTP_PROXY, HTTP_PROXY over http_proxy', async () => {
    const { httpPort, caBundle } = await startServer()
    const upper = await proxy()
    const lower = await proxy()
    vi.stubEnv('HTTP_PROXY', upper.url)
    vi.stubEnv('http_proxy', lower.url)

    expect(await get(`http://${host}:${httpPort}/a?b`, caBundle)).toBe('/a?b')
    expect(upper.forwards).toEqual([`http://${host}:${httpPort}/a?b`])
    expect(lower.forwards).toEqual([])
  })

  it('choose for each request’s host, as the environment is when it’s made', async () => {
    const { httpsPort, caBundle } = await startServer()
    const { url, tunnels } = await proxy()
    const { httpsAgent } = networkAgents({ verifyTls: true, caBundle, proxyUrl: '' })
    const through = (target: string) =>
      new Promise<void>((resolve, reject) => httpsRequest(target, { agent: httpsAgent }, (response) => response.resume().on('end', resolve)).on('error', reject).end())
    vi.stubEnv('HTTPS_PROXY', url)

    await through(`https://${host}:${httpsPort}/`)
    await through(`https://127.0.0.1:${httpsPort}/`)
    vi.stubEnv('NO_PROXY', '.polyscope.test')
    await expect(through(`https://${host}:${httpsPort}/`)).rejects.toThrow()
    httpsAgent.destroy()
    expect(tunnels).toEqual([`${host}:${httpsPort}`])
  })
})
