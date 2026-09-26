import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let dir: string
let app: ElectronApplication

// Each test gets its own user-data directory so it neither sees nor leaves behind real Sources.
const launch = () =>
  electron.launch({ args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`] })

async function addSource(window: Page, name: string, rootPath: string) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await expect(dialog.getByRole('radio', { name: /Local Filesystem/ })).toBeChecked()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Root path').fill(rootPath)
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  await mkdir(join(dir, 'root', 'logs'), { recursive: true })
  await writeFile(join(dir, 'root', 'logs', 'app.log'), 'INFO hello from polyscope\n')
  app = await launch()
})

test.afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

test('add a Local Filesystem Source, browse it, read a file, and find it again after a relaunch', async () => {
  const window = await app.firstWindow()
  const consoleErrors: string[] = []
  window.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  window.on('pageerror', (error) => consoleErrors.push(error.message))

  await addSource(window, 'Fixture', join(dir, 'root'))

  await expect(window.getByRole('region', { name: 'Local Filesystem' })).toBeVisible()
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await window.getByRole('treeitem', { name: 'app.log' }).click()

  await expect(window.getByRole('tab', { name: 'app.log' })).toHaveAttribute('aria-selected', 'true')
  await expect(window.getByTestId('editor')).toContainText('INFO hello from polyscope')
  expect(consoleErrors).toEqual([])

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await expect(relaunched.getByRole('treeitem', { name: 'Fixture' })).toBeVisible()
  await expect(relaunched.getByRole('tab')).toHaveCount(0)
})

test('edit, duplicate, reorder and delete Sources', async () => {
  const window = await app.firstWindow()
  await addSource(window, 'Fixture', join(dir, 'root'))
  const sourceMenu = async (name: string) => {
    await window.getByRole('treeitem', { name, exact: true }).click({ button: 'right' })
    return window.getByRole('menu', { name: `Actions for ${name}` })
  }

  await (await sourceMenu('Fixture')).getByRole('menuitem', { name: 'Edit…' }).click()
  const edit = window.getByRole('dialog', { name: 'Edit Fixture' })
  await edit.getByLabel('Name').fill('Renamed')
  await edit.getByRole('button', { name: 'Save' }).click()

  await (await sourceMenu('Renamed')).getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(window.getByRole('tree')).toHaveCount(2)
  await expect(window.getByRole('tree').nth(1)).toHaveAccessibleName('Renamed copy')

  // Dropped on the top edge of the first Source, the copy moves above it.
  await window
    .getByRole('treeitem', { name: 'Renamed copy' })
    .dragTo(window.getByRole('treeitem', { name: 'Renamed', exact: true }), { targetPosition: { x: 40, y: 2 } })
  await expect(window.getByRole('tree').first()).toHaveAccessibleName('Renamed copy')

  await (await sourceMenu('Renamed')).getByRole('menuitem', { name: 'Delete…' }).click()
  await window.getByRole('alertdialog', { name: 'Delete Renamed?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(window.getByRole('tree')).toHaveCount(1)
  await expect(window.getByRole('tree')).toHaveAccessibleName('Renamed copy')
})
