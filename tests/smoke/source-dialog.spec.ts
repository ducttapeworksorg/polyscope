import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let dir: string
let app: ElectronApplication
let cluster: Server

const named = (name: string, spec?: unknown) => ({ metadata: { name }, ...(spec !== undefined && { spec }) })
const mounting = (...mountPaths: string[]) => ({
  selector: {},
  template: { spec: { containers: [{ name: 'app', image: 'app', volumeMounts: mountPaths.map((mountPath, i) => ({ name: `v${i}`, mountPath })) }] } }
})

/** Just enough of a Kubernetes API for the Source dialog's suggestions: its namespaces, and Workloads in `shop`. */
const listings: Record<string, unknown[]> = {
  '/api/v1/namespaces': [named('default'), named('shop'), named('staging')],
  '/apis/apps/v1/namespaces/shop/deployments': [named('web', mounting('/var/log/app', '/data'))],
  '/apis/apps/v1/namespaces/shop/statefulsets': [named('db', mounting('/var/lib/db'))],
  '/apis/apps/v1/namespaces/shop/daemonsets': []
}

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  cluster = createServer((request, response) => {
    const items = listings[new URL(request.url!, 'http://cluster').pathname] ?? []
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items }))
  })
  await new Promise<void>((resolve) => cluster.listen(0, '127.0.0.1', resolve))
  const { port } = cluster.address() as AddressInfo
  const kubeconfig = join(dir, 'kubeconfig')
  await writeFile(
    kubeconfig,
    [
      'apiVersion: v1',
      'kind: Config',
      `clusters: [{ name: fake, cluster: { server: 'http://127.0.0.1:${port}', insecure-skip-tls-verify: true } }]`,
      'users: [{ name: fake, user: { token: fake } }]',
      'contexts: [{ name: fake, context: { cluster: fake, user: fake, namespace: shop } }]',
      'current-context: fake'
    ].join('\n')
  )
  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`],
    env: { ...process.env, KUBECONFIG: kubeconfig }
  })
})

test.afterEach(async () => {
  await app.close()
  await new Promise((resolve) => cluster.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

async function openAddSource(window: Page, type: string) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption(type)
  return dialog
}

test('suggest every namespace, Workload and mount path, whatever is typed already', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddSource(window, 'kubernetesFiles')
  const options = dialog.getByRole('listbox').getByRole('option')

  // Filled in from the context, the namespace still shows every other choice when opened.
  const namespace = dialog.getByRole('combobox', { name: 'Namespace' })
  await expect(namespace).toHaveValue('shop')
  await namespace.click()
  await expect(options).toHaveText(['default', 'shop', 'staging'])

  // Typing narrows them; Escape closes the list but not the dialog.
  await namespace.fill('sta')
  await expect(options).toHaveText(['staging'])
  await namespace.press('Escape')
  await expect(dialog.getByRole('listbox')).toBeHidden()
  await expect(dialog).toBeVisible()

  // Opened again, all of them are back; the arrows and Enter pick one.
  await dialog.getByRole('button', { name: 'Show suggestions' }).first().click()
  await expect(options).toHaveText(['default', 'shop', 'staging'])
  await namespace.press('ArrowDown')
  await namespace.press('Enter')
  await expect(namespace).toHaveValue('default')
  await namespace.fill('shop')
  await namespace.press('Escape')

  // Every kind of Workload is in the one dropdown.
  const workload = dialog.getByLabel('Workload', { exact: true })
  await expect(workload.locator('optgroup')).toHaveCount(2)
  await workload.selectOption('Deployment/web')

  // The path suggests where the chosen Workload's volumes are mounted, all of them even once one is picked.
  const path = dialog.getByRole('combobox', { name: 'Path' })
  await path.click()
  await expect(options).toHaveText(['/data', '/var/log/app'])
  await options.filter({ hasText: '/var/log/app' }).click()
  await expect(path).toHaveValue('/var/log/app')
  await path.click()
  await expect(options).toHaveText(['/data', '/var/log/app'])
  await path.press('Escape')

  await workload.selectOption('StatefulSet/db')
  await path.click()
  await expect(options).toHaveText(['/var/lib/db'])
})

test('new S3 Sources use path-style addressing', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddSource(window, 's3')

  await expect(dialog.getByLabel('Path-style addressing')).toBeChecked()
})

test('warn that secret keys are only obfuscated when no keyring is running', async () => {
  const weak = 'No keyring (GNOME Keyring or KWallet) is running'
  if (process.platform === 'linux') {
    // Chromium's basic password store is the fallback it picks when there's no keyring.
    await app.close()
    app = await electron.launch({
      args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`, '--password-store=basic']
    })
  }
  const window = await app.firstWindow()
  const dialog = await openAddSource(window, 's3')

  await expect(dialog.getByLabel('Secret key')).toBeVisible()
  if (process.platform === 'linux') await expect(dialog.getByText(weak)).toBeVisible()
  else await expect(dialog.getByText(weak)).toHaveCount(0)
})
