import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let dir: string
let app: ElectronApplication

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  app = await electron.launch({ args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`] })
})

test.afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

async function openAddSource(window: Page) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  return window.getByRole('dialog', { name: 'Add Source' })
}

test('a systemd Journal Source reads this machine’s journal, and is named after it', async () => {
  test.skip(process.platform !== 'linux', 'Only Linux has a systemd journal')
  const window = await app.firstWindow()
  const dialog = await openAddSource(window)

  await dialog.getByLabel('Source Type').selectOption('systemdJournal')

  await expect(dialog.getByRole('radio', { name: 'This machine' })).toBeChecked()
  await expect(dialog.getByText('systemd-journal or adm group')).toBeVisible()
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('This machine')
})

test('systemd Journal isn’t offered off Linux', async () => {
  // The core goes by the platform it runs on, so the app is told it runs on macOS before the dialog asks.
  await app.evaluate(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
  const window = await app.firstWindow()
  const dialog = await openAddSource(window)
  const types = dialog.getByLabel('Source Type')

  await expect(types.locator('option[value="dockerLogs"]')).toHaveCount(1)
  await expect(types.locator('option[value="systemdJournal"]')).toHaveCount(0)
})
