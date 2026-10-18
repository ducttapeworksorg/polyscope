import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { allowedCloudWatchOperations, startTestCloudWatchEndpoint, type TestCloudWatchEndpoint } from '../../src/main/core/cloudwatch-test-endpoint'
import { cloudWatchSegment as segment } from '../../src/shared/core-api'

let dir: string
let app: ElectronApplication
let endpoint: TestCloudWatchEndpoint


test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  endpoint = await startTestCloudWatchEndpoint(
    [
      {
        name: '/aws/lambda/orders',
        retentionDays: 7,
        streams: [{ name: '2026/10/12/[$LATEST]abc', events: [{ timestamp: Date.UTC(2026, 9, 12, 10), message: 'START RequestId: 1' }] }]
      },
      { name: '/ecs/shop' }
    ],
    { accessKeyId: 'AKIDTEST' }
  )
  // A profile naming its region, signing in with keys the stand-in endpoint takes; the SDK finds the endpoint itself.
  await writeFile(join(dir, 'aws-config'), '[default]\nregion = us-east-1\n[profile logs]\nregion = eu-west-1\n')
  await writeFile(join(dir, 'aws-credentials'), '[logs]\naws_access_key_id = AKIDTEST\naws_secret_access_key = secret\n')
  const { AWS_PROFILE: _, AWS_REGION: __, AWS_DEFAULT_REGION: ___, ...env } = process.env
  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`],
    env: {
      ...env,
      AWS_CONFIG_FILE: join(dir, 'aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws-credentials'),
      AWS_ENDPOINT_URL_CLOUDWATCH_LOGS: endpoint.url
    } as Record<string, string>
  })
})

test.afterEach(async () => {
  await app.close()
  await endpoint.close()
  await rm(dir, { recursive: true, force: true })
  // ADR 0008: nothing billed per use, like Live Tail or Logs Insights, is ever called.
  const allowed: readonly string[] = allowedCloudWatchOperations
  expect(endpoint.operations.filter((operation) => !allowed.includes(operation))).toEqual([])
})

async function openAddCloudWatchSource(window: Page) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption('cloudwatchLogs')
  return dialog
}

test('a CloudWatch Logs Source signs in with a profile, takes its region, is named after the region and prefix, and tests', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)
  const name = dialog.getByLabel('Name', { exact: true })
  const region = dialog.getByLabel('Region', { exact: true })

  await expect(dialog.getByRole('radio', { name: 'AWS profile' })).toBeChecked()
  await expect(region).toHaveValue('us-east-1')
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')
  await expect(region).toHaveValue('eu-west-1')
  await expect(name).toHaveValue('eu-west-1')

  await dialog.getByLabel('Log group prefix').pressSequentially('/aws/lambda/')
  await expect(name).toHaveValue('eu-west-1 /aws/lambda/')

  // A region chosen stays when the profile changes.
  await region.selectOption('ap-southeast-2')
  await dialog.getByLabel('Profile', { exact: true }).selectOption('')
  await expect(region).toHaveValue('ap-southeast-2')
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')

  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Connection succeeded.')
})

test('a CloudWatch Logs Source signs in with access keys, as an S3 Source does', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)

  // Clicking the option as a user would: the radio itself is hidden beneath.
  await dialog.locator('label.segmented__option', { hasText: 'Access keys' }).click()
  await dialog.getByLabel('Access key', { exact: true }).fill('AKIDTEST')
  await dialog.getByLabel('Secret key').fill('secret')

  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Connection succeeded.')
})

test('a CloudWatch Logs Source lists its log groups, and their streams', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')
  await dialog.getByLabel('Name', { exact: true }).fill('Lambdas')

  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await window.getByRole('treeitem', { name: 'Lambdas' }).click()
  await window.getByRole('treeitem', { name: segment('/aws/lambda/orders') }).click()

  await expect(window.getByRole('treeitem', { name: segment('/ecs/shop') })).toBeVisible()
  await expect(window.getByRole('treeitem', { name: segment('2026/10/12/[$LATEST]abc') })).toBeVisible()
})

test('a CloudWatch log group opens as one merged log, each line saying its stream', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')
  await dialog.getByLabel('Name', { exact: true }).fill('Lambdas')
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await window.getByRole('treeitem', { name: 'Lambdas' }).click()

  await window.getByRole('treeitem', { name: segment('/aws/lambda/orders') }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Open log' }).click()

  await expect(window.getByTestId('editor')).toContainText('[abc] START RequestId: 1')
})

test('a CloudWatch log saved as a copy has its lines as shown, with their timestamps in UTC when that’s how they’re shown', async () => {
  const saves = join(dir, 'saves')
  await mkdir(saves)
  // The Save dialog is the OS's: it answers with where the test says, as the user would pick.
  const answerSaveDialog = (filePath: string) =>
    app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
    }, filePath)
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')
  await dialog.getByLabel('Name', { exact: true }).fill('Lambdas')
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await window.getByRole('treeitem', { name: 'Lambdas' }).click()
  await window.getByRole('treeitem', { name: segment('/aws/lambda/orders') }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Open log' }).click()
  const editor = window.getByTestId('editor')
  await expect(editor).toContainText('[abc] START RequestId: 1')
  const saved = window.getByRole('region', { name: 'Saved copies' })

  await answerSaveDialog(join(saves, 'plain.log'))
  await window.getByRole('button', { name: 'Save a copy…' }).click()
  await expect(saved.getByText(`to ${join(saves, 'plain.log')}`)).toBeVisible()
  expect(await readFile(join(saves, 'plain.log'), 'utf8')).toBe('[abc] START RequestId: 1\n')

  await window.getByRole('button', { name: 'Timestamps', exact: true }).click()
  await window.getByRole('button', { name: 'UTC', exact: true }).click()
  await expect(editor).toContainText('2026-10-12 10:00:00.000Z')
  await answerSaveDialog(join(saves, 'utc.log'))
  await window.getByRole('button', { name: 'Save a copy…' }).click()
  await expect(saved.getByText(`to ${join(saves, 'utc.log')}`)).toBeVisible()
  expect(await readFile(join(saves, 'utc.log'), 'utf8')).toBe('2026-10-12 10:00:00.000Z [abc] START RequestId: 1\n')
})

test('a CloudWatch Logs Source takes an endpoint, a CA bundle and a proxy', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddCloudWatchSource(window)
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')

  // The endpoint typed in is used, not the one AWS_ENDPOINT_URL_CLOUDWATCH_LOGS names: here, one nothing answers at.
  await dialog.getByLabel('Endpoint').fill('http://127.0.0.1:1')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toContainText('The server can’t be reached')

  await dialog.getByLabel('Endpoint').fill(endpoint.url)
  await expect(dialog.getByLabel('CA bundle')).toBeVisible()
  await dialog.getByLabel('Proxy').fill('socks5://proxy.corp:1080')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toHaveText('That proxy isn’t an http or https address.')
})

/** Adds a log group of 30 events logged over the last minute, and opens its last 10 lines. */
async function openBusyGroup(window: Page) {
  const now = Date.now()
  const events = Array.from({ length: 30 }, (_, i) => ({ timestamp: now - 60_000 + i * 1_000, message: `event ${i}` }))
  endpoint.groups.push({ name: '/aws/lambda/busy', createdAt: now - 3_600_000, streams: [{ name: 'busy', events }] })
  const dialog = await openAddCloudWatchSource(window)
  await dialog.getByLabel('Profile', { exact: true }).selectOption('logs')
  await dialog.getByLabel('Name', { exact: true }).fill('Lambdas')
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await window.getByRole('treeitem', { name: 'Lambdas' }).click()
  await window.getByRole('treeitem', { name: segment('/aws/lambda/busy') }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Open log' }).click()
  await expect(window.getByTestId('editor')).toContainText('[busy] event 29')
  await window.getByRole('textbox', { name: 'Number of lines' }).fill('10')
  await window.getByRole('textbox', { name: 'Number of lines' }).press('Enter')
  await expect(window.getByRole('button', { name: 'Load earlier' })).toBeVisible()
}

const removeGroup = (name: string) => endpoint.groups.splice(endpoint.groups.findIndex((group) => group.name === name), 1)

test('a Followed CloudWatch log group that’s deleted keeps what it showed, saying it’s gone', async () => {
  const window = await app.firstWindow()
  await openBusyGroup(window)
  await expect(window.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'true')

  removeGroup('/aws/lambda/busy')

  await expect(window.getByText(`${segment('/aws/lambda/busy')} no longer exists`)).toBeVisible()
  await expect(window.getByTestId('editor')).toContainText('log is gone, Follow stopped')
  await expect(window.getByTestId('editor')).toContainText('[busy] event 29')
})

test('a CloudWatch log group deleted while its tab is open says it’s gone when loading earlier lines', async () => {
  const window = await app.firstWindow()
  await openBusyGroup(window)
  await window.getByRole('button', { name: 'Follow' }).click()
  await expect(window.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'false')

  removeGroup('/aws/lambda/busy')
  await window.getByRole('button', { name: 'Load earlier' }).click()

  await expect(window.getByText(`${segment('/aws/lambda/busy')} no longer exists`)).toBeVisible()
  await expect(window.getByTestId('editor')).toContainText('[busy] event 29')
})
