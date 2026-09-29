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

test('switch the theme from the sidebar, and find it again after a relaunch', async () => {
  const window = await app.firstWindow()
  const html = window.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'dark')

  await window.getByRole('button', { name: 'Switch to the light theme' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await expect(relaunched.locator('html')).toHaveAttribute('data-theme', 'light')
  await relaunched.getByRole('button', { name: 'Switch to the dark theme' }).click()
  await expect(relaunched.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('copy diagnostics for a bug report', async () => {
  const window = await app.firstWindow()
  await window.getByRole('button', { name: 'Settings' }).click()
  const dialog = window.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('link', { name: 'Report an issue on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/ducttapeworksorg/polyscope/issues'
  )

  await dialog.getByRole('button', { name: 'Copy diagnostics' }).click()
  await expect(dialog.getByRole('group', { name: 'Help' }).getByRole('status')).toHaveText('Copied to the clipboard.')
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toContain('### Polyscope diagnostics')
  expect(copied).toMatch(/- Electron: \d+\.\d+\.\d+/)
  expect(copied).toMatch(/INFO {2}Polyscope \S+ started/)
})

test('see the version, and that a build run from source does not update itself', async () => {
  const window = await app.firstWindow()
  await window.getByRole('button', { name: 'Settings' }).click()
  const updates = window.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: 'Updates' })
  const version = await app.evaluate(({ app }) => app.getVersion())
  await expect(updates.getByText(`This is Polyscope ${version}.`)).toBeVisible()
  await expect(updates.getByRole('status')).toHaveText('A development build doesn’t update itself.')
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
})
