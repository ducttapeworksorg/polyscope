import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
