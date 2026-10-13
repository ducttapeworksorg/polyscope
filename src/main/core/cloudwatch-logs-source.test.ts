import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewCloudWatchLogsSource, TreeNode } from '@shared/core-api'
import { allowedCloudWatchOperations, startTestCloudWatchEndpoint, type TestCloudWatchEndpoint, type TestLogGroup } from './cloudwatch-test-endpoint'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { cloudWatchNameOf, cloudWatchSegment as segment } from '@shared/core-api'

let dir: string
let endpoint: TestCloudWatchEndpoint | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-cloudwatch-'))
  await awsFiles()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
  if (!endpoint) return
  // ADR 0008: nothing billed per use, like Live Tail or Logs Insights, is ever called.
  const allowed: readonly string[] = allowedCloudWatchOperations
  const operations = endpoint.operations
  await endpoint.close()
  endpoint = undefined
  expect(operations.filter((operation) => !allowed.includes(operation))).toEqual([])
})

/** Points the AWS SDK (and Polyscope) at config and credentials files of the test's own, empty unless given. */
async function awsFiles({ config = '', credentials = '' } = {}) {
  const configFile = join(dir, 'aws-config')
  const credentialsFile = join(dir, 'aws-credentials')
  await writeFile(configFile, config)
  await writeFile(credentialsFile, credentials)
  vi.stubEnv('AWS_CONFIG_FILE', configFile)
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile)
  for (const name of ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_CLOUDWATCH_LOGS']) {
    vi.stubEnv(name, undefined)
  }
}

const at = (ms: number) => Date.UTC(2026, 9, 12, 10, 0, 0, ms)

/** A Lambda function's log group with three streams, an ECS service's, and plenty more to page through. */
const seed = (): TestLogGroup[] => [
  {
    name: '/aws/lambda/orders',
    retentionDays: 30,
    storedBytes: 4096,
    streams: [
      { name: '2026/10/12/[$LATEST]aaa', events: [{ timestamp: at(1_000), message: 'START RequestId: 1' }] },
      {
        name: '2026/10/12/[$LATEST]ccc',
        events: [
          { timestamp: at(8_000), message: 'START RequestId: 3\n' },
          { timestamp: at(8_500), message: 'Error: boom\n    at handler (index.js:1:1)\n' },
          { timestamp: at(9_000), message: 'END RequestId: 3\n' }
        ]
      },
      { name: '2026/10/12/[$LATEST]bbb', events: [{ timestamp: at(5_000), message: 'START RequestId: 2' }] }
    ]
  },
  { name: '/ecs/shop', streams: [{ name: 'web/web/0123', events: [{ timestamp: at(0), message: 'listening' }] }] },
  ...Array.from({ length: 60 }, (_, i) => ({ name: `/batch/job-${String(i).padStart(2, '0')}` }))
]

async function endpointWith(groups = seed()) {
  endpoint = await startTestCloudWatchEndpoint(groups, { accessKeyId: 'AKIDTEST' })
  return endpoint
}

/** Settings signing in with the keys the stand-in endpoint takes. */
const settings = (changes: Partial<NewCloudWatchLogsSource> = {}): NewCloudWatchLogsSource => ({
  type: 'cloudwatchLogs',
  name: 'Lambdas',
  region: 'eu-west-1',
  auth: 'keys',
  accessKeyId: 'AKIDTEST',
  secretAccessKey: 'secret',
  endpoint: endpoint?.url ?? 'http://127.0.0.1:1',
  ...changes
})


const names = (nodes: TreeNode[]) => nodes.map((node) => (node.kind === 'more' ? '…more' : node.kind === 'error' ? node.code : cloudWatchNameOf(node.name)))

describe('adding a CloudWatch Logs Source', () => {
  it('is listed with its settings normalised, signing in with a profile unless told', async () => {
    const core = createCore()

    const added = await core.addSource({ type: 'cloudwatchLogs', name: 'Lambdas', region: ' eu-west-1 ', prefix: ' /aws/lambda/ ', profile: ' work-sso ' })

    const expected = {
      id: added.id,
      type: 'cloudwatchLogs',
      name: 'Lambdas',
      region: 'eu-west-1',
      prefix: '/aws/lambda/',
      auth: 'profile',
      accessKeyId: '',
      secretKeySet: false,
      profile: 'work-sso',
      endpoint: ''
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('keeps only whether a secret key is set, signing in with keys', async () => {
    const plain = { encrypt: (text: string) => Buffer.from(text), decrypt: (encrypted: Buffer) => encrypted.toString() }
    const secrets = createSecretStore({ cipher: plain })

    const added = await createCore({ secrets }).addSource(settings({ endpoint: 'vpce.example.com' }))

    expect(added).toMatchObject({ auth: 'keys', accessKeyId: 'AKIDTEST', secretKeySet: true, endpoint: 'https://vpce.example.com' })
    expect(added).not.toHaveProperty('secretAccessKey')
    expect(await secrets.get(added.id, 'secretKey')).toBe('secret')
  })

  it('needs a region, and keys need both their parts', async () => {
    const core = createCore()

    await expect(core.addSource(settings({ region: ' ' }))).rejects.toMatchObject({ code: 'REGION_REQUIRED' })
    await expect(core.addSource(settings({ accessKeyId: '' }))).rejects.toMatchObject({ code: 'ACCESS_KEY_REQUIRED' })
    await expect(core.addSource(settings({ secretAccessKey: '' }))).rejects.toMatchObject({ code: 'SECRET_KEY_REQUIRED' })
  })

  it('tests a connection by listing log groups, saving nothing', async () => {
    await endpointWith()
    const core = createCore()

    await expect(core.testConnection(settings())).resolves.toEqual({})
    expect(await core.listSources()).toEqual([])
  })

  it('fails the test with keys CloudWatch doesn’t know', async () => {
    await endpointWith()

    await expect(createCore().testConnection(settings({ accessKeyId: 'AKIDOTHER' }))).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('signs in with a profile from the credentials file', async () => {
    await endpointWith()
    await awsFiles({ credentials: '[logs]\naws_access_key_id = AKIDTEST\naws_secret_access_key = secret\n' })

    await expect(createCore().testConnection(settings({ auth: 'profile', profile: 'logs' }))).resolves.toEqual({})
  })

  it('signs in with the default credential chain when no profile is named', async () => {
    await endpointWith()
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDTEST')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')

    await expect(createCore().testConnection(settings({ auth: 'profile', profile: '' }))).resolves.toEqual({})
  })

  it('goes into the Error state when the profile isn’t in the local AWS config', async () => {
    await awsFiles({ config: '[profile other]\nregion = eu-west-1\n' })
    const core = createCore()
    const source = await core.addSource(settings({ auth: 'profile', profile: 'missing' }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'CREDENTIALS_UNAVAILABLE' })
  })
})

describe('the region of an AWS profile', () => {
  it('is the one its section of the config file names', async () => {
    await awsFiles({ config: '[default]\nregion = us-east-2\n[profile work]\nregion = eu-west-1\n[profile bare]\n' })
    const core = createCore()

    expect(await core.awsProfileRegion('work')).toBe('eu-west-1')
    expect(await core.awsProfileRegion('bare')).toBe('')
    expect(await core.awsProfileRegion('missing')).toBe('')
  })

  it('is, for the default credential chain, AWS_REGION’s, or else the default profile’s', async () => {
    await awsFiles({ config: '[default]\nregion = us-east-2\n' })
    const core = createCore()

    expect(await core.awsProfileRegion('')).toBe('us-east-2')
    vi.stubEnv('AWS_REGION', 'ap-southeast-2')
    expect(await core.awsProfileRegion('')).toBe('ap-southeast-2')
  })
})

describe('a connected CloudWatch Logs Source', () => {
  async function connected(changes: Partial<NewCloudWatchLogsSource> = {}, groups?: TestLogGroup[]) {
    await endpointWith(groups)
    const core = createCore()
    const source = await core.addSource(settings(changes))
    return { core, source, root: await core.connect(source.id) }
  }

  it('lists its log groups by name, a page at a time', async () => {
    const { core, source, root } = await connected()

    const job = (i: number) => `/batch/job-${String(i).padStart(2, '0')}`
    expect(names(root)).toEqual(['/aws/lambda/orders', ...Array.from({ length: 49 }, (_, i) => job(i)), '…more'])
    const more = root.at(-1)!
    if (more.kind !== 'more') throw new Error('No more node')
    expect(names(await core.expand(source.id, '', more.cursor))).toEqual([
      ...Array.from({ length: 11 }, (_, i) => job(49 + i)),
      '/ecs/shop'
    ])
  })

  it('lists only the log groups starting with its prefix, with their size and retention', async () => {
    const { root } = await connected({ prefix: '/aws/lambda/' })

    expect(root).toEqual([
      {
        kind: 'group',
        name: segment('/aws/lambda/orders'),
        path: segment('/aws/lambda/orders'),
        unfoldable: true,
        cloudwatch: { kind: 'logGroup', storedBytes: 4096, retentionDays: 30 }
      }
    ])
  })

  it('lists a log group’s streams newest event first, with their last event times', async () => {
    const { core, source } = await connected({ prefix: '/aws/lambda/' })

    const streams = await core.expand(source.id, segment('/aws/lambda/orders'))

    expect(names(streams)).toEqual(['2026/10/12/[$LATEST]ccc', '2026/10/12/[$LATEST]bbb', '2026/10/12/[$LATEST]aaa'])
    expect(streams[0]).toMatchObject({ kind: 'logStream', cloudwatch: { kind: 'logStream', lastEventTime: at(9_000) } })
  })

  it('lists a log group’s streams a page at a time', async () => {
    const streams = Array.from({ length: 55 }, (_, i) => ({ name: `task/${i}`, events: [{ timestamp: at(i), message: `${i}` }] }))
    const { core, source } = await connected({}, [{ name: 'busy', streams }])

    const first = await core.expand(source.id, 'busy')

    expect(names(first)).toEqual([...Array.from({ length: 50 }, (_, i) => `task/${54 - i}`), '…more'])
    const more = first.at(-1)!
    if (more.kind !== 'more') throw new Error('No more node')
    expect(names(await core.expand(source.id, 'busy', more.cursor))).toEqual(['task/4', 'task/3', 'task/2', 'task/1', 'task/0'])
  })

  it('opens a stream’s last lines with their timestamps, offering no Previous Log', async () => {
    const { core, source } = await connected()
    const path = `${segment('/aws/lambda/orders')}/${segment('2026/10/12/[$LATEST]ccc')}`

    const log = await core.openLog(source.id, path, { lastNLines: 3, timestamps: true })

    expect(log).toMatchObject({ view: 'log', of: 'logStream', path, name: segment('2026/10/12/[$LATEST]ccc'), offersPreviousLog: false, restarted: false })
    expect(log.content).toBe(
      [
        '2026-10-12T10:00:08.500Z Error: boom',
        '2026-10-12T10:00:08.500Z     at handler (index.js:1:1)',
        '2026-10-12T10:00:09.000Z END RequestId: 3'
      ].join('\n')
    )
    expect((await core.openLog(source.id, path, { lastNLines: 1 })).content).toBe('END RequestId: 3')
  })

  it('opens no log for a log group, and none for a stream that isn’t there', async () => {
    const { core, source } = await connected()

    await expect(core.openLog(source.id, segment('/aws/lambda/orders'))).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
    await expect(core.openLog(source.id, `${segment('/aws/lambda/orders')}/gone`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
