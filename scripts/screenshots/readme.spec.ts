// Renders the screenshots in docs/images of the desktop app: `npm run build`, then `npm run screenshots`. Everything
// shown is made up, in samples.ts.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { seedFolder, startCluster } from './samples'

const images = join(__dirname, '..', '..', 'docs', 'images')

let dir: string
let app: ElectronApplication
let window: Page
let cluster: Awaited<ReturnType<typeof startCluster>>

// ---- Driving the app --------------------------------------------------------------------------------------------

const shot = async (name: string) => {
  // Let fades and the editor's layout settle.
  await window.waitForTimeout(600)
  await window.screenshot({ path: join(images, `${name}.png`) })
}

const row = (name: string | RegExp) => window.getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(`^${name.replaceAll('.', '\\.')}`) : name })

async function openAddSource(type: string) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption(type)
  return dialog
}

async function addLocal(name: string, rootPath: string, environment: string) {
  const dialog = await openAddSource('local')
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByLabel('Root path').fill(rootPath)
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addKubernetesLogs(name: string, environment: string) {
  const dialog = await openAddSource('kubernetesLogs')
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await expect(dialog.getByRole('combobox', { name: 'Namespace', exact: true })).toHaveValue('shop')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function setLargeFileThreshold(megabytes: string) {
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = window.getByRole('dialog', { name: 'Settings' })
  await settings.getByLabel('Large File threshold (MB)').fill(megabytes)
  await settings.getByLabel('“Open anyway” limit (MB)').fill(megabytes)
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toBeHidden()
}

test.beforeAll(async () => {
  await mkdir(images, { recursive: true })
  dir = await mkdtemp(join(tmpdir(), 'polyscope-screenshots-'))
  await seedFolder(join(dir, 'logs'))
  cluster = await startCluster(dir)
  app = await electron.launch({
    // The project itself, rather than its built main script, so the app reads its version from package.json for the
    // status bar, rather than reporting Electron's.
    args: [join(__dirname, '..', '..'), `--user-data-dir=${join(dir, 'user-data')}`],
    env: { ...process.env, KUBECONFIG: cluster.kubeconfig }
  })
  window = await app.firstWindow()
  // The same size on every machine, whatever the screen.
  await app.evaluate(({ BrowserWindow }) => {
    const [main] = BrowserWindow.getAllWindows()
    main!.unmaximize()
    main!.setContentSize(1440, 880)
    main!.center()
  })
  await window.waitForTimeout(500)
})

test.afterAll(async () => {
  await app?.close()
  await cluster?.close()
  await rm(dir, { recursive: true, force: true })
})

test('screenshots', async () => {
  // The Add Source dialog, for an S3 bucket.
  const s3 = await openAddSource('s3')
  await s3.getByLabel('Name', { exact: true }).fill('Order exports')
  await s3.getByRole('textbox', { name: /^Host/ }).fill('https://minio.example.com:9000')
  await s3.getByRole('textbox', { name: /^Bucket/ }).fill('order-exports')
  await s3.getByRole('textbox', { name: /^Prefix/ }).fill('daily/')
  await s3.getByLabel('Environment').selectOption({ label: 'staging' })
  await shot('add-source')
  await s3.getByRole('button', { name: 'Cancel' }).click()

  await addKubernetesLogs('shop', 'prod')
  await addLocal('Staging logs', join(dir, 'logs'), 'staging')

  // The Settings, at their defaults: before the Large File threshold is lowered for the Large File Viewer below.
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = window.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByText('A development build doesn’t update itself.')).toBeVisible()
  await shot('settings')
  await settings.getByRole('button', { name: 'Cancel' }).click()
  await expect(settings).toBeHidden()

  await setLargeFileThreshold('1')

  // Kubernetes Logs: the namespace's Workloads, a crashing pod, and a log followed live.
  await row('shop').click()
  await row('Deployments').click()
  await row(/^checkout(?!-)/).click()
  await row('checkout-5c6b9d7f4-7hx2m').click()
  await row('checkout-5c6b9d7f4-xk2lp').click()
  await row('StatefulSets').click()
  await row('CronJobs').click()
  // The healthy pod's app container, followed live.
  await row('api').first().dblclick()
  await window.getByRole('button', { name: 'Timestamps' }).click()
  const follow = window.getByRole('button', { name: 'Follow', exact: true })
  if ((await follow.getAttribute('aria-pressed')) !== 'true') await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await window.waitForTimeout(2_500)
  await shot('kubernetes-logs')

  // The crashing pod's Previous Log.
  await row('Previous Log').first().dblclick()
  await shot('previous-log')

  // Local files: a log with its levels highlighted, among a few pinned tabs.
  await row('Staging logs').click()
  await row('checkout-api').last().click()
  await row('config').click()
  await row('settings.yaml').dblclick()
  await row('access.log').dblclick()
  await row('app.log').dblclick()
  await shot('local-files')

  // The Large File Viewer, searching a file over the threshold.
  await row('search').click()
  await row('indexer.log').dblclick()
  const view = window.getByTestId('large-file')
  await expect(window.getByLabel('Go to line')).toBeEnabled({ timeout: 60_000 })
  await view.press('Control+f')
  await window.getByLabel('Search the file').fill('ERROR|Timeout')
  await window.getByLabel('Search the file').press('Enter')
  await expect(window.getByText(/matching lines/).first()).toBeVisible({ timeout: 30_000 })
  await shot('large-file')

  // The light theme.
  await window.getByLabel('Search the file').press('Escape')
  await window.getByRole('tab', { name: 'app.log' }).click()
  await window.getByRole('button', { name: 'Switch to the light theme' }).click()
  await shot('light-theme')
})
