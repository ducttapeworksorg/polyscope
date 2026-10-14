// What the screenshots show, all made up here: a folder of sample logs, a stand-in Kubernetes API server with a small
// shop in namespace `shop`, a stand-in Azure storage account archiving its logs, and the same shop on a stand-in Docker
// engine, in stand-in CloudWatch Logs, and on a stand-in SSH server with a systemd journal. Shared by the desktop app's
// screenshots (readme.spec.ts) and VS Code's (vscode.spec.ts). The last three stand-ins are the core's own test ones,
// seeded here with the shop.

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { startTestCloudWatchEndpoint } from '../../src/main/core/cloudwatch-test-endpoint'
import { writeDockerConfig } from '../../src/main/core/docker-test-config'
import { startTestDockerEngine, type TestContainer } from '../../src/main/core/docker-test-engine'
import { argsOf } from '../../src/main/core/journal-test-host'
import { startTestSshServer, type TestCommand } from '../../src/main/core/ssh-test-server'

// ---- Sample logs ------------------------------------------------------------------------------------------------

const start = Date.parse('2026-09-29T09:14:02.113Z')
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString()
const stamp = (seconds: number) => at(seconds).replace('T', ' ').replace('Z', '')

const appLines = [
  'INFO  [main] c.s.checkout.Application - Starting checkout-api 2.14.1 on host api-01 (Java 21.0.4)',
  'INFO  [main] c.s.checkout.Application - Active profiles: staging',
  'DEBUG [main] c.s.checkout.config.DataSourceConfig - Pool checkout-db: max 20 connections, timeout 30s',
  'INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port 8080 (http)',
  'INFO  [main] c.s.checkout.Application - Started in 6.284 seconds',
  'INFO  [http-nio-8080-exec-1] c.s.checkout.CartController - GET /api/cart/5f2c user=u-18823 200 14ms',
  'INFO  [http-nio-8080-exec-3] c.s.checkout.OrderService - Order 48213 placed: 3 items, total 84.20 EUR',
  'WARN  [http-nio-8080-exec-4] c.s.checkout.PaymentClient - Payment gateway slow: 2312ms for authorize (threshold 1500ms)',
  'INFO  [http-nio-8080-exec-2] c.s.checkout.OrderService - Order 48214 placed: 1 item, total 19.99 EUR',
  'ERROR [http-nio-8080-exec-5] c.s.checkout.OrderService - Order 48215 failed: payment declined',
  'com.shop.checkout.payment.PaymentDeclinedException: card_declined (insufficient_funds)',
  '\tat com.shop.checkout.payment.PaymentClient.authorize(PaymentClient.java:118)',
  '\tat com.shop.checkout.OrderService.place(OrderService.java:74)',
  '\tat com.shop.checkout.CartController.checkout(CartController.java:52)',
  'INFO  [scheduling-1] c.s.checkout.StockSync - Synced 1,284 SKUs from inventory in 842ms',
  'DEBUG [http-nio-8080-exec-1] c.s.checkout.CartController - Cart 5f2c: applied voucher AUTUMN10',
  'WARN  [HikariPool-1 housekeeper] com.zaxxer.hikari.pool.HikariPool - checkout-db - Thread starvation or clock leap detected',
  'INFO  [http-nio-8080-exec-6] c.s.checkout.OrderService - Order 48216 placed: 2 items, total 42.50 EUR',
  'INFO  [http-nio-8080-exec-2] c.s.checkout.CartController - GET /api/cart/9a1e user=u-20117 200 11ms',
  'ERROR [http-nio-8080-exec-7] c.s.checkout.InventoryClient - Reserve failed for SKU 88-1204: 503 Service Unavailable, retrying in 500ms',
  'INFO  [http-nio-8080-exec-7] c.s.checkout.InventoryClient - Reserve succeeded for SKU 88-1204 after 1 retry',
  'INFO  [http-nio-8080-exec-3] c.s.checkout.OrderService - Order 48217 placed: 5 items, total 212.05 EUR',
  'INFO  [scheduling-1] c.s.checkout.StockSync - Synced 1,291 SKUs from inventory in 797ms'
]
const appLog = appLines.map((line, i) => (/^\s|^com\./.test(line) ? line : `${stamp(i * 7)} ${line}`)).join('\n') + '\n'

const accessLog =
  Array.from({ length: 40 }, (_, i) => {
    const paths = ['/api/cart/5f2c', '/api/orders', '/api/products?page=2', '/healthz', '/api/checkout']
    const codes = [200, 200, 201, 200, 200, 304, 404, 200, 500]
    return `10.42.0.${17 + (i % 9)} - - [29/Sep/2026:09:${String(14 + Math.floor(i / 6)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')} +0000] "${i % 3 ? 'GET' : 'POST'} ${paths[i % 5]} HTTP/1.1" ${codes[i % 9]} ${512 + ((i * 97) % 4000)} "-" "shop-web/3.2"`
  }).join('\n') + '\n'

const settingsYaml = `# checkout-api settings for staging
server:
  port: 8080
  shutdown: graceful
checkout:
  currency: EUR
  payment:
    gateway: https://payments.example.com
    timeout: 1500ms
    retries: 2
  inventory:
    reserve-timeout: 800ms
datasource:
  url: jdbc:postgresql://postgres-0.postgres:5432/checkout
  pool:
    max-size: 20
logging:
  level:
    root: INFO
    com.shop.checkout: DEBUG
`

/** A 2 MB log, over the 1 MB Large File threshold these screenshots set. */
const bigLog = () => {
  const levels = ['INFO ', 'INFO ', 'DEBUG', 'INFO ', 'WARN ', 'INFO ', 'INFO ', 'ERROR', 'INFO ', 'DEBUG']
  const messages = [
    'c.s.search.Indexer - Indexed batch of 500 products in 214ms',
    'c.s.search.QueryService - Query "winter jacket" returned 128 hits in 31ms',
    'c.s.search.Indexer - Batch checksum ok',
    'c.s.search.QueryService - Query "running shoes" returned 342 hits in 27ms',
    'c.s.search.Indexer - Shard 3 is 91% full',
    'c.s.search.QueryService - Query "gift card" returned 12 hits in 9ms',
    'c.s.search.Indexer - Refreshed index products-v7',
    'c.s.search.Indexer - Timeout writing to shard 2 after 5000ms',
    'c.s.search.QueryService - Query "backpack" returned 77 hits in 18ms',
    'c.s.search.Cache - Evicted 2,048 entries'
  ]
  return Array.from({ length: 20_000 }, (_, i) => `${stamp(i * 3)} ${levels[i % 10]} [worker-${i % 8}] ${messages[i % 10]}`).join('\n') + '\n'
}

export async function seedFolder(root: string) {
  await mkdir(join(root, 'checkout-api'), { recursive: true })
  await mkdir(join(root, 'search'), { recursive: true })
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'checkout-api', 'app.log'), appLog)
  await writeFile(join(root, 'checkout-api', 'access.log'), accessLog)
  await writeFile(join(root, 'checkout-api', 'app-2026-09-28.log.gz'), gzipSync(appLog))
  await writeFile(join(root, 'search', 'indexer.log'), bigLog())
  await writeFile(join(root, 'config', 'settings.yaml'), settingsYaml)
  await writeFile(join(root, 'config', 'features.json'), JSON.stringify({ newCheckout: true, vouchers: { enabled: true, maxPerOrder: 1 } }, null, 2) + '\n')
}

// ---- A stand-in Kubernetes API server ---------------------------------------------------------------------------

type Container = { name: string; restarts?: number; waiting?: string; completed?: boolean; sidecar?: boolean }

const owner = (kind: string, name: string) => ({ kind, name, uid: `${kind}/${name}`, controller: true })
const meta = (name: string, controller?: ReturnType<typeof owner>) => ({
  name,
  namespace: 'shop',
  uid: name,
  creationTimestamp: at(-86_400),
  ...(controller && { ownerReferences: [controller] })
})

function pod(name: string, controller: ReturnType<typeof owner>, containers: Container[], initContainers: Container[] = []) {
  const status = (c: Container) => ({
    name: c.name,
    image: `registry.example.com/shop/${c.name}:2.14.1`,
    imageID: '',
    ready: !c.waiting && !c.completed,
    started: !c.waiting && !c.completed,
    restartCount: c.restarts ?? 0,
    state: c.waiting
      ? { waiting: { reason: c.waiting } }
      : c.completed
        ? { terminated: { exitCode: 0, reason: 'Completed', finishedAt: at(-3_600) } }
        : { running: { startedAt: at(-7_200) } },
    ...(c.restarts && { lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: at(-40) } } })
  })
  const completed = containers.every((c) => c.completed)
  return {
    metadata: meta(name, controller),
    spec: {
      initContainers: initContainers.map((c) => ({ name: c.name, image: c.name, ...(c.sidecar && { restartPolicy: 'Always' }) })),
      containers: containers.map((c) => ({ name: c.name, image: c.name }))
    },
    status: {
      phase: completed ? 'Succeeded' : 'Running',
      initContainerStatuses: initContainers.map(status),
      containerStatuses: containers.map(status)
    }
  }
}

const web = owner('ReplicaSet', 'web-7d9f8c6b5')
const checkout = owner('ReplicaSet', 'checkout-5c6b9d7f4')
const postgres = owner('StatefulSet', 'postgres')
const fluentBit = owner('DaemonSet', 'fluent-bit')
const nightlyJob = owner('Job', 'nightly-report-29321120')
const proxy: Container = { name: 'envoy', sidecar: true }

const pods = [
  pod('checkout-5c6b9d7f4-7hx2m', checkout, [{ name: 'api' }], [proxy]),
  pod('checkout-5c6b9d7f4-xk2lp', checkout, [{ name: 'api', restarts: 6, waiting: 'CrashLoopBackOff' }], [proxy]),
  pod('web-7d9f8c6b5-2xkqp', web, [{ name: 'web' }]),
  pod('web-7d9f8c6b5-8mz4t', web, [{ name: 'web' }]),
  pod('web-7d9f8c6b5-q7wnd', web, [{ name: 'web' }]),
  pod('postgres-0', postgres, [{ name: 'postgres' }, { name: 'metrics' }]),
  pod('fluent-bit-8wq2n', fluentBit, [{ name: 'fluent-bit' }]),
  pod('nightly-report-29321120-4sfjv', nightlyJob, [{ name: 'report', completed: true }])
]

const deployment = (name: string, replicas: number, readyReplicas: number) => ({
  metadata: { ...meta(name), uid: `Deployment/${name}` },
  spec: { replicas, selector: {}, template: {} },
  status: { replicas, readyReplicas }
})

const listings: Record<string, unknown[]> = {
  '/api/v1/namespaces': [{ metadata: meta('default') }, { metadata: meta('shop') }, { metadata: meta('monitoring') }],
  '/api/v1/namespaces/shop/pods': pods,
  '/apis/apps/v1/namespaces/shop/deployments': [deployment('checkout', 2, 1), deployment('web', 3, 3)],
  '/apis/apps/v1/namespaces/shop/replicasets': [
    { metadata: { ...meta(web.name, owner('Deployment', 'web')), uid: web.uid } },
    { metadata: { ...meta(checkout.name, owner('Deployment', 'checkout')), uid: checkout.uid } }
  ],
  '/apis/apps/v1/namespaces/shop/statefulsets': [{ ...deployment('postgres', 1, 1), metadata: { ...meta('postgres'), uid: postgres.uid } }],
  '/apis/apps/v1/namespaces/shop/daemonsets': [
    { metadata: { ...meta('fluent-bit'), uid: fluentBit.uid }, spec: {}, status: { desiredNumberScheduled: 1, numberReady: 1 } }
  ],
  '/apis/batch/v1/namespaces/shop/cronjobs': [{ metadata: { ...meta('nightly-report'), uid: 'CronJob/nightly-report' }, spec: { schedule: '0 2 * * *' } }],
  '/apis/batch/v1/namespaces/shop/jobs': [{ metadata: { ...meta(nightlyJob.name, owner('CronJob', 'nightly-report')), uid: nightlyJob.uid }, spec: {} }]
}

/** When the logs end: the lines already logged come before it, those logged while followed after. */
const logged = Date.now()

/** A container's log: timestamped lines, the last one a few seconds before `logged`. */
function logOf(podName: string, container: string, previous: boolean): { time: string; text: string }[] {
  const lines: string[] =
    container === 'api' && (previous || podName.endsWith('xk2lp'))
      ? [
          'INFO  Starting checkout-api 2.14.1',
          'INFO  Active profiles: prod',
          'INFO  Connecting to postgres-0.postgres:5432/checkout',
          'WARN  Connection attempt 1 failed: connection refused, retrying in 2s',
          'WARN  Connection attempt 2 failed: connection refused, retrying in 4s',
          'ERROR Connection attempt 3 failed: FATAL: password authentication failed for user "checkout"',
          'ERROR Application run failed: could not open the checkout datasource',
          'ERROR Exiting with status 1'
        ]
      : container === 'api'
        ? [
            'INFO  Started checkout-api 2.14.1 in 5.912 seconds',
            'INFO  POST /api/checkout user=u-18823 201 184ms order=48213',
            'INFO  GET /api/cart/9a1e user=u-20117 200 11ms',
            'WARN  Payment gateway slow: 2312ms for authorize (threshold 1500ms)',
            'INFO  POST /api/checkout user=u-20117 201 2398ms order=48214',
            'ERROR Order 48215 failed: payment declined (card_declined)',
            'INFO  GET /api/cart/77b0 user=u-31002 200 9ms',
            'INFO  POST /api/checkout user=u-31002 201 203ms order=48216',
            'DEBUG Cache hit ratio 0.94 over the last minute',
            'INFO  GET /api/cart/5f2c user=u-18823 200 12ms'
          ]
        : container === 'envoy'
          ? ['[info] envoy initializing', '[info] listener 0.0.0.0:15001 ready', '[info] all clusters initialized']
          : container === 'postgres'
            ? [
                'LOG:  database system is ready to accept connections',
                'LOG:  checkpoint starting: time',
                'LOG:  checkpoint complete: wrote 1204 buffers (7.3%)',
                'FATAL:  password authentication failed for user "checkout"'
              ]
            : container === 'report'
              ? ['INFO  Building nightly sales report for 2026-09-28', 'INFO  1,942 orders, 118,340.55 EUR', 'INFO  Uploaded report-2026-09-28.csv', 'INFO  Done in 42s']
              : ['INFO  GET / 200 3ms', 'INFO  GET /static/app.js 304 1ms', 'INFO  GET /api/products?page=2 200 22ms', 'INFO  GET /healthz 200 0ms']
  return lines.map((text, i) => ({ time: new Date(logged - (lines.length - i) * 4_000).toISOString(), text }))
}

const followed = [
  'INFO  POST /api/checkout user=u-40211 201 176ms order=48217',
  'INFO  GET /api/cart/c3d9 user=u-40211 200 10ms',
  'WARN  Inventory reserve slow: 912ms for SKU 88-1204',
  'INFO  POST /api/checkout user=u-12888 201 231ms order=48218'
]

const json = (response: ServerResponse, body: unknown, status = 200) =>
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

/** Starts the stand-in API server, and writes a kubeconfig for it into `dir`: its context `prod-eu`, namespace `shop`. */
export async function startCluster(dir: string): Promise<{ kubeconfig: string; close(): Promise<void> }> {
  const cluster: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://cluster')
    const path = url.pathname
    if (path === '/api/v1/namespaces/shop') return json(response, { kind: 'Namespace', apiVersion: 'v1', metadata: meta('shop') })
    const log = /^\/api\/v1\/namespaces\/shop\/pods\/([^/]+)\/log$/.exec(path)
    if (log) {
      const lines = logOf(decodeURIComponent(log[1]!), url.searchParams.get('container') ?? '', url.searchParams.get('previous') === 'true')
      const stamped = url.searchParams.get('timestamps') === 'true'
      const text = (line: { time: string; text: string }) => `${stamped ? `${line.time} ` : ''}${line.text}\n`
      response.writeHead(200, { 'content-type': 'text/plain' })
      if (url.searchParams.get('follow') !== 'true') return response.end(lines.map(text).join(''))
      const since = url.searchParams.get('sinceTime')
      response.write(lines.filter((line) => !since || line.time > since).map(text).join(''))
      let next = 0
      const drip = setInterval(() => response.write(text({ time: new Date().toISOString(), text: followed[next++ % followed.length]! })), 600)
      response.on('close', () => clearInterval(drip))
      return
    }
    const listing = listings[path]
    if (listing) return json(response, { kind: 'List', apiVersion: 'v1', metadata: {}, items: listing })
    // One object read by name, from its listing.
    const slash = path.lastIndexOf('/')
    const found = (listings[path.slice(0, slash)] as { metadata: { name: string } }[] | undefined)?.find(
      (item) => item.metadata.name === decodeURIComponent(path.slice(slash + 1))
    )
    if (found) return json(response, found)
    json(response, { kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404, message: 'not found' }, 404)
  })
  await new Promise<void>((resolve) => cluster.listen(0, '127.0.0.1', resolve))
  const { port } = cluster.address() as AddressInfo
  const kubeconfig = join(dir, 'kubeconfig')
  await writeFile(
    kubeconfig,
    [
      'apiVersion: v1',
      'kind: Config',
      `clusters: [{ name: prod-eu, cluster: { server: 'http://127.0.0.1:${port}', insecure-skip-tls-verify: true } }]`,
      'users: [{ name: demo, user: { token: demo } }]',
      'contexts: [{ name: prod-eu, context: { cluster: prod-eu, user: demo, namespace: shop } }]',
      'current-context: prod-eu'
    ].join('\n')
  )
  return {
    kubeconfig,
    async close() {
      await new Promise((resolve) => cluster.close(resolve))
      cluster.closeAllConnections()
    }
  }
}

// ---- A stand-in Docker engine -----------------------------------------------------------------------------------

/** An RFC 3339 time with nanoseconds, as the engine timestamps log lines, `secondsAgo` before now. */
const engineTime = (secondsAgo: number) => new Date(logged - secondsAgo * 1000).toISOString().replace(/Z$/, '000000Z')

/** A container's log: `lines` to stdout, the last a few seconds ago. */
const dockerLog = (lines: string[]) => lines.map((text, i) => ({ stream: 'stdout' as const, time: engineTime((lines.length - i) * 4), text }))

const compose = (service: string, n = 1): Pick<TestContainer, 'name' | 'labels'> => ({
  name: `shop-${service}-${n}`,
  labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': service }
})

/**
 * Starts a stand-in Docker engine running the shop under Compose, with a Docker CLI config folder of no contexts, so the
 * default context reaches it through DOCKER_HOST.
 */
export async function startDockerEngine(): Promise<{ env: Record<string, string>; drip(): void; close(): Promise<void> }> {
  const engine = await startTestDockerEngine([
    { ...compose('web'), image: 'registry.example.com/shop/web:3.2.0', logs: dockerLog(logOf('web', 'web', false).map((l) => l.text)) },
    { ...compose('web', 2), image: 'registry.example.com/shop/web:3.2.0', logs: dockerLog(logOf('web', 'web', false).map((l) => l.text)) },
    {
      ...compose('checkout'),
      image: 'registry.example.com/shop/checkout-api:2.14.1',
      restartCount: 2,
      health: 'healthy',
      logs: dockerLog(logOf('checkout', 'api', false).map((l) => l.text))
    },
    {
      ...compose('postgres'),
      image: 'postgres:17',
      health: 'healthy',
      logs: dockerLog(logOf('postgres-0', 'postgres', false).map((l) => l.text))
    },
    { ...compose('redis'), image: 'redis:7.4', logs: dockerLog(['Ready to accept connections tcp']) },
    {
      ...compose('report'),
      image: 'registry.example.com/shop/report:1.4.0',
      state: 'exited',
      exitCode: 1,
      finishedAt: engineTime(600),
      logs: dockerLog(['INFO  Building nightly sales report for 2026-09-28', 'ERROR Could not reach postgres:5432: connection refused', 'ERROR Exiting with status 1'])
    },
    { name: 'registry', image: 'registry:2', logs: dockerLog(['level=info msg="listening on [::]:5000"']) }
  ])
  let dripping: NodeJS.Timeout | undefined
  return {
    env: { DOCKER_HOST: engine.host, DOCKER_CONTEXT: '', DOCKER_CONFIG: await writeDockerConfig() },
    /** Has the checkout service log new lines, for its log followed. */
    drip() {
      let next = 0
      dripping ??= setInterval(() => engine.log('shop-checkout-1', followed[next++ % followed.length]!), 600)
    },
    async close() {
      clearInterval(dripping)
      await engine.close()
    }
  }
}

// ---- Stand-in CloudWatch Logs -----------------------------------------------------------------------------------

/** One invocation of a Lambda function, as it logs it: its START, what it logged, its END and its REPORT. */
function invocation(at: number, request: string, lines: string[], duration: number) {
  const events = [`START RequestId: ${request} Version: $LATEST`, ...lines.map((line) => `${new Date(at).toISOString()}\t${request}\t${line}`)]
  events.push(`END RequestId: ${request}`, `REPORT RequestId: ${request}\tDuration: ${duration} ms\tBilled Duration: ${Math.ceil(duration)} ms\tMemory Size: 512 MB\tMax Memory Used: 141 MB`)
  return events.map((message, i) => ({ timestamp: at + i * 40, message }))
}

const lambdaStream = (instance: string) => `2026/10/13/[$LATEST]${instance}`

/** The orders Lambda's log: two instances taking turns with the orders. */
function ordersLog() {
  const orders = [
    ['INFO\tOrder 48213 accepted: 3 items, total 84.20 EUR'],
    ['INFO\tOrder 48214 accepted: 1 item, total 19.99 EUR', 'WARN\tPayment gateway slow: 2312ms for authorize'],
    ['ERROR\tOrder 48215 rejected: payment declined (card_declined)'],
    ['INFO\tOrder 48216 accepted: 2 items, total 42.50 EUR'],
    ['INFO\tOrder 48217 accepted: 5 items, total 212.05 EUR'],
    ['WARN\tInventory reserve slow: 912ms for SKU 88-1204', 'INFO\tOrder 48218 accepted: 1 item, total 9.90 EUR']
  ]
  const instances = ['0123abcd8e4f4b51a6c2d7e9f0a1b2c3', '4f5e6d7c1a2b4c3d8e9f0a1b2c3d4e5f']
  const streams = instances.map((instance) => ({ name: lambdaStream(instance), events: [] as { timestamp: number; message: string }[] }))
  orders.forEach((lines, i) => {
    const at = logged - (orders.length - i) * 9_000
    streams[i % 2]!.events.push(...invocation(at, `b7f3c0de-${4000 + i}-4a1e-9c2d-${String(i).padStart(12, '0')}`, lines, 180 + i * 37))
  })
  return streams
}

/** The checkout service's ECS log group: two tasks, each a stream, serving the orders between them. */
function checkoutTasks() {
  const lines = [...logOf('checkout-5c6b9d7f4-7hx2m', 'api', false), ...followed.map((text, i) => ({ time: new Date(logged - 3_000 + i * 700).toISOString(), text }))]
  return ['5c6b9d7f47b24e1a9c3d0e8f1a2b3c4d', 'a91e04c2d3f54b6c8d7e9f0a1b2c3d4e'].map((task, t) => ({
    name: `checkout/api/${task}`,
    events: lines.filter((_, i) => i % 2 === t).map(({ time, text }) => ({ timestamp: Date.parse(time), message: text }))
  }))
}

/**
 * Starts stand-in CloudWatch Logs, with the shop's log groups, and writes an AWS config into `dir` whose default
 * profile is in eu-west-1 and signs in with keys it takes.
 */
export async function startCloudWatch(dir: string): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const day = 86_400_000
  const endpoint = await startTestCloudWatchEndpoint(
    [
      { name: '/aws/lambda/orders-api', retentionDays: 30, storedBytes: 48_213_337, streams: ordersLog() },
      {
        name: '/aws/lambda/payments-webhook',
        retentionDays: 30,
        storedBytes: 9_120_448,
        streams: [{ name: lambdaStream('9a8b7c6d5e4f40312233445566778899'), events: invocation(logged - day, 'c1d2e3f4-0001', ['INFO\tWebhook charge.succeeded for order 48213'], 64) }]
      },
      {
        name: '/aws/apigateway/shop-api',
        retentionDays: 14,
        storedBytes: 120_034_112,
        streams: [{ name: 'f2a1c3e4d5b6a7980123456789abcdef', events: [{ timestamp: logged - 30_000, message: 'POST /orders 201 184ms' }] }]
      },
      { name: '/ecs/checkout', retentionDays: 90, storedBytes: 812_330_210, streams: checkoutTasks() }
    ],
    { accessKeyId: 'AKIAEXAMPLEDEMO' }
  )
  await writeFile(join(dir, 'aws-config'), '[default]\nregion = eu-west-1\n')
  await writeFile(join(dir, 'aws-credentials'), '[default]\naws_access_key_id = AKIAEXAMPLEDEMO\naws_secret_access_key = demo\n')
  return {
    env: {
      AWS_CONFIG_FILE: join(dir, 'aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws-credentials'),
      AWS_ENDPOINT_URL_CLOUDWATCH_LOGS: endpoint.url,
      AWS_PROFILE: '',
      AWS_REGION: '',
      AWS_DEFAULT_REGION: ''
    },
    close: () => endpoint.close()
  }
}

// ---- A stand-in server over SSH, with a systemd journal -----------------------------------------------------------

/** A systemd unit as `systemctl list-units --output=json` lists it. */
const unit = (name: string, active: string, sub: string, description: string) => ({ unit: name, load: 'loaded', active, sub, description })

const units = [
  unit('backup.service', 'failed', 'failed', 'Nightly database backup'),
  unit('checkout.service', 'active', 'running', 'Checkout API'),
  unit('nginx.service', 'active', 'running', 'A high performance web server and a reverse proxy server'),
  unit('postgresql.service', 'active', 'exited', 'PostgreSQL RDBMS'),
  unit('ssh.service', 'active', 'running', 'OpenBSD Secure Shell server'),
  unit('backup.timer', 'active', 'waiting', 'Run the nightly database backup'),
  unit('logrotate.service', 'inactive', 'dead', 'Rotate log files'),
  unit('logrotate.timer', 'active', 'waiting', 'Daily rotation of log files'),
  unit('certbot.timer', 'active', 'waiting', 'Run certbot twice daily')
]

/** The nightly backups: two that went well, then three failing to upload. */
function backupJournal() {
  const night = (daysAgo: number) => Date.parse('2026-10-13T02:00:00Z') - daysAgo * 86_400_000
  const entries: { at: number; message: string; priority: number }[] = []
  const run = (daysAgo: number, uploaded: boolean) => {
    const at = night(daysAgo)
    const log = (seconds: number, message: string, priority = 6) => entries.push({ at: at + seconds * 1000, message, priority })
    log(0, 'Starting backup.service - Nightly database backup...')
    log(1, 'pg_dump: dumping database "checkout"')
    log(38, `pg_dump: wrote checkout-2026-10-${String(13 - daysAgo).padStart(2, '0')}.sql.gz (1.8 GB)`)
    log(39, 'Uploading to s3://shop-backups/postgres/')
    if (uploaded) {
      log(71, 'Upload complete: 1.8 GB in 32s')
      log(71, 'backup.service: Deactivated successfully.')
      log(71, 'Finished backup.service - Nightly database backup.')
      return
    }
    log(69, 'upload failed: RequestTimeout: socket not read from or written to within the timeout', 3)
    log(69, 'backup.service: Main process exited, code=exited, status=1/FAILURE', 5)
    log(69, "backup.service: Failed with result 'exit-code'.", 4)
    log(69, 'Failed to start backup.service - Nightly database backup.', 3)
  }
  run(4, true)
  run(3, true)
  run(2, false)
  run(1, false)
  run(0, false)
  return entries
}

/** The checkout service's journal: started, restarted after a crash, then serving. */
function checkoutJournal() {
  const at = logged - 900_000
  return [
    { at, message: 'Started checkout.service - Checkout API.', priority: 6 },
    ...logOf('checkout-5c6b9d7f4-xk2lp', 'api', true).map((line, i) => ({ at: at + 2_000 + i * 1_500, message: line.text.replace(/^\w+\s+/, ''), priority: /^ERROR/.test(line.text) ? 3 : /^WARN/.test(line.text) ? 4 : 6 })),
    { at: at + 14_500, message: 'checkout.service: Main process exited, code=exited, status=1/FAILURE', priority: 5 },
    { at: at + 14_500, message: "checkout.service: Failed with result 'exit-code'.", priority: 4 },
    { at: at + 19_500, message: 'checkout.service: Scheduled restart job, restart counter is at 1.', priority: 6 },
    { at: at + 19_600, message: 'Started checkout.service - Checkout API.', priority: 6 },
    ...logOf('checkout-5c6b9d7f4-7hx2m', 'api', false).map((line, i) => ({ at: at + 22_000 + i * 30_000, message: line.text.replace(/^\w+\s+/, ''), priority: /^ERROR/.test(line.text) ? 3 : /^WARN/.test(line.text) ? 4 : /^DEBUG/.test(line.text) ? 7 : 6 }))
  ]
}

const journals: Record<string, { at: number; message: string; priority: number }[]> = {
  'backup.service': backupJournal(),
  'checkout.service': checkoutJournal(),
  'nginx.service': [{ at: logged - 86_400_000, message: 'Started nginx.service - A high performance web server and a reverse proxy server.', priority: 6 }],
  'postgresql.service': [{ at: logged - 86_400_000, message: 'Finished postgresql.service - PostgreSQL RDBMS.', priority: 6 }],
  'ssh.service': [{ at: logged - 3_600_000, message: 'Accepted publickey for deploy from 10.42.0.17 port 51234 ssh2: ED25519 SHA256:3q2+7w', priority: 6 }],
  'logrotate.service': [{ at: logged - 7_200_000, message: 'logrotate.service: Deactivated successfully.', priority: 6 }]
}

/** What `journalctl` and `systemctl` say on the stand-in server, for the commands the core runs. */
function journalCommand(command: string): TestCommand | undefined {
  const [name, ...args] = argsOf(command)
  if (name === 'systemctl') return { exitCode: 0, stdout: JSON.stringify(units) }
  if (name !== 'journalctl') return undefined
  if (args.includes('--field=_SYSTEMD_UNIT')) return { exitCode: 0, stdout: Object.keys(journals).join('\n') + '\n' }
  const unitName = args.find((arg) => arg.startsWith('--unit='))?.slice('--unit='.length)
  if (unitName === undefined) return { exitCode: 0, stdout: '' }
  const entries = journals[unitName] ?? []
  const json = ({ at, message, priority }: (typeof entries)[number]) =>
    `${JSON.stringify({ __REALTIME_TIMESTAMP: String(at * 1000), MESSAGE: message, PRIORITY: String(priority) })}\n`
  // A Follow: what's there, then nothing more until it's ended.
  if (args.includes('--follow')) return { run: () => undefined }
  const lines = args.find((arg) => arg.startsWith('--lines='))?.slice('--lines='.length)
  return { exitCode: 0, stdout: (lines === undefined || lines === 'all' ? entries : entries.slice(-Number(lines))).map(json).join('') }
}

/**
 * Starts a stand-in server, `web-01`, serving `/var/log` over SFTP and its systemd journal over exec, and writes a home
 * folder into `dir` whose `~/.ssh` knows it: its alias in `config`, its host key in `known_hosts`, and the key that
 * signs in to it.
 */
export async function startSshHost(dir: string): Promise<{ home: string; close(): Promise<void> }> {
  const server = await startTestSshServer({ exec: journalCommand })
  await seedFolder(join(server.root, 'opt', 'shop', 'logs'))
  const varLog = join(server.root, 'var', 'log')
  await mkdir(join(varLog, 'nginx'), { recursive: true })
  await mkdir(join(varLog, 'postgresql'), { recursive: true })
  await writeFile(join(varLog, 'nginx', 'access.log'), accessLog)
  await writeFile(join(varLog, 'nginx', 'access.log.1.gz'), gzipSync(accessLog))
  await writeFile(
    join(varLog, 'nginx', 'error.log'),
    '2026/09/29 09:15:44 [error] 812#812: *4471 upstream timed out (110: Connection timed out) while reading response header from upstream, client: 10.42.0.21, server: shop.example.com, request: "POST /api/checkout HTTP/1.1", upstream: "http://127.0.0.1:8080/api/checkout"\n'
  )
  await writeFile(join(varLog, 'postgresql', 'postgresql-17-main.log'), logOf('postgres-0', 'postgres', false).map((l) => `${l.time} ${l.text}`).join('\n') + '\n')
  await writeFile(join(varLog, 'syslog'), appLog)
  await writeFile(join(varLog, 'dpkg.log'), '2026-09-28 06:25:11 status installed nginx:amd64 1.26.2-1\n')

  const home = join(dir, 'home')
  const ssh = join(home, '.ssh')
  await mkdir(ssh, { recursive: true })
  await writeFile(join(ssh, 'id_ed25519'), server.clientKey, { mode: 0o600 })
  await writeFile(
    join(ssh, 'config'),
    `Host web-01\n  HostName ${server.host}\n  Port ${server.port}\n  User ${server.user}\n  IdentityFile ${join(ssh, 'id_ed25519')}\n`
  )
  await writeFile(join(ssh, 'known_hosts'), `[${server.host}]:${server.port} ${server.hostKey}\n`)
  return { home, close: () => server.close() }
}

// ---- A stand-in Azure storage account ---------------------------------------------------------------------------

/**
 * Starts a stand-in Azure storage account, `shoplogs`, with a container `archive` of the shop's gzipped logs by service
 * and day, answering just what an Azure Blob Storage Source asks: listing blobs, a blob's properties, and ranges of it.
 * It takes any signature. Gives the connection string that reaches it.
 */
export async function startAzureAccount(): Promise<{ account: string; container: string; connectionString: string; close(): Promise<void> }> {
  const account = 'shoplogs'
  const container = 'archive'
  const blobs = new Map<string, { body: Buffer; modified: Date }>()
  for (const [day, shift] of [['2026/09/27', 0], ['2026/09/28', 1], ['2026/09/29', 2]] as const) {
    const modified = new Date(Date.parse(`${day.replaceAll('/', '-')}T23:59:00Z`) + 61_000)
    blobs.set(`checkout-api/${day}/app.log.gz`, { body: gzipSync(appLog.replaceAll('2026-09-29', day.replaceAll('/', '-'))), modified })
    blobs.set(`checkout-api/${day}/access.log.gz`, { body: gzipSync(accessLog.replaceAll('29/Sep', `${27 + shift}/Sep`)), modified })
    blobs.set(`web/${day}/access.log.gz`, { body: gzipSync(accessLog.replaceAll('29/Sep', `${27 + shift}/Sep`)), modified })
    blobs.set(`search/${day}/indexer.log.gz`, { body: gzipSync(appLog), modified })
  }

  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const headers = (blob: { body: Buffer; modified: Date }) => ({
    'last-modified': blob.modified.toUTCString(),
    etag: `"0x${blob.modified.getTime().toString(16).toUpperCase()}"`,
    'x-ms-blob-type': 'BlockBlob',
    'content-type': 'application/gzip',
    'x-ms-version': '2025-01-05'
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://account')
    const [, , named, ...rest] = url.pathname.split('/')
    if (named !== container) return response.writeHead(404, { 'x-ms-error-code': 'ContainerNotFound' }).end()
    if (url.searchParams.get('comp') === 'list') {
      // One page of every blob under the prefix, folded at the delimiter into prefixes, as Azure lists them.
      const prefix = url.searchParams.get('prefix') ?? ''
      const delimiter = url.searchParams.get('delimiter')
      const prefixes = new Set<string>()
      const items: string[] = []
      for (const [name, blob] of [...blobs].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!name.startsWith(prefix)) continue
        const cut = delimiter ? name.indexOf(delimiter, prefix.length) : -1
        if (cut >= 0) prefixes.add(name.slice(0, cut + 1))
        else
          items.push(
            `<Blob><Name>${escape(name)}</Name><Properties><Last-Modified>${blob.modified.toUTCString()}</Last-Modified><Etag>0x1</Etag>` +
              `<Content-Length>${blob.body.length}</Content-Length><Content-Type>application/gzip</Content-Type><BlobType>BlockBlob</BlobType></Properties><Metadata /></Blob>`
          )
      }
      const body =
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://${request.headers.host}/${account}/" ContainerName="${container}">` +
        `<Prefix>${escape(prefix)}</Prefix>${delimiter ? `<Delimiter>${escape(delimiter)}</Delimiter>` : ''}<Blobs>` +
        [...prefixes].map((name) => `<BlobPrefix><Name>${escape(name)}</Name></BlobPrefix>`).join('') +
        `${items.join('')}</Blobs><NextMarker /></EnumerationResults>`
      return response.writeHead(200, { 'content-type': 'application/xml', 'x-ms-version': '2025-01-05' }).end(body)
    }
    const blob = blobs.get(decodeURIComponent(rest.join('/')))
    if (!blob) return response.writeHead(404, { 'x-ms-error-code': 'BlobNotFound', 'x-ms-version': '2025-01-05' }).end()
    if (request.method === 'HEAD') return response.writeHead(200, { ...headers(blob), 'content-length': blob.body.length }).end()
    const range = /bytes=(\d+)-(\d*)/.exec(String(request.headers['x-ms-range'] ?? request.headers['range'] ?? ''))
    if (!range) return response.writeHead(200, { ...headers(blob), 'content-length': blob.body.length }).end(blob.body)
    const start = Number(range[1])
    if (start >= blob.body.length) return response.writeHead(416, { 'x-ms-error-code': 'InvalidRange', 'x-ms-version': '2025-01-05' }).end()
    const end = Math.min(range[2] ? Number(range[2]) : blob.body.length - 1, blob.body.length - 1)
    response
      .writeHead(206, { ...headers(blob), 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${blob.body.length}` })
      .end(blob.body.subarray(start, end + 1))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    account,
    container,
    connectionString: `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${Buffer.from('demo').toString('base64')};BlobEndpoint=http://127.0.0.1:${port}/${account};`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
    }
  }
}
