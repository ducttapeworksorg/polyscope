// What the screenshots show, all made up here: a folder of sample logs, and a stand-in Kubernetes API server with a
// small shop in namespace `shop`. Shared by the desktop app's screenshots (readme.spec.ts) and VS Code's (vscode.spec.ts).

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

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
