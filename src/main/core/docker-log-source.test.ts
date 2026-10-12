import { afterAll, beforeAll, describe } from 'vitest'
import { connectDockerEngine, dockerEndpointOf } from './docker-log-source'
import { startTestDockerEngine, type TestDockerEngine } from './docker-test-engine'
import { hasTestDocker, testCounter } from './docker-test-seed'
import { describeLogSourceContract } from './log-source-contract'

const capabilities = { previousLog: false, restarts: false, status: false }

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
    logSource: (await connectDockerEngine(dockerEndpointOf('default', { DOCKER_HOST: engine.host }))).logSource,
    counter: '_standalone/counter'
  }))
})

describe.skipIf(!hasTestDocker)('Docker Logs against the test engine', () => {
  describeLogSourceContract('Docker Logs', capabilities, async () => ({
    logSource: (await connectDockerEngine(dockerEndpointOf('default'))).logSource,
    counter: testCounter
  }))
})
