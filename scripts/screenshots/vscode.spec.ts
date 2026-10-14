// Renders the screenshots in docs/images of Polyscope for VS Code: `npm run extension:vsix`, then `npm run screenshots`.
// The packaged extension is installed into a VS Code of its own, downloaded into .vscode-test the first time, as a user
// would install it. Everything shown is made up, in samples.ts.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron'
import { cloudWatchSegment } from '../../src/shared/core-api'
import { seedFolder, startAzureAccount, startCloudWatch, startCluster, startDockerEngine, startSshHost } from './samples'

const root = join(__dirname, '..', '..')
const images = join(root, 'docs', 'images')

let dir: string
let app: ElectronApplication
let window: Page
let cluster: Awaited<ReturnType<typeof startCluster>>
let docker: Awaited<ReturnType<typeof startDockerEngine>>
let cloudWatch: Awaited<ReturnType<typeof startCloudWatch>>
let sshHost: Awaited<ReturnType<typeof startSshHost>>
let azure: Awaited<ReturnType<typeof startAzureAccount>>

/** VS Code's settings for the screenshots: nothing on screen but VS Code and Polyscope. */
const settings = {
  'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.tips.enabled': false,
  'workbench.layoutControl.enabled': false,
  'chat.disableAIFeatures': true,
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'window.restoreWindows': 'none',
  'editor.minimap.enabled': false
}

// ---- Driving VS Code --------------------------------------------------------------------------------------------

const shot = async (name: string) => {
  // Let fades, the editor's layout and VS Code's notifications settle; then clear them.
  await window.waitForTimeout(800)
  await command('Notifications: Clear All Notifications')
  // Out of the way of the tabs' tooltips.
  await window.mouse.move(720, 870)
  await window.waitForTimeout(400)
  await window.screenshot({ path: join(images, `${name}.png`) })
}

/** Runs one of VS Code's commands from the Command Palette. */
async function command(name: string) {
  await window.keyboard.press('F1')
  const input = window.locator('.quick-input-widget input')
  await input.fill(`>${name}`)
  await window.locator('.quick-input-list .monaco-list-row', { hasText: name }).first().click()
}

/**
 * The page inside one of Polyscope's webviews: the sidebar's, or the active viewer tab's. VS Code hosts each in an
 * iframe, its page in another inside it.
 */
async function webview(kind: 'sidebar' | 'viewer'): Promise<Frame> {
  let found: Frame | undefined
  await expect(async () => {
    found = undefined
    for (const frame of window.frames()) {
      const host = frame.parentFrame()
      if (!host || !host.url().startsWith('vscode-webview://') || !host.url().includes('ducttapeworks.polyscope')) continue
      if (host.url().includes('purpose=webviewView') !== (kind === 'sidebar')) continue
      const element = await host.frameElement().catch(() => null)
      if (kind === 'viewer' && !(await element?.isVisible())) continue
      if ((await frame.locator('#root, main').count()) > 0) found = frame
    }
    expect(found).toBeTruthy()
  }).toPass({ timeout: 60_000 })
  return found!
}

const rowIn = (frame: Frame) => (name: string | RegExp) =>
  frame.getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(`^${name.replaceAll('.', '\\.')}`) : name })

async function openAddSource(sidebar: Frame, type: string) {
  await sidebar.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = sidebar.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption(type)
  return dialog
}

/** Fills in a field, again if the dialog redraws it empty as it settles on the Source Type picked. */
async function fill(dialog: Locator, label: string, value: string) {
  await fillField(dialog.getByLabel(label, { exact: true }), value)
}

async function fillField(field: Locator, value: string) {
  await expect(async () => {
    await field.fill(value)
    await window.waitForTimeout(200)
    await expect(field).toHaveValue(value, { timeout: 500 })
  }).toPass()
}

async function addLocal(sidebar: Frame, name: string, rootPath: string, environment: string) {
  const dialog = await openAddSource(sidebar, 'local')
  await fill(dialog, 'Name', name)
  await dialog.getByLabel('Root path').fill(rootPath)
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addKubernetesLogs(sidebar: Frame, name: string, environment: string) {
  const dialog = await openAddSource(sidebar, 'kubernetesLogs')
  await fill(dialog, 'Name', name)
  await expect(dialog.getByRole('combobox', { name: 'Namespace', exact: true })).toHaveValue('shop')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** Picks a way to sign in, clicking its option as a user would: the radio itself is hidden beneath. */
const pick = (dialog: Locator, option: string) => dialog.locator('label.segmented__option', { hasText: option }).click()

async function addDockerLogs(sidebar: Frame, environment: string) {
  const dialog = await openAddSource(sidebar, 'dockerLogs')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Docker')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addCloudWatchLogs(sidebar: Frame, environment: string) {
  const dialog = await openAddSource(sidebar, 'cloudwatchLogs')
  await expect(dialog.getByLabel('Region', { exact: true })).toHaveValue('eu-west-1')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** An SSH Files or systemd Journal Source on the SSH config's `web-01`, signing in with its IdentityFile. */
async function addOnWeb01(sidebar: Frame, type: 'sshFiles' | 'systemdJournal', environment: string, path?: string) {
  const dialog = await openAddSource(sidebar, type)
  if (type === 'systemdJournal') await pick(dialog, 'Host over SSH')
  await fillField(dialog.getByRole('combobox', { name: 'Host', exact: true }), 'web-01')
  if (path) await dialog.getByLabel('Path').fill(path)
  await pick(dialog, 'Key file')
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

async function addAzureBlob(sidebar: Frame, environment: string) {
  const dialog = await openAddSource(sidebar, 'azureBlob')
  await fill(dialog, 'Storage account', azure.account)
  await dialog.getByLabel('Container', { exact: true }).fill(azure.container)
  // The field, not the sign-in choice of the same name.
  await dialog.getByLabel('Connection string').and(dialog.locator('input[type="password"]')).fill(azure.connectionString)
  await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** Expands the Source Type groups named, and collapses the rest. */
async function showGroups(sidebar: Frame, ...shown: string[]) {
  for (const group of await sidebar.locator('section').filter({ has: sidebar.locator('.source-group__toggle') }).all()) {
    const toggle = group.locator('.source-group__toggle')
    const expanded = (await toggle.getAttribute('aria-expanded')) === 'true'
    if (expanded !== shown.includes((await group.getAttribute('aria-label')) ?? '')) await toggle.click()
  }
}

async function closeAllEditors() {
  await command('View: Close All Editors')
  await expect(window.locator('.tabs-container .tab')).toHaveCount(0)
}

test.beforeAll(async () => {
  await mkdir(images, { recursive: true })
  dir = await mkdtemp(join(tmpdir(), 'polyscope-vscode-screenshots-'))
  await seedFolder(join(dir, 'logs'))
  cluster = await startCluster(dir)
  docker = await startDockerEngine()
  cloudWatch = await startCloudWatch(dir)
  sshHost = await startSshHost(dir)
  azure = await startAzureAccount()

  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
  const vsix = join(root, 'extension', `polyscope-${version}.vsix`)
  const vscode = await downloadAndUnzipVSCode({ cachePath: join(root, '.vscode-test') })
  const userData = join(dir, 'user-data')
  const profile = [`--user-data-dir=${userData}`, `--extensions-dir=${join(dir, 'extensions')}`]
  const cli = resolveCliPathFromVSCodeExecutablePath(vscode)
  execFileSync(cli, [...profile, '--install-extension', vsix], { stdio: 'inherit', shell: process.platform === 'win32' })
  await mkdir(join(userData, 'User'), { recursive: true })
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2))
  // A workspace named after the shop the logs are from, as VS Code's title shows it.
  const workspace = join(dir, 'shop')
  await mkdir(workspace)

  app = await electron.launch({
    executablePath: vscode,
    // The Azure Source's connection string goes in VS Code's secret storage: with no keyring on Linux, obfuscated.
    args: [workspace, ...profile, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--password-store=basic'],
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
  await expect(window.locator('.monaco-workbench')).toBeVisible({ timeout: 60_000 })
})

/** Widens the sidebar to `width`, by dragging its edge. */
async function widenSidebar(width: number) {
  const box = (await window.locator('.part.sidebar').boundingBox())!
  await window.mouse.move(box.x + box.width + 1, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(box.x + width, box.y + box.height / 2, { steps: 10 })
  await window.mouse.up()
}

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
  await window.getByRole('tab', { name: /^Polyscope/ }).click()
  await widenSidebar(440)
  const sidebar = await webview('sidebar')
  const row = rowIn(sidebar)

  // The Add Source dialog, for an S3 bucket.
  const s3 = await openAddSource(sidebar, 's3')
  await fill(s3, 'Name', 'Order exports')
  await s3.getByRole('textbox', { name: /^Host/ }).fill('https://minio.example.com:9000')
  await s3.getByRole('textbox', { name: /^Bucket/ }).fill('order-exports')
  await s3.getByRole('textbox', { name: /^Prefix/ }).fill('daily/')
  await s3.getByLabel('Environment').selectOption({ label: 'staging' })
  await shot('vscode-add-source')
  await s3.getByRole('button', { name: 'Cancel' }).click()

  await addKubernetesLogs(sidebar, 'shop', 'prod')
  await addLocal(sidebar, 'Staging logs', join(dir, 'logs'), 'staging')

  // Polyscope's Settings, at their defaults: before the Large File threshold is lowered for the Large File below.
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsDialog = sidebar.getByRole('dialog', { name: 'Settings' })
  await expect(settingsDialog).toBeVisible()
  await shot('vscode-settings')
  await settingsDialog.getByLabel('Large File threshold (MB)').fill('1')
  await settingsDialog.getByLabel('“Open anyway” limit (MB)').fill('1')
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(settingsDialog).toBeHidden()

  // Local files in VS Code's editor, their tabs tinted by the Source's Environment.
  await row('Staging logs').click()
  await row('checkout-api').last().click()
  await row('config').click()
  await row('settings.yaml').dblclick()
  await row('access.log').dblclick()
  await row('app.log').dblclick()
  await expect(window.getByRole('tab', { name: /app\.log/ })).toBeVisible()
  await shot('vscode-local-files')

  // Kubernetes Logs: the namespace's Workloads, and a container's log followed live in a viewer tab.
  await row('shop').click()
  await row('Deployments').click()
  await row(/^checkout(?!-)/).click()
  await row('checkout-5c6b9d7f4-7hx2m').click()
  await row('checkout-5c6b9d7f4-xk2lp').click()
  // A viewer tab opens on a single click: each click opens another.
  await row('api').first().click()
  const stream = await webview('viewer')
  await stream.getByRole('button', { name: 'Timestamps' }).click()
  const follow = stream.getByRole('button', { name: 'Follow', exact: true })
  if ((await follow.getAttribute('aria-pressed')) !== 'true') await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await window.waitForTimeout(2_500)
  await shot('vscode-kubernetes-logs')

  // A Large File in a viewer tab, searched.
  await row('search').click()
  await row('indexer.log').click()
  await expect(async () => {
    const large = await webview('viewer')
    await expect(large.getByLabel('Go to line')).toBeEnabled({ timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
  const large = await webview('viewer')
  await large.getByTestId('large-file').press('Control+f')
  await large.getByLabel('Search the file').fill('ERROR|Timeout')
  await large.getByLabel('Search the file').press('Enter')
  await expect(large.getByText(/matching lines/).first()).toBeVisible({ timeout: 30_000 })
  await shot('vscode-large-file')

  // The newer Source Types, each shown on its own: the other groups collapsed, and the editors before closed.
  await closeAllEditors()
  await addOnWeb01(sidebar, 'sshFiles', 'prod', '/var/log')
  await addAzureBlob(sidebar, 'prod')
  await addDockerLogs(sidebar, 'dev')
  await addCloudWatchLogs(sidebar, 'prod')
  await addOnWeb01(sidebar, 'systemdJournal', 'prod')

  // SSH Files: a server's /var/log, its nginx logs open in VS Code's editor.
  await showGroups(sidebar, 'SSH Files')
  await row('web-01:/var/log').click()
  await row('nginx').click()
  await row('error.log').dblclick()
  await expect(window.getByRole('tab', { name: /error\.log/ })).toBeVisible()
  await row('access.log').first().dblclick()
  await expect(window.getByRole('tab', { name: /access\.log/ })).toBeVisible()
  await shot('vscode-ssh-files')

  // Azure Blob Storage: a container of archived logs by service and day, a gzipped one open decompressed.
  await closeAllEditors()
  await showGroups(sidebar, 'Azure Blob Storage')
  await row('shoplogs/archive').click()
  await row('checkout-api').click()
  await row('2026').click()
  await row('09').click()
  await row('29').click()
  await row('access.log.gz').dblclick()
  await expect(window.getByRole('tab', { name: /access\.log\.gz/ })).toBeVisible()
  await row('app.log.gz').dblclick()
  await expect(window.getByRole('tab', { name: /app\.log\.gz/ })).toBeVisible()
  await shot('vscode-azure-blob')

  // Docker Logs: a Compose project's services, with their Container Status, and a service's log followed live.
  await closeAllEditors()
  await showGroups(sidebar, 'Docker Logs')
  await row('Docker').click()
  await row('shop').click()
  await row('web').click()
  await row('checkout').click()
  const service = await webview('viewer')
  await service.getByRole('button', { name: 'Timestamps' }).click()
  const followService = service.getByRole('button', { name: 'Follow', exact: true })
  if ((await followService.getAttribute('aria-pressed')) !== 'true') await followService.click()
  await expect(followService).toHaveAttribute('aria-pressed', 'true')
  docker.drip()
  await window.waitForTimeout(2_500)
  await shot('vscode-docker-logs')

  // CloudWatch Logs: an ECS service's log group, opened as one log of all its tasks' streams.
  await closeAllEditors()
  await showGroups(sidebar, 'CloudWatch Logs')
  await row('eu-west-1').click()
  const checkout = row(cloudWatchSegment('/ecs/checkout'))
  await checkout.click()
  await checkout.click({ button: 'right' })
  await sidebar.getByRole('menuitem', { name: 'Open log' }).click()
  await expect(window.getByRole('tab', { name: /checkout/ })).toBeVisible()
  await (await webview('viewer')).getByRole('button', { name: 'Timestamps' }).click()
  await shot('vscode-cloudwatch-logs')

  // systemd Journal: a server's units, with their active states, and a failed one's journal.
  await closeAllEditors()
  await showGroups(sidebar, 'systemd Journal')
  await row('web-01').last().click()
  await row('backup.service').click()
  await (await webview('viewer')).getByRole('button', { name: 'Timestamps' }).click()
  await shot('vscode-systemd-journal')
})
