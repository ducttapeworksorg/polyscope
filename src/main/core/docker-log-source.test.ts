import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe } from 'vitest'
import { dockerEndpointOf } from './docker-contexts'
import { connectDockerEngine } from './docker-log-source'
import { dialerOver } from './docker-ssh'
import { startTestDockerEngine, type TestDockerEngine } from './docker-test-engine'
import { hasTestDocker, testCounter, testSshContext, testTlsContext } from './docker-test-seed'
import { describeLogSourceContract } from './log-source-contract'
import type { LogSource } from './log-source'
import { connectSsh, type SshConnection } from './ssh-connection'

const capabilities = { previousLog: false, restarts: true, status: true }

/** What the seed's `counter` logs before it sleeps, a millisecond apart: `line 1` to `line 100`. */
const counterLogs = Array.from({ length: 100 }, (_, i) => ({
  stream: 'stdout' as const,
  time: new Date(Date.UTC(2026, 9, 12, 10, 0, 0, i)).toISOString().replace('Z', '000000Z'),
  text: `line ${i + 1}`
}))

describe('Docker Logs against a stand-in engine', () => {
  let engine: TestDockerEngine

  beforeAll(async () => {
    engine = await startTestDockerEngine([
      { name: 'counter', logs: counterLogs },
      { name: 'shop-web-1', labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' } },
      { name: 'shop-worker-1', labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'worker' } },
      { name: 'shop-worker-2', labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'worker' }, state: 'exited' }
    ])
  })

  afterAll(() => engine.close())

  describeLogSourceContract('Docker Logs', capabilities, async () => ({
    logSource: (await connectDockerEngine(await dockerEndpointOf('default', { DOCKER_HOST: engine.host }))).logSource,
    counter: '_standalone/counter'
  }))
})

describe.skipIf(!hasTestDocker)('Docker Logs against the test engine', () => {
  describeLogSourceContract('Docker Logs', capabilities, async () => ({
    logSource: (await connectDockerEngine(await dockerEndpointOf('default'))).logSource,
    counter: testCounter
  }))
})

describe.skipIf(!hasTestDocker || !testTlsContext)('Docker Logs against the test engine, through a context fronting it with TLS', () => {
  describeLogSourceContract('Docker Logs over TLS', capabilities, async () => ({
    logSource: (await connectDockerEngine(await dockerEndpointOf(testTlsContext!))).logSource,
    counter: testCounter
  }))
})

// Each connection to the engine runs the docker command on the host, slow while the other test files keep the engine busy.
describe.skipIf(!hasTestDocker || !testSshContext)('Docker Logs against the test engine, through an ssh:// context', { timeout: 20_000 }, () => {
  // One connection for the whole suite, as a Source keeps one: signing in afresh for each test is slow under load.
  let connection: SshConnection | undefined
  let reached: Promise<LogSource> | undefined
  afterAll(() => connection?.close())

  const reach = async () => {
    const endpoint = await dockerEndpointOf(testSshContext!.name)
    if (!('ssh' in endpoint)) throw new Error(`${testSshContext!.name} isn't an ssh:// context`)
    const { host, port = 22, user = '' } = endpoint.ssh
    const privateKey = await readFile(join(testSshContext!.dir, 'client_key'))
    // The façade tests check the host key; this suite trusts the server ssh.sh started.
    connection = await connectSsh({ host, port, user, privateKey }, { checkHostKey: () => 'trusted' })
    return (await connectDockerEngine(endpoint, dialerOver(connection, host))).logSource
  }

  describeLogSourceContract('Docker Logs over SSH', capabilities, async () => ({ logSource: await (reached ??= reach()), counter: testCounter }))
})
