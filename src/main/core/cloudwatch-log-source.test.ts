import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCloudWatchLogSource, type CloudWatchTarget } from './cloudwatch-log-source'
import { allowedCloudWatchOperations, startTestCloudWatchEndpoint, type TestCloudWatchEndpoint, type TestLogGroup } from './cloudwatch-test-endpoint'
import { describeLogSourceContract } from './log-source-contract'
import { cloudWatchSegment as segment } from '@shared/core-api'

const capabilities = { previousLog: false, restarts: false, status: false }

const at = (ms: number) => Date.UTC(2026, 9, 12, 10, 0, 0, ms)

/** `line 1` to `line 100`, a millisecond apart. */
const counterEvents = Array.from({ length: 100 }, (_, i) => ({ timestamp: at(i), message: `line ${i + 1}` }))

const seed = (): TestLogGroup[] => [
  { name: '/aws/lambda/counter', retentionDays: 14, storedBytes: 2048, streams: [{ name: '2026/10/12/[$LATEST]0123abcd', events: counterEvents }] },
  {
    name: '/aws/lambda/orders',
    streams: [
      { name: '2026/10/12/[$LATEST]old', events: [{ timestamp: at(1_000), message: 'old' }] },
      { name: '2026/10/12/[$LATEST]new', events: [{ timestamp: at(9_000), message: 'new' }] },
      { name: '2026/10/12/[$LATEST]middle', events: [{ timestamp: at(5_000), message: 'middle' }] },
      { name: 'quiet' }
    ]
  },
  { name: '/ecs/shop', streams: [{ name: 'web/web/abc', events: [{ timestamp: at(0), message: 'first line\nsecond line\n' }] }] }
]

const counter = `${segment('/aws/lambda/counter')}/${segment('2026/10/12/[$LATEST]0123abcd')}`

let endpoint: TestCloudWatchEndpoint

const target = (changes: Partial<CloudWatchTarget> = {}): CloudWatchTarget => ({
  region: 'eu-west-1',
  prefix: '',
  endpoint: endpoint.url,
  credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
  verifyTls: true,
  proxyUrl: '',
  ...changes
})

describe('CloudWatch Logs against a stand-in endpoint', () => {
  beforeAll(async () => {
    endpoint = await startTestCloudWatchEndpoint(seed(), { accessKeyId: 'AKIDTEST' })
  })

  afterAll(async () => {
    // ADR 0008: nothing billed per use, like Live Tail or Logs Insights, is ever called.
    const allowed: readonly string[] = allowedCloudWatchOperations
    expect(endpoint.operations.filter((operation) => !allowed.includes(operation))).toEqual([])
    await endpoint.close()
  })

  describeLogSourceContract('CloudWatch Logs', capabilities, async () => ({
    logSource: createCloudWatchLogSource(target(), { pageSize: 2, pollInterval: 100 }),
    counter
  }))

  describe('its tree', () => {
    it('lists log groups by name, with their size and retention, and never folds in their only stream', async () => {
      const nodes = await createCloudWatchLogSource(target()).listChildren('')

      expect(nodes.map((node) => node.name)).toEqual(['/aws/lambda/counter', '/aws/lambda/orders', '/ecs/shop'].map(segment))
      expect(nodes[0]).toEqual({
        kind: 'group',
        name: segment('/aws/lambda/counter'),
        path: segment('/aws/lambda/counter'),
        unfoldable: true,
        cloudwatch: { kind: 'logGroup', storedBytes: 2048, retentionDays: 14 }
      })
      expect(nodes[1]).toMatchObject({ cloudwatch: { kind: 'logGroup', storedBytes: 0 } })
      expect(nodes[1]!.kind === 'group' && nodes[1]!.cloudwatch).not.toHaveProperty('retentionDays')
    })

    it('lists only the log groups starting with its prefix', async () => {
      const logSource = createCloudWatchLogSource(target({ prefix: '/aws/lambda/' }))

      expect((await logSource.listChildren('')).map((node) => node.name)).toEqual(['/aws/lambda/counter', '/aws/lambda/orders'].map(segment))
      await expect(logSource.listChildren(segment('/ecs/shop'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('lists log groups a page at a time', async () => {
      const logSource = createCloudWatchLogSource(target(), { pageSize: 2 })

      const first = await logSource.listPage!('')
      expect(first.nodes.map((node) => node.name)).toEqual(['/aws/lambda/counter', '/aws/lambda/orders'].map(segment))
      const second = await logSource.listPage!('', first.cursor)
      expect(second).toEqual({ nodes: [expect.objectContaining({ name: segment('/ecs/shop') })] })
    })

    it('lists a group’s streams newest event first, a page at a time, with their last event times', async () => {
      const logSource = createCloudWatchLogSource(target(), { pageSize: 2 })
      const group = segment('/aws/lambda/orders')

      const first = await logSource.listPage!(group)
      const second = await logSource.listPage!(group, first.cursor)

      expect([...first.nodes, ...second.nodes]).toEqual([
        { kind: 'logStream', name: segment('2026/10/12/[$LATEST]new'), path: `${group}/${segment('2026/10/12/[$LATEST]new')}`, cloudwatch: { kind: 'logStream', lastEventTime: at(9_000) } },
        expect.objectContaining({ name: segment('2026/10/12/[$LATEST]middle'), cloudwatch: { kind: 'logStream', lastEventTime: at(5_000) } }),
        expect.objectContaining({ name: segment('2026/10/12/[$LATEST]old') }),
        expect.objectContaining({ name: 'quiet', cloudwatch: { kind: 'logStream' } })
      ])
      expect(second.cursor).toBeUndefined()
    })
  })

  describe('reading a stream', () => {
    it('keeps a multi-line event’s line breaks, each line with the event’s timestamp', async () => {
      const logSource = createCloudWatchLogSource(target())

      const read = await logSource.readLog(`${segment('/ecs/shop')}/${segment('web/web/abc')}`, { timestamps: true })

      expect(read).toBe('2026-10-12T10:00:00.000Z first line\n2026-10-12T10:00:00.000Z second line\n')
    })

    it('reads the last lines back a page at a time', async () => {
      const logSource = createCloudWatchLogSource(target())
      endpoint.operations.length = 0

      expect(await logSource.readLog(counter, { tailLines: 3 })).toBe('line 98\nline 99\nline 100\n')
      expect(endpoint.operations).toEqual(['GetLogEvents'])
    })

    it('tells a stream that has gone', async () => {
      const logSource = createCloudWatchLogSource(target())

      await expect(logSource.readLog(`${segment('/aws/lambda/gone')}/x`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  it('turns away and records an operation outside the four allowed, for the check after every test to catch', async () => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Logs_20140328.StartLiveTail', authorization: 'Credential=AKIDTEST/' },
      body: '{}'
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ __type: 'UnknownOperationException' })
    expect(endpoint.operations.at(-1)).toBe('StartLiveTail')
    // Forgotten again, so the check after the suite, which would fail, passes.
    endpoint.operations.pop()
  })

  describe('signing in', () => {
    it('fails with keys the endpoint doesn’t know', async () => {
      const logSource = createCloudWatchLogSource(target({ credentials: { accessKeyId: 'AKIDOTHER', secretAccessKey: 'secret' } }))

      await expect(logSource.listChildren('')).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    })
  })
})
