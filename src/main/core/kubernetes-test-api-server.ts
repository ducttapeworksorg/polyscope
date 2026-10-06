// Test support: a stand-in for a Kubernetes API server, just enough of one to connect a Kubernetes Logs Source to
// and read and follow its one log, over TLS with a certificate from the private test CA. Its namespace `shop` holds
// an ownerless pod `counter`; in `locked`, listing pods is denied the way RBAC denies it; `crashing` holds a pod `crasher`
// whose restarted containers' previous runs Kubernetes has removed; `files` holds the Deployments of `filesDeployments`, for
// a Kubernetes Files Source's tree (it can't exec into their pods). Given a token, it turns away requests that don't bear it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { vi } from 'vitest'
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

/** The container runtimes `crasher`'s containers are named after, each with its own container id scheme. */
const runtimes = ['containerd', 'cri-o', 'docker']

/** What the kubelet answers for the log of a container's run it no longer keeps. */
const removedRunMessage = (runtime: string) => `unable to retrieve container logs for ${runtime}://0123456789abcdef`

/** Crash-looping, waiting to run again: its last run is the current one, and the run before that is gone. */
const crasher = {
  metadata: { name: 'crasher', uid: 'crasher' },
  spec: { containers: runtimes.map((name) => ({ name })) },
  status: {
    phase: 'Running',
    containerStatuses: runtimes.map((name) => ({
      name,
      image: 'busybox',
      imageID: '',
      ready: false,
      restartCount: 3,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { exitCode: 1, reason: 'Error' } }
    }))
  }
}

/** A pod of a ReplicaSet in `files`, its containers named, all running or (`crashing`) all crash-looping. */
const filesPod = (name: string, replicaSet: string, containers: string[], { crashing = false, sidecar = '' } = {}) => ({
  metadata: { name, uid: name, ownerReferences: [{ kind: 'ReplicaSet', name: replicaSet, uid: replicaSet, controller: true }] },
  spec: {
    containers: containers.map((container) => ({ name: container })),
    ...(sidecar && { initContainers: [{ name: sidecar, restartPolicy: 'Always' }] })
  },
  status: {
    phase: 'Running',
    ...(sidecar && { initContainerStatuses: [{ name: sidecar, image: 'busybox', imageID: '', ready: true, restartCount: 0, state: { running: {} } }] }),
    containerStatuses: containers.map((container) => ({
      name: container,
      image: 'busybox',
      imageID: '',
      ready: !crashing,
      restartCount: crashing ? 2 : 0,
      state: crashing ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} },
      ...(crashing && { lastState: { terminated: { exitCode: 1, reason: 'Error' } } })
    }))
  }
})

/**
 * The Deployments in `files`, each with one ReplicaSet, and their pods: `solo` has one pod of one container, crash-looping;
 * `pair` one pod with a main container and a sidecar; `duo` two pods.
 */
export const filesDeployments = {
  solo: [filesPod('solo-7d9f-abcde', 'solo-7d9f', ['app'], { crashing: true })],
  pair: [filesPod('pair-5c4b-fghij', 'pair-5c4b', ['app'], { sidecar: 'proxy' })],
  duo: [filesPod('duo-6a2e-klmno', 'duo-6a2e', ['app']), filesPod('duo-6a2e-pqrst', 'duo-6a2e', ['app'])]
}

const filesPods = Object.values(filesDeployments).flat()

const filesReplicaSets = Object.entries(filesDeployments).map(([deployment, [pod]]) => {
  const name = pod!.metadata.ownerReferences[0]!.name
  return { metadata: { name, uid: name, ownerReferences: [{ kind: 'Deployment', name: deployment, uid: deployment, controller: true }] } }
})

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
  if (namespace === 'crashing' && rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [crasher] })
  if (namespace === 'crashing' && rest === '/pods/crasher') return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...crasher })
  if (namespace === 'crashing' && rest === '/pods/crasher/log') {
    // The previous run: the kubelet's answer, unstamped and with no line break. The current run logged that same line itself.
    const runtime = url.searchParams.get('container') ?? ''
    const previous = url.searchParams.get('previous') === 'true'
    return response.writeHead(200, { 'content-type': 'text/plain' }).end(previous ? removedRunMessage(runtime) : `${removedRunMessage(runtime)}\n`)
  }
  if (namespace === 'files') {
    if (rest === '/pods') return json(response, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: filesPods })
    if (rest === '/replicasets') return json(response, 200, { kind: 'ReplicaSetList', apiVersion: 'apps/v1', metadata: {}, items: filesReplicaSets })
    const pod = filesPods.find((p) => rest === `/pods/${p.metadata.name}`)
    if (pod) return json(response, 200, { kind: 'Pod', apiVersion: 'v1', ...pod })
    const deployment = Object.keys(filesDeployments).find((name) => rest === `/deployments/${name}`)
    if (deployment) return json(response, 200, { kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: deployment, uid: deployment } })
    if (rest.startsWith('/pods/') || rest.startsWith('/deployments/')) return json(response, 404, { kind: 'Status', code: 404, reason: 'NotFound', message: 'not found' })
  }
  return json(response, 200, { kind: 'List', apiVersion: 'v1', metadata: {}, items: [] })
}

/** A kubeconfig whose context `fake` points at the stand-in API server at `server`, through `proxyUrl` if given. */
export const standInCluster = (server: string, caPath: string, proxyUrl?: string) =>
  [
    'apiVersion: v1',
    'kind: Config',
    'current-context: fake',
    'clusters:',
    '- name: fake',
    '  cluster:',
    `    server: ${server}`,
    `    certificate-authority: ${JSON.stringify(caPath)}`,
    // The stand-in's certificate is for localhost.
    '    tls-server-name: localhost',
    ...(proxyUrl ? [`    proxy-url: ${proxyUrl}`] : []),
    'users:',
    '- name: fake',
    '  user:',
    '    token: not-a-real-token',
    'contexts:',
    '- name: fake',
    '  context:',
    '    cluster: fake',
    '    user: fake'
  ].join('\n')

/** Keeps the proxy settings of wherever the tests run out of the way. */
export const ignoreAmbientProxy = () => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(name, '')
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
