import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

let dir: string
let app: ElectronApplication

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  await mkdir(join(dir, 'logs'))
  await writeFile(join(dir, 'logs', 'app.log'), 'INFO hello from polyscope\n')
  app = await electron.launch({ args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')] })
})

test.afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

test('add a Local Filesystem Source, browse it, and read a file', async () => {
  const window = await app.firstWindow()
  const consoleErrors: string[] = []
  window.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  window.on('pageerror', (error) => consoleErrors.push(error.message))

  await window.getByRole('button', { name: 'Add Source' }).click()
  await window.getByLabel('Name').fill('Fixture')
  await window.getByLabel('Root path').fill(dir)
  await window.getByRole('button', { name: 'Add Source' }).click()

  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await window.getByRole('treeitem', { name: 'app.log' }).click()

  await expect(window.getByRole('tab', { name: 'app.log' })).toHaveAttribute('aria-selected', 'true')
  await expect(window.getByTestId('editor')).toContainText('INFO hello from polyscope')
  expect(consoleErrors).toEqual([])
})
