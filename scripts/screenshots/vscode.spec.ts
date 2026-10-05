// Renders the screenshots in docs/images of Polyscope for VS Code: `npm run extension:vsix`, then `npm run screenshots`.
// The packaged extension is installed into a VS Code of its own, downloaded into .vscode-test the first time, as a user
// would install it. Everything shown is made up, in samples.ts.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron'
import { seedFolder, startCluster } from './samples'

const root = join(__dirname, '..', '..')
const images = join(root, 'docs', 'images')

let dir: string
let app: ElectronApplication
let window: Page
let cluster: Awaited<ReturnType<typeof startCluster>>

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
  const field = dialog.getByLabel(label, { exact: true })
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

test.beforeAll(async () => {
  await mkdir(images, { recursive: true })
  dir = await mkdtemp(join(tmpdir(), 'polyscope-vscode-screenshots-'))
  await seedFolder(join(dir, 'logs'))
  cluster = await startCluster(dir)

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
    args: [workspace, ...profile, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust'],
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
})
