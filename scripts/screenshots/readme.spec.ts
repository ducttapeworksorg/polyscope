// Renders the screenshots in docs/images of the desktop app: `npm run build`, then `npm run screenshots`. Everything
// shown is made up, in samples.ts.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { cloudWatchSegment } from '../../src/shared/core-api'
import { seedFolder, startAzureAccount, startCloudWatch, startCluster, startDockerEngine, startSshHost } from './samples'

const images = join(__dirname, '..', '..', 'docs', 'images')

let dir: string
let app: ElectronApplication
let window: Page
let cluster: Awaited<ReturnType<typeof startCluster>>
let docker: Awaited<ReturnType<typeof startDockerEngine>>
let cloudWatch: Awaited<ReturnType<typeof startCloudWatch>>
let sshHost: Awaited<ReturnType<typeof startSshHost>>
let azure: Awaited<ReturnType<typeof startAzureAccount>>

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

/** Picks a way to sign in, clicking its option as a user would: the radio itself is hidden beneath. */
const pick = (dialog: Locator, option: string) => dialog.locator('label.segmented__option', { hasText: option }).click()

async function addDockerLogs(environment: string) {
  const dialog = await openAddSource('dockerLogs')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Docker')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addCloudWatchLogs(environment: string) {
  const dialog = await openAddSource('cloudwatchLogs')
  await expect(dialog.getByLabel('Region', { exact: true })).toHaveValue('eu-west-1')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** An SSH Files or systemd Journal Source on the SSH config's `web-01`, signing in with its IdentityFile. */
async function addOnWeb01(type: 'sshFiles' | 'systemdJournal', environment: string, path?: string) {
  const dialog = await openAddSource(type)
  if (type === 'systemdJournal') await pick(dialog, 'Host over SSH')
  await dialog.getByRole('combobox', { name: 'Host', exact: true }).fill('web-01')
  if (path) await dialog.getByLabel('Path').fill(path)
  await pick(dialog, 'Key file')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addAzureBlob(environment: string) {
  const dialog = await openAddSource('azureBlob')
  await dialog.getByLabel('Storage account', { exact: true }).fill(azure.account)
  await dialog.getByLabel('Container', { exact: true }).fill(azure.container)
  // The field, not the sign-in choice of the same name.
  await dialog.getByLabel('Connection string').and(dialog.locator('input[type="password"]')).fill(azure.connectionString)
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** Expands the Source Type groups named, and collapses the rest. */
async function showGroups(...shown: string[]) {
  for (const group of await window.locator('section').filter({ has: window.locator('.source-group__toggle') }).all()) {
    const toggle = group.locator('.source-group__toggle')
    const expanded = (await toggle.getAttribute('aria-expanded')) === 'true'
    if (expanded !== shown.includes((await group.getAttribute('aria-label')) ?? '')) await toggle.click()
  }
}

async function closeAllTabs() {
  const tab = window.getByRole('tab').first()
  if ((await tab.count()) === 0) return
  await tab.click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Close All' }).click()
  await expect(window.getByRole('tab')).toHaveCount(0)
}

async function turnOn(name: string) {
  const button = window.getByRole('button', { name, exact: true })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
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
  docker = await startDockerEngine()
  cloudWatch = await startCloudWatch(dir)
  sshHost = await startSshHost(dir)
  azure = await startAzureAccount()
  app = await electron.launch({
    // The project itself, rather than its built main script, so the app reads its version from package.json for the
    // status bar, rather than reporting Electron's.
    args: [join(__dirname, '..', '..'), `--user-data-dir=${join(dir, 'user-data')}`],
    // A home of the samples' own, so nothing from your ~/.ssh, ~/.aws or ~/.docker shows, nor your SSH agent's keys.
    env: {
      ...process.env,
      HOME: sshHost.home,
      USERPROFILE: sshHost.home,
      SSH_AUTH_SOCK: '',
      KUBECONFIG: cluster.kubeconfig,
      ...docker.env,
      ...cloudWatch.env
    }
  })
  window = await app.firstWindow()
  // The Azure Source's connection string is stored, in the throwaway user data. Launched here, Electron finds no keyring
  // on Linux, so it's let obfuscate it instead.
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  // The app maximizes its window as it first shows it, which would undo the sizing below.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true)
  // The same size on every machine, on the sharpest screen it fits, whatever screen it opens on.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const [main] = BrowserWindow.getAllWindows()
    const fits = screen.getAllDisplays().filter(({ workArea }) => workArea.width >= 1440 && workArea.height >= 880)
    const { workArea } = fits.sort((a, b) => b.scaleFactor - a.scaleFactor)[0] ?? screen.getPrimaryDisplay()
    main!.unmaximize()
    // Moved onto the screen first, so the size is taken in that screen's scale.
    main!.setPosition(workArea.x, workArea.y)
    main!.setContentSize(1440, 880)
    const [width, height] = main!.getSize() as [number, number]
    main!.setPosition(workArea.x + Math.round((workArea.width - width) / 2), workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)))
    // Again, as crossing to a screen of another scale can leave it a few pixels off.
    main!.setContentSize(1440, 880)
  })
  await window.waitForTimeout(500)
})

test.afterAll(async () => {
  await app?.close()
  await cluster?.close()
  await docker?.close()
  await cloudWatch?.close()
  await sshHost?.close()
  await azure?.close()
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

  // The crashing pod's app container, switched to its Previous Log.
  await row('api').nth(1).dblclick()
  const previous = window.getByRole('button', { name: 'Previous', exact: true })
  await expect(previous).toBeEnabled()
  await previous.click()
  await expect(window.getByRole('tab', { name: /api \(previous\)/ })).toBeVisible()
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
  await window.getByRole('button', { name: 'Switch to the dark theme' }).click()

  // The newer Source Types, each shown on its own: the other groups collapsed, and the tabs before closed.
  await closeAllTabs()
  await addOnWeb01('sshFiles', 'prod', '/var/log')
  await addAzureBlob('prod')
  await addDockerLogs('dev')
  await addCloudWatchLogs('prod')
  await addOnWeb01('systemdJournal', 'prod')

  // SSH Files: a server's /var/log, its nginx logs open.
  await showGroups('SSH Files')
  await row('web-01:/var/log').click()
  await row('nginx').click()
  await row('error.log').dblclick()
  await expect(window.getByRole('tab', { name: /error\.log/ })).toBeVisible()
  await row('access.log').first().dblclick()
  await expect(window.getByRole('tab', { name: /access\.log/ })).toBeVisible()
  await shot('ssh-files')

  // Azure Blob Storage: a container of archived logs by service and day, a gzipped one open decompressed.
  await closeAllTabs()
  await showGroups('Azure Blob Storage')
  await row('shoplogs/archive').click()
  await row('checkout-api').click()
  await row('2026').click()
  await row('09').click()
  await row('29').click()
  await row('access.log.gz').dblclick()
  await expect(window.getByRole('tab', { name: /access\.log\.gz/ })).toBeVisible()
  await row('app.log.gz').dblclick()
  await expect(window.getByRole('tab', { name: /app\.log\.gz/ })).toBeVisible()
  await shot('azure-blob')

  // Docker Logs: a Compose project's services, with their Container Status, and a service's log followed live.
  await closeAllTabs()
  await showGroups('Docker Logs')
  await row('Docker').click()
  await row('shop').click()
  await row('web').click()
  await row('checkout').click()
  await window.getByRole('button', { name: 'Timestamps' }).click()
  await turnOn('Follow')
  docker.drip()
  await window.waitForTimeout(2_500)
  await shot('docker-logs')

  // CloudWatch Logs: an ECS service's log group, opened as one log of all its tasks' streams.
  await closeAllTabs()
  await showGroups('CloudWatch Logs')
  await row('eu-west-1').click()
  const checkout = row(cloudWatchSegment('/ecs/checkout'))
  await checkout.click()
  await checkout.click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Open log' }).click()
  await expect(window.getByRole('tab', { name: /checkout/ })).toBeVisible()
  await window.getByRole('button', { name: 'Timestamps' }).click()
  await shot('cloudwatch-logs')

  // systemd Journal: a server's units, with their active states, and a failed one's journal.
  await closeAllTabs()
  await showGroups('systemd Journal')
  await row('web-01').last().click()
  await row('backup.service').click()
  await window.getByRole('button', { name: 'Timestamps' }).click()
  await shot('systemd-journal')
})
