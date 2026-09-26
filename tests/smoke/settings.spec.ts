import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

let dir: string
let app: ElectronApplication

const launch = () =>
  electron.launch({ args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`] })

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  app = await launch()
})

test.afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

test('change settings and the theme, and find them again after a relaunch', async () => {
  const window = await app.firstWindow()
  const html = window.locator('html')
  // Monaco writes the active theme's colours into one stylesheet shared by every editor.
  const editorBackground = async () =>
    (await window.locator('style.monaco-colors').textContent())?.match(/--vscode-editor-background: (#\w+)/)?.[1]
  await expect(html).toHaveAttribute('data-theme', 'dark')

  await window.getByRole('button', { name: 'Settings' }).click()
  const dialog = window.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByLabel('Large File threshold (MB)')).toHaveValue('50')
  await expect(dialog.getByLabel('“Open anyway” limit (MB)')).toHaveValue('200')
  await expect(dialog.getByLabel('Default “Last N lines”')).toHaveValue('10000')

  // Picking a theme shows it at once; Cancel goes back to the saved one.
  await dialog.getByText('Light', { exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  expect(await editorBackground()).toBe('#fbfcfd')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await editorBackground()).toBe('#1b2230')

  // Invalid values are explained and can't be saved.
  await window.keyboard.press('Control+,')
  await dialog.getByLabel('Large File threshold (MB)').fill('300')
  await expect(dialog.getByText('Must be at least the Large File threshold.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await dialog.getByLabel('Large File threshold (MB)').fill('20')
  await dialog.getByLabel('Default “Last N lines”').fill('5000')
  await dialog.getByText('Light', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(html).toHaveAttribute('data-theme', 'light')

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await expect(relaunched.locator('html')).toHaveAttribute('data-theme', 'light')
  await relaunched.getByRole('button', { name: 'Settings' }).click()
  const reopened = relaunched.getByRole('dialog', { name: 'Settings' })
  await expect(reopened.getByLabel('Large File threshold (MB)')).toHaveValue('20')
  await expect(reopened.getByLabel('Default “Last N lines”')).toHaveValue('5000')
  await expect(reopened.getByRole('radio', { name: 'Light' })).toBeChecked()
})
