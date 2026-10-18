import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { FollowEvent, NewCloudWatchLogsSource, TreeNode } from '@shared/core-api'
import { cloudWatchFollowTiming } from './cloudwatch-log-source'
import { allowedCloudWatchOperations, startTestCloudWatchEndpoint, type TestCloudWatchEndpoint, type TestLogGroup } from './cloudwatch-test-endpoint'
import { ssoProfiles } from './aws-test-sso'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { ignoreAmbientProxy, startProxy, startTlsFront } from './test-network'
import { cloudWatchNameOf, cloudWatchSegment as segment } from '@shared/core-api'

let dir: string
let endpoint: TestCloudWatchEndpoint | undefined

beforeEach(async () => {
  ignoreAmbientProxy()
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
      endpoint: '',
      caBundlePath: '',
      proxyUrl: ''
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

  it.each(['expired', 'signed-out'])('tells you to run aws sso login when the %s profile’s SSO session has ended', async (profile) => {
    vi.stubEnv('HOME', dir)
    await awsFiles({ config: await ssoProfiles(dir) })
    const core = createCore()
    const source = await core.addSource(settings({ auth: 'profile', profile }))

    const ssoLogin = { code: 'AWS_SSO_LOGIN_REQUIRED', message: expect.stringContaining(`aws sso login --profile ${profile}`) }
    await expect(core.testConnection(settings({ auth: 'profile', profile }))).rejects.toMatchObject(ssoLogin)
    await expect(core.connect(source.id)).rejects.toMatchObject(ssoLogin)
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'AWS_SSO_LOGIN_REQUIRED' })
  })
})

describe('a CloudWatch Logs Source’s endpoint, trust and proxy settings', () => {
  it('are normalised', async () => {
    const added = await createCore().addSource(settings({ endpoint: 'logs.us-gov-west-1.amazonaws.com/', caBundlePath: ' /etc/ssl/corp.pem ', proxyUrl: ' proxy.corp:3128/ ' }))

    expect(added).toMatchObject({ endpoint: 'https://logs.us-gov-west-1.amazonaws.com', caBundlePath: '/etc/ssl/corp.pem', proxyUrl: 'http://proxy.corp:3128' })
  })

  it.each(['socks5://proxy.corp:1080', 'http://'])('refuse a proxy that isn’t an http(s) address: %s', async (proxyUrl) => {
    await expect(createCore().addSource(settings({ proxyUrl }))).rejects.toMatchObject({ code: 'INVALID_PROXY' })
  })

  it('take their defaults for a Source saved before they existed', async () => {
    const dataDir = join(dir, 'user-data')
    await mkdir(dataDir)
    const saved = { id: 'old', type: 'cloudwatchLogs', name: 'Old', region: 'eu-west-1', prefix: '', auth: 'profile', accessKeyId: '', profile: '', endpoint: '' }
    await writeFile(join(dataDir, 'sources.json'), JSON.stringify({ version: 1, sources: [saved], groupOrder: ['local', 'cloudwatchLogs'] }))

    const [source] = await createCore({ dataDir }).listSources()

    expect(source).toMatchObject({ caBundlePath: '', proxyUrl: '' })
  })

  it('keep a Source from connecting when its CA bundle can’t be read, or holds no certificates', async () => {
    const empty = join(dir, 'empty.pem')
    await writeFile(empty, 'not a certificate\n')
    const core = createCore()
    const missing = await core.addSource(settings({ caBundlePath: join(dir, 'missing.pem') }))
    const notCertificates = await core.addSource(settings({ caBundlePath: empty }))

    await expect(core.connect(missing.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
    await expect(core.connect(notCertificates.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
    await expect(core.testConnection(settings({ caBundlePath: empty }))).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
  })

  describe('in a corporate network', () => {
    const disposals: (() => Promise<void>)[] = []
    afterEach(async () => {
      for (const dispose of disposals.splice(0).reverse()) await dispose()
    })

    /**
     * The stand-in endpoint behind TLS, with a certificate from a private CA, as at a VPC endpoint behind TLS
     * inspection: its `endpoint` there, a `caBundlePath` that trusts it, and the front's `host` (and port), as a proxy is
     * asked to tunnel to it.
     */
    const behindTls = async () => {
      const { url } = await endpointWith()
      const front = await startTlsFront(url)
      disposals.push(front.close)
      return { endpoint: front.url, caBundlePath: front.caPath, host: new URL(front.url).host }
    }
    const proxy = async () => {
      const started = await startProxy()
      disposals.push(started.close)
      return started
    }
    const connects = async (changes: Partial<NewCloudWatchLogsSource>) => {
      const core = createCore()
      const source = await core.addSource(settings(changes))
      const root = names(await core.connect(source.id))
      await core.disconnect(source.id)
      return root.slice(0, 2)
    }
    const listed = ['/aws/lambda/orders', '/batch/job-00']

    it('refuses a certificate from an unknown CA', async () => {
      const { endpoint } = await behindTls()

      await expect(createCore().testConnection(settings({ endpoint }))).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
    })

    it('reaches the endpoint it’s given, trusting a certificate from the CA bundle', async () => {
      const { endpoint, caBundlePath } = await behindTls()

      expect(await connects({ endpoint, caBundlePath })).toEqual(listed)
    })

    it('goes through its own proxy, whatever NO_PROXY says', async () => {
      vi.stubEnv('NO_PROXY', '*')
      const { url, tunnels } = await proxy()
      const { endpoint, caBundlePath, host } = await behindTls()

      expect(await connects({ endpoint, caBundlePath, proxyUrl: url })).toEqual(listed)
      expect(tunnels).toContain(host)
    })

    it('goes through HTTPS_PROXY without a proxy of its own', async () => {
      const { url, tunnels } = await proxy()
      vi.stubEnv('HTTPS_PROXY', url)
      vi.stubEnv('NO_PROXY', undefined)
      const { endpoint, caBundlePath, host } = await behindTls()

      expect(await connects({ endpoint, caBundlePath })).toEqual(listed)
      expect(tunnels).toContain(host)
    })

    it('goes straight to hosts NO_PROXY lists', async () => {
      const { url, tunnels } = await proxy()
      vi.stubEnv('HTTPS_PROXY', url)
      vi.stubEnv('NO_PROXY', '127.0.0.1')
      const { endpoint, caBundlePath } = await behindTls()

      expect(await connects({ endpoint, caBundlePath })).toEqual(listed)
      expect(tunnels).toEqual([])
    })
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
        kind: 'logStream',
        name: segment('/aws/lambda/orders'),
        path: segment('/aws/lambda/orders'),
        hasChildren: true,
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

  it('opens no log for a log group or stream that isn’t there', async () => {
    const { core, source } = await connected()

    await expect(core.openLog(source.id, segment('/aws/lambda/gone'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(core.openLog(source.id, `${segment('/aws/lambda/orders')}/gone`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('a CloudWatch Logs Source whose IAM policy is missing a permission', () => {
  const orders = segment('/aws/lambda/orders')

  it('names the action it needs to list log groups', async () => {
    const { denied } = await endpointWith()
    denied.add('DescribeLogGroups')
    const core = createCore()
    const source = await core.addSource(settings())

    await expect(core.testConnection(settings())).rejects.toMatchObject({ code: 'MISSING_PERMISSION', message: expect.stringMatching(/^logs:DescribeLogGroups\b/) })
    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'MISSING_PERMISSION', message: expect.stringMatching(/^logs:DescribeLogGroups\b/) })
  })

  it('names the action it needs to list a log group’s streams', async () => {
    const { denied } = await endpointWith()
    denied.add('DescribeLogStreams')
    const core = createCore()
    const source = await core.addSource(settings())
    await core.connect(source.id)

    expect(await core.expand(source.id, orders)).toMatchObject([{ kind: 'error', code: 'MISSING_PERMISSION', message: expect.stringMatching(/^logs:DescribeLogStreams\b/) }])
  })

  it('names the action it needs to read a log group, or a stream', async () => {
    const { denied } = await endpointWith()
    denied.add('FilterLogEvents').add('GetLogEvents')
    const core = createCore()
    const source = await core.addSource(settings())
    await core.connect(source.id)

    await expect(core.openLog(source.id, orders, { lastNLines: 10 })).rejects.toMatchObject({ code: 'MISSING_PERMISSION', message: expect.stringMatching(/^logs:FilterLogEvents\b/) })
    await expect(core.openLog(source.id, `${orders}/${segment('2026/10/12/[$LATEST]aaa')}`, { lastNLines: 10 })).rejects.toMatchObject({
      code: 'MISSING_PERMISSION',
      message: expect.stringMatching(/^logs:GetLogEvents\b/)
    })
  })
})

describe('a CloudWatch log group opened as one merged log', () => {
  const orders = segment('/aws/lambda/orders')

  beforeEach(() => {
    // The newest window read back from ends now: a minute after the seeded events.
    vi.useFakeTimers({ toFake: ['Date'], now: at(60_000) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connected(groups?: TestLogGroup[]) {
    await endpointWith(groups)
    const core = createCore()
    const source = await core.addSource(settings())
    await core.connect(source.id)
    return { core, source }
  }

  it('interleaves its streams’ events by time, each line starting with a short form of its stream’s name', async () => {
    const { core, source } = await connected()

    const log = await core.openLog(source.id, orders, { lastNLines: 10, timestamps: true })

    expect(log).toMatchObject({ view: 'log', of: 'logStream', path: orders, name: orders, offersPreviousLog: false })
    expect(log.content).toBe(
      [
        '2026-10-12T10:00:01.000Z [aaa] START RequestId: 1',
        '2026-10-12T10:00:05.000Z [bbb] START RequestId: 2',
        '2026-10-12T10:00:08.000Z [ccc] START RequestId: 3',
        '2026-10-12T10:00:08.500Z [ccc] Error: boom',
        '2026-10-12T10:00:08.500Z [ccc]     at handler (index.js:1:1)',
        '2026-10-12T10:00:09.000Z [ccc] END RequestId: 3'
      ].join('\n')
    )
    expect(log.earlier).toBeUndefined()
    expect((await core.openLog(source.id, orders, { lastNLines: 2 })).content).toBe('[ccc]     at handler (index.js:1:1)\n[ccc] END RequestId: 3')
  })

  it('keeps a JSON event on one line, and shortens an ECS task’s stream name to the start of its task id', async () => {
    const { core, source } = await connected([
      {
        name: '/ecs/shop',
        streams: [{ name: 'web/web/0123456789abcdef0123456789abcdef', events: [{ timestamp: at(0), message: '{"level":"info","msg":"listening"}\n' }] }]
      }
    ])

    expect((await core.openLog(source.id, segment('/ecs/shop'))).content).toBe('[01234567] {"level":"info","msg":"listening"}')
  })

  it('widens the window it reads back over until it has the lines asked for, in a sparse group', async () => {
    const day = 24 * 60 * 60 * 1_000
    const events = [at(-300 * day), at(-40 * day), at(-2 * day), at(-day), at(-60_000), at(0)].map((timestamp, i) => ({ timestamp, message: `event ${i + 1}` }))
    const { core, source } = await connected([{ name: 'sparse', createdAt: at(-400 * day), streams: [{ name: 'only', events }] }])

    expect((await core.openLog(source.id, 'sparse', { lastNLines: 3 })).content).toBe('[only] event 4\n[only] event 5\n[only] event 6')
    expect((await core.openLog(source.id, 'sparse', { lastNLines: 5 })).content).toBe(
      ['event 2', 'event 3', 'event 4', 'event 5', 'event 6'].map((line) => `[only] ${line}`).join('\n')
    )
  })

  it('stops widening at the group’s start, finding events logged before the group was made', async () => {
    const day = 24 * 60 * 60 * 1_000
    const { core, source } = await connected([
      { name: 'backfilled', createdAt: at(-day), streams: [{ name: 'only', events: [{ timestamp: at(-10 * day), message: 'backfilled' }] }] },
      { name: 'empty', createdAt: at(-day), streams: [{ name: 'quiet' }] }
    ])
    endpoint!.operations.length = 0

    const log = await core.openLog(source.id, 'backfilled', { lastNLines: 1_000 })
    expect(log.content).toBe('[only] backfilled')
    expect(log.earlier).toBeUndefined()
    expect((await core.openLog(source.id, 'empty')).content).toBe('')
    expect(endpoint!.operations.filter((operation) => operation === 'FilterLogEvents').length).toBeLessThan(30)
  })

  it('reads the last lines of a busy group without reading back through all of it', async () => {
    const events = Array.from({ length: 30_000 }, (_, i) => ({ timestamp: at(i), message: `event ${i + 1}` }))
    const { core, source } = await connected([{ name: 'busy', streams: [{ name: 'only', events }] }])
    endpoint!.operations.length = 0

    expect((await core.openLog(source.id, 'busy', { lastNLines: 2 })).content).toBe('[only] event 29999\n[only] event 30000')
    expect(endpoint!.operations.filter((operation) => operation === 'FilterLogEvents').length).toBeLessThan(30)
  })
})

describe('following CloudWatch logs', () => {
  const orders = segment('/aws/lambda/orders')
  const ccc = `${orders}/${segment('2026/10/12/[$LATEST]ccc')}`
  const shop = `${segment('/ecs/shop')}/${segment('web/web/0123')}`

  beforeEach(() => {
    const { interval, maxInterval } = cloudWatchFollowTiming
    Object.assign(cloudWatchFollowTiming, { interval: 100, maxInterval: 800 })
    onTestFinished(() => void Object.assign(cloudWatchFollowTiming, { interval, maxInterval }))
  })

  async function connected() {
    await endpointWith()
    const core = createCore()
    const source = await core.addSource(settings())
    await core.connect(source.id)
    const events: FollowEvent[] = []
    onTestFinished(core.onFollowEvent((event) => void events.push(event)))
    const linesOf = (followId: string) => events.flatMap((event) => (event.followId === followId && event.kind === 'lines' ? event.lines : []))
    return { core, source, events, linesOf }
  }

  const groups = () => endpoint!.groups
  const log = (group: number, stream: number, message: string, timestamp = at(30_000)) => groups()[group]!.streams![stream]!.events!.push({ timestamp, message })
  /** The calls Following made, after the first `from`. */
  const pollsSince = (from: number) => endpoint!.calls.slice(from).filter(({ operation }) => operation === 'GetLogEvents' || operation === 'FilterLogEvents')
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('goes on from its merged log’s last line, picking up events of a stream made since', async () => {
    const { core, source, linesOf } = await connected()

    const followed = await core.followLog(source.id, orders, { lastNLines: 1 })
    groups()[0]!.streams!.push({ name: '2026/10/12/[$LATEST]ddd', events: [{ timestamp: at(9_000), message: 'START RequestId: 4' }] })

    expect(followed.content).toBe('[ccc] END RequestId: 3')
    await vi.waitFor(() => expect(linesOf(followed.followId)).toEqual(['[ddd] START RequestId: 4']), { timeout: 5_000 })
    await core.disconnect(source.id)
  })

  it('shows a stream’s new events as they come', async () => {
    const { core, source, linesOf } = await connected()

    const followed = await core.followLog(source.id, ccc, { lastNLines: 1 })
    log(0, 1, 'START RequestId: 5')

    expect(followed.content).toBe('END RequestId: 3')
    await vi.waitFor(() => expect(linesOf(followed.followId)).toEqual(['START RequestId: 5']), { timeout: 5_000 })
    await core.disconnect(source.id)
  })

  it('asks for all of a Source’s Followed logs on one schedule, one call per log each round', async () => {
    const { core, source } = await connected()

    await core.followLog(source.id, orders, { lastNLines: 1 })
    await pause(150)
    await core.followLog(source.id, shop, { lastNLines: 1 })
    const from = endpoint!.calls.length
    await pause(1_000)

    // Rounds are told apart by the time between them; each asks once for the group, once for the stream.
    const rounds: string[][] = []
    let last = -Infinity
    for (const { operation, at } of pollsSince(from)) {
      if (at - last > 50) rounds.push([])
      rounds.at(-1)!.push(operation)
      last = at
    }
    expect(rounds.length).toBeGreaterThanOrEqual(5)
    for (const round of rounds.slice(0, -1)) expect(round.toSorted()).toEqual(['FilterLogEvents', 'GetLogEvents'])
    await core.disconnect(source.id)
  })

  it('slows down while AWS throttles it, saying so, and catches up once it stops', async () => {
    const { core, source, events, linesOf } = await connected()
    const followed = await core.followLog(source.id, ccc, { lastNLines: 1 })
    const slowed = () => events.filter((event) => event.followId === followed.followId && event.kind === 'slowed')

    endpoint!.throttling = true
    const from = endpoint!.calls.length
    await vi.waitFor(() => expect(slowed()).toEqual([{ followId: followed.followId, kind: 'slowed', slowed: true }]))
    await pause(1_600)
    const times = pollsSince(from).map(({ at }) => at)
    const gaps = times.slice(1).map((time, i) => time - times[i]!)
    // Twice as long each time, up to the ceiling: 200, 400, 800, 800 ms.
    expect(gaps.length).toBeLessThanOrEqual(5)
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(700)

    log(0, 1, 'START RequestId: 5')
    endpoint!.throttling = false
    await vi.waitFor(() => expect(linesOf(followed.followId)).toEqual(['START RequestId: 5']), { timeout: 3_000 })
    expect(slowed().map((event) => event.kind === 'slowed' && event.slowed)).toEqual([true, false])
    expect(events.filter((event) => event.kind === 'failed')).toEqual([])
    await core.disconnect(source.id)
  })

  it('holds new events back while paused, and shows them once resumed', async () => {
    const { core, source, linesOf } = await connected()
    const followed = await core.followLog(source.id, ccc, { lastNLines: 1 })

    await core.pauseFollow(followed.followId)
    log(0, 1, 'START RequestId: 5')
    await pause(400)
    expect(linesOf(followed.followId)).toEqual([])
    await core.resumeFollow(followed.followId)

    expect(linesOf(followed.followId)).toEqual(['START RequestId: 5'])
    await core.disconnect(source.id)
  })

  it('ends, its log gone, once its log group is deleted, while another goes on', async () => {
    const { core, source, events, linesOf } = await connected()
    const followed = await core.followLog(source.id, orders, { lastNLines: 1 })
    const other = await core.followLog(source.id, shop, { lastNLines: 1 })

    groups().splice(0, 1)
    await vi.waitFor(() => expect(events).toContainEqual({ followId: followed.followId, kind: 'ended', reason: 'gone' }))
    log(0, 0, 'still here')

    await vi.waitFor(() => expect(linesOf(other.followId)).toEqual(['still here']))
    await core.disconnect(source.id)
  })

  it('stops asking once its Source is disconnected', async () => {
    const { core, source, events } = await connected()
    const followed = await core.followLog(source.id, orders, { lastNLines: 1 })
    await core.followLog(source.id, shop, { lastNLines: 1 })
    await pause(250)

    await core.disconnect(source.id)
    const from = endpoint!.calls.length
    await pause(500)

    expect(pollsSince(from)).toEqual([])
    expect(events).toContainEqual({ followId: followed.followId, kind: 'ended', reason: 'disconnected' })
  })
})

describe('loading further back in a CloudWatch log', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: at(60_000) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connected(groups?: TestLogGroup[]) {
    await endpointWith(groups)
    const core = createCore()
    const source = await core.addSource(settings())
    await core.connect(source.id)
    return { core, source }
  }

  /** Every line of a log, loading further back `count` lines at a time until there's nothing more. */
  async function allOf(core: ReturnType<typeof createCore>, sourceId: string, path: string, count: number, timestamps = false) {
    const log = await core.openLog(sourceId, path, { lastNLines: count, timestamps })
    const pages = [log.content]
    for (let earlier = log.earlier; earlier !== undefined; ) {
      const back = await core.readEarlierLog(sourceId, path, { earlier, lines: count, timestamps })
      expect(back.content.split('\n').length).toBeLessThanOrEqual(count)
      pages.unshift(back.content)
      earlier = back.earlier
    }
    return pages.join('\n')
  }

  it('reads a group’s lines before those shown, splitting a multi-line event where they started', async () => {
    const { core, source } = await connected()
    const orders = segment('/aws/lambda/orders')

    const log = await core.openLog(source.id, orders, { lastNLines: 2 })
    const back = await core.readEarlierLog(source.id, orders, { earlier: log.earlier!, lines: 2 })

    expect(back.content).toBe('[ccc] START RequestId: 3\n[ccc] Error: boom')
    expect(await allOf(core, source.id, orders, 2)).toBe(
      ['[aaa] START RequestId: 1', '[bbb] START RequestId: 2', '[ccc] START RequestId: 3', '[ccc] Error: boom', '[ccc]     at handler (index.js:1:1)', '[ccc] END RequestId: 3'].join('\n')
    )
  })

  it('reads a stream’s lines before those shown, with their timestamps if shown', async () => {
    const { core, source } = await connected()
    const path = `${segment('/aws/lambda/orders')}/${segment('2026/10/12/[$LATEST]ccc')}`

    const log = await core.openLog(source.id, path, { lastNLines: 3, timestamps: true })
    const back = await core.readEarlierLog(source.id, path, { earlier: log.earlier!, lines: 3, timestamps: true })

    expect(back).toEqual({ content: '2026-10-12T10:00:08.000Z START RequestId: 3' })
  })

  it('loses no line and repeats none among many logged at the same time, in a group or a stream', async () => {
    const tied = (stream: string) => Array.from({ length: 7 }, (_, i) => ({ timestamp: at(i < 5 ? 1_000 : 2_000), message: `${stream} ${i + 1}` }))
    const { core, source } = await connected([{ name: 'tied', streams: [{ name: 'a', events: tied('a') }, { name: 'b', events: tied('b') }] }])

    const group = await allOf(core, source.id, 'tied', 3)
    expect(group.split('\n').toSorted()).toEqual([...tied('a'), ...tied('b')].map(({ message }) => `[${message[0]}] ${message}`).toSorted())
    expect(await allOf(core, source.id, 'tied/a', 2)).toBe(tied('a').map(({ message }) => message).join('\n'))
  })

  it('loses no line and repeats none among lines logged a millisecond apart', async () => {
    const events = [1_000, 1_000, 1_001, 1_001, 1_002].map((ms, i) => ({ timestamp: at(ms), message: `event ${i + 1}` }))
    const { core, source } = await connected([{ name: 'close', streams: [{ name: 'only', events }] }])

    for (const count of [1, 2, 3, 4]) {
      expect(await allOf(core, source.id, 'close', count), `${count} at a time`).toBe(events.map(({ message }) => `[only] ${message}`).join('\n'))
    }
  })

  it('repeats no line logged just as one window it reads back over starts and the next ends', async () => {
    const edge = at(60_000) - 15 * 60_000
    const events = [edge - 1, edge, edge, edge + 1].map((timestamp, i) => ({ timestamp, message: `event ${i + 1}` }))
    const { core, source } = await connected([{ name: 'edge', createdAt: at(-60 * 60_000), streams: [{ name: 'only', events }] }])

    expect((await core.openLog(source.id, 'edge', { lastNLines: 10 })).content).toBe(events.map(({ message }) => `[only] ${message}`).join('\n'))
  })

  it('reads further back in a sparse group, as far as its start', async () => {
    const day = 24 * 60 * 60 * 1_000
    const events = [at(-300 * day), at(-40 * day), at(-2 * day), at(-day), at(0)].map((timestamp, i) => ({ timestamp, message: `event ${i + 1}` }))
    const { core, source } = await connected([{ name: 'sparse', createdAt: at(-400 * day), streams: [{ name: 'only', events }] }])

    expect(await allOf(core, source.id, 'sparse', 2)).toBe(events.map(({ message }) => `[only] ${message}`).join('\n'))
  })

  it('has nothing further back to read when all of a log is shown', async () => {
    const { core, source } = await connected()

    expect((await core.openLog(source.id, segment('/ecs/shop'), { lastNLines: 'all' })).earlier).toBeUndefined()
  })
})
