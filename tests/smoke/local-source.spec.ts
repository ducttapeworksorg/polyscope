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

test('show file sizes and modified times, and hide them for good from the sidebar', async () => {
  const window = await app.firstWindow()
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  const file = window.getByRole('treeitem', { name: /^app\.log/ })

  await expect(file).toContainText('26 B')
  await expect(file).toContainText('now')
  const escaped = join(dir, 'root', 'logs', 'app.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await expect(file).toHaveAttribute('title', new RegExp(`^${escaped}\\nModified `))
  await expect(file.locator('img')).toHaveAttribute('src', /log.*\.svg/)

  const toggle = window.getByRole('button', { name: 'Show sizes and modified times' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(file).not.toContainText('26 B')

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await expect(relaunched.getByRole('button', { name: 'Show sizes and modified times' })).toHaveAttribute('aria-pressed', 'false')
})

test('preview and pinned tabs, reload, closing, and the status bar', async () => {
  const window = await app.firstWindow()
  const logs = join(dir, 'root', 'logs')
  await writeFile(join(logs, 'other.log'), 'INFO other\n')
  await writeFile(join(logs, 'settings.json'), '{ "level": "info" }\n')
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  const tabs = window.getByRole('tab')
  const tab = (name: string) => window.getByRole('tab', { name })

  // Single clicks share one preview tab, shown in italics.
  await window.getByRole('treeitem', { name: /^app\.log/ }).click()
  await expect(tab('app.log')).toHaveClass(/is-preview/)
  await expect(tab('app.log').locator('.tab__label')).toHaveCSS('font-style', 'italic')
  await window.getByRole('treeitem', { name: /^other\.log/ }).click()
  await expect(tabs).toHaveCount(1)
  await expect(tab('other.log')).toHaveAttribute('aria-selected', 'true')

  // Double-clicking the tab pins it, so the next file gets a tab of its own; a tree double-click opens pinned.
  await tab('other.log').dblclick()
  await expect(tab('other.log')).not.toHaveClass(/is-preview/)
  await window.getByRole('treeitem', { name: /^app\.log/ }).click()
  await expect(tabs).toHaveCount(2)
  await window.getByRole('treeitem', { name: /^settings\.json/ }).dblclick()
  await expect(tabs).toHaveCount(2)
  await expect(tab('settings.json')).not.toHaveClass(/is-preview/)
  await expect(tabs.nth(1)).toHaveAccessibleName(/^settings\.json/)

  // The status bar describes the active tab.
  const statusBar = window.getByRole('contentinfo')
  await expect(statusBar).toContainText('20 B')
  await expect(statusBar).toContainText('UTF-8')
  await expect(statusBar).toContainText('JSON')
  await tab('other.log').click()
  await expect(statusBar).toContainText('11 B')
  await expect(statusBar).toContainText('Plain Text')

  // Reload reads the file again.
  await writeFile(join(logs, 'other.log'), 'INFO other\nWARN reloaded\n')
  await window.getByRole('button', { name: 'Reload' }).click()
  await expect(window.getByTestId('editor')).toContainText('WARN reloaded')
  await expect(statusBar).toContainText('25 B')

  const tabMenu = async (name: string) => {
    await tab(name).click({ button: 'right' })
    return window.getByRole('menu', { name: `Actions for ${name}` })
  }
  await (await tabMenu('other.log')).getByRole('menuitem', { name: 'Close Others' }).click()
  await expect(tabs).toHaveCount(1)
  await expect(tab('other.log')).toBeVisible()
  await window.getByRole('treeitem', { name: /^app\.log/ }).click()
  await (await tabMenu('app.log')).getByRole('menuitem', { name: 'Close All' }).click()
  await expect(tabs).toHaveCount(0)
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

test('connect, fail, retry, disconnect and reconnect a Source', async () => {
  const window = await app.firstWindow()
  const root = join(dir, 'root')

  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const add = window.getByRole('dialog', { name: 'Add Source' })
  await add.getByLabel('Root path').fill(join(dir, 'missing'))
  await add.getByRole('button', { name: 'Test connection' }).click()
  await expect(add.getByRole('status')).toContainText('That folder doesn’t exist.')
  await add.getByLabel('Root path').fill(root)
  await add.getByRole('button', { name: 'Test connection' }).click()
  await expect(add.getByRole('status')).toHaveText('Connection succeeded.')
  await add.getByLabel('Name').fill('Fixture')
  await add.getByRole('button', { name: 'Add Source' }).click()

  // The root disappears before the first connect: the Source goes into Error, and expanding again retries.
  await rm(root, { recursive: true })
  const sourceRow = window.getByRole('treeitem', { name: 'Fixture' })
  await sourceRow.click()
  await expect(sourceRow).toHaveAttribute('title', /That folder doesn’t exist/)
  await mkdir(join(root, 'logs'), { recursive: true })
  await writeFile(join(root, 'logs', 'app.log'), 'INFO back again\n')
  await sourceRow.click()
  await expect(sourceRow).not.toHaveAttribute('title')

  // A folder that vanishes shows an error node with Retry; the rest of the tree carries on.
  await rm(join(root, 'logs'), { recursive: true })
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await expect(window.getByRole('button', { name: 'Retry' })).toBeVisible()
  await mkdir(join(root, 'logs'))
  await writeFile(join(root, 'logs', 'app.log'), 'INFO back again\n')
  await window.getByRole('button', { name: 'Retry' }).click()
  await window.getByRole('treeitem', { name: 'app.log' }).click()
  await expect(window.getByTestId('editor')).toContainText('INFO back again')

  // Refresh picks up a file added since the folder was listed.
  await writeFile(join(root, 'logs', 'new.log'), '')
  await window.getByRole('treeitem', { name: 'logs' }).click({ button: 'right' })
  await window.getByRole('menu', { name: 'Actions for logs' }).getByRole('menuitem', { name: 'Refresh' }).click()
  await expect(window.getByRole('treeitem', { name: 'new.log' })).toBeVisible()

  // Disconnecting collapses the Source but keeps its tab, with a way back.
  await sourceRow.click({ button: 'right' })
  await window.getByRole('menu', { name: 'Actions for Fixture' }).getByRole('menuitem', { name: 'Disconnect' }).click()
  await expect(window.getByRole('treeitem')).toHaveCount(1)
  await expect(window.getByRole('tab', { name: 'app.log' })).toBeVisible()
  await expect(window.getByText('Source disconnected')).toBeVisible()
  await window.getByRole('button', { name: 'Reconnect' }).click()
  await expect(window.getByText('Source disconnected')).toBeHidden()
})
