// Test support: a stand-in for a Kubernetes API server, just enough of one to connect a Kubernetes Logs Source to
// and read and follow its one log, over TLS with a certificate from the private test CA. Its namespace `shop` holds
// an ownerless pod `counter`; in `locked`, listing pods is denied the way RBAC denies it. Given a token, it turns away
// requests that don't bear it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startTlsFront } from './test-network'

/** What `counter` logs, with when, a second apart: `line 1` to `line 3`, then `line 4` while it's followed. */
const logged = [1, 2, 3, 4].map((i) => ({ time: `2026-09-27T10:00:0${i}.000000000Z`, text: `line ${i}` }))

const counter = {
  metadata: { name: 'counter', uid: 'counter' },
  spec: { containers: [{ name: 'counter' }] },
  status: {
    phase: 'Running',
    containerStatuses: [{ name: 'counter', image: 'busybox', imageID: '', ready: true, restartCount: 0, state: { running: {} } }]
  }
}

const json = (response: ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

function respond(request: IncomingMessage, response: ServerResponse, token: string | undefined) {
  if (token !== undefined && request.headers.authorization !== `Bearer ${token}`) {
    return json(response, 401, { kind: 'Status', status: 'Failure', reason: 'Unauthorized', code: 401, message: 'Unauthorized' })
  }
  const url = new URL(request.url ?? '/', 'http://api')
  const namespaced = /^\/apis?\/(?:[^/]+\/)?v1\/namespaces\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!namespaced) return json(response, 404, { kind: 'Status', code: 404, message: 'not found' })
  const [, namespace, rest = ''] = namespaced
  if (!rest) return json(response, 200, { kind: 'Namespace', apiVersion: 'v1', metadata: { name: namespace } })
  if (namespace === 'locked' && rest === '/pods') {
    const message = `pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "locked"`
    return json(response, 403, { kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403, message })
  }
  if (namespace === 'shop' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [counter] })
  if (namespace === 'shop' && rest === '/pods/counter') return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...counter })
  if (namespace === 'shop' && rest === '/pods/counter/log') {
    const stamped = url.searchParams.get('timestamps') === 'true'
    const following = url.searchParams.get('follow') === 'true'
    const lines = following ? logged : logged.slice(0, 3)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write(lines.map(({ time, text }) => `${stamped ? `${time} ` : ''}${text}\n`).join(''))
    // Following: nothing more for as long as the connection lasts.
    return following ? undefined : response.end()
  }
  return json(response, 200, { kind: 'List', apiVersion: 'v1', metadata: {}, items: [] })
}

/**
 * Starts the stand-in; `url` is its https address on 127.0.0.1, and `caPath` a PEM file of the CA that trusts it.
 * With a `token`, only requests bearing it are answered.
 */
export async function startTestApiServer({ token }: { token?: string } = {}) {
  const server = createServer((request, response) => respond(request, response, token))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const front = await startTlsFront(`http://127.0.0.1:${port}`)
  return {
    url: front.url,
    caPath: front.caPath,
    close: async () => {
      await front.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
