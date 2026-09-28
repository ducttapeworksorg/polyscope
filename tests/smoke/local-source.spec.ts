import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let dir: string
let app: ElectronApplication

// Each test gets its own user-data directory so it neither sees nor leaves behind real Sources.
const launch = () =>
  electron.launch({ args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`] })

async function addSource(window: Page, name: string, rootPath: string, environment?: string) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await expect(dialog.getByLabel('Source Type')).toHaveValue('local')
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByLabel('Root path').fill(rootPath)
  if (environment) await dialog.getByLabel('Environment').selectOption({ label: environment })
  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await expect(dialog).toBeHidden()
}

/** Clicks one of a Source's action buttons, which show once its row is pointed at. */
async function sourceAction(window: Page, name: string, action: string) {
  const row = window.getByRole('treeitem', { name, exact: true })
  await row.hover()
  await row.getByRole('button', { name: action }).click()
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
  await expect(statusBar).toContainText('Log')

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

test('binary, hex, encodings, languages and compressed files', async () => {
  const window = await app.firstWindow()
  const logs = join(dir, 'root', 'logs')
  await writeFile(join(logs, 'blob.bin'), Buffer.from([0x41, 0x42, 0x43, 0x00, 0x01]))
  await writeFile(join(logs, 'latin.txt'), Buffer.from('café\n', 'latin1'))
  await writeFile(join(logs, 'old.log.gz'), gzipSync('WARN rotated away\n'))
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  const editor = window.getByTestId('editor')
  const statusBar = window.getByRole('contentinfo')

  // A binary file shows a placeholder until asked for hex.
  await window.getByRole('treeitem', { name: /^blob\.bin/ }).click()
  await expect(window.getByText('Binary file, 5 bytes')).toBeVisible()
  await expect(statusBar).toContainText('Binary')
  await window.getByRole('button', { name: 'Show as hex' }).click()
  await expect(editor).toContainText('41 42 43 00 01')
  await expect(statusBar).toContainText('Hex')

  // Latin-1 is detected, and the file can be reopened in another encoding from the status bar.
  await window.getByRole('treeitem', { name: /^latin\.txt/ }).click()
  await expect(editor).toContainText('café')
  await statusBar.getByRole('button', { name: /^Encoding: Latin-1/ }).click()
  const encodings = window.getByRole('listbox', { name: 'Reopen with encoding' })
  await encodings.getByRole('option', { name: 'UTF-8' }).click()
  await expect(editor).toContainText('caf\ufffd')
  await expect(statusBar.getByRole('button', { name: /^Encoding: UTF-8/ })).toBeFocused()

  // The language can be picked by typing its name.
  await statusBar.getByRole('button', { name: /^Language: Plain Text/ }).click()
  await window.getByRole('combobox').fill('yam')
  await window.keyboard.press('Enter')
  await expect(statusBar.getByRole('button', { name: /^Language: YAML/ })).toBeVisible()

  // Compressed files are shown decompressed, highlighted by the name inside.
  await window.getByRole('treeitem', { name: /^old\.log\.gz/ }).click()
  await expect(editor).toContainText('WARN rotated away')
  await expect(statusBar).toContainText('gzip')
  await expect(statusBar.getByRole('button', { name: /^Language: Log/ })).toBeVisible()
})

test('edit, duplicate, reorder and delete Sources', async () => {
  const window = await app.firstWindow()
  await addSource(window, 'Fixture', join(dir, 'root'))

  await sourceAction(window, 'Fixture', 'Edit…')
  const edit = window.getByRole('dialog', { name: 'Edit Fixture' })
  await edit.getByLabel('Name', { exact: true }).fill('Renamed')
  await edit.getByRole('button', { name: 'Save' }).click()

  await sourceAction(window, 'Renamed', 'Duplicate')
  await expect(window.getByRole('tree')).toHaveCount(2)
  await expect(window.getByRole('tree').nth(1)).toHaveAccessibleName('Renamed copy')

  // Dropped on the top edge of the first Source, the copy moves above it.
  await window
    .getByRole('treeitem', { name: 'Renamed copy' })
    .dragTo(window.getByRole('treeitem', { name: 'Renamed', exact: true }), { targetPosition: { x: 40, y: 2 } })
  await expect(window.getByRole('tree').first()).toHaveAccessibleName('Renamed copy')

  await sourceAction(window, 'Renamed', 'Delete…')
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
  await add.getByLabel('Name', { exact: true }).fill('Fixture')
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
  await sourceAction(window, 'Fixture', 'Disconnect')
  await expect(window.getByRole('treeitem')).toHaveCount(1)
  await expect(window.getByRole('tab', { name: 'app.log' })).toBeVisible()
  await expect(window.getByText('Source disconnected')).toBeVisible()
  await window.getByRole('button', { name: 'Reconnect' }).click()
  await expect(window.getByText('Source disconnected')).toBeHidden()
})

test('label a Source with an Environment, shown on its sidebar row, tabs and the status bar', async () => {
  const window = await app.firstWindow()
  await addSource(window, 'Fixture', join(dir, 'root'), 'prod')
  const source = window.getByRole('treeitem', { name: 'Fixture' })
  const badge = source.locator('.env-badge')
  await expect(badge).toHaveText('prod')

  await source.click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await window.getByRole('treeitem', { name: /^app\.log/ }).click()
  const tab = window.getByRole('tab', { name: 'app.log' })
  const segment = window.getByRole('contentinfo').getByTitle('Environment')
  await expect(tab).toHaveCSS('border-top-color', 'rgb(229, 72, 77)')
  await expect(segment).toHaveText('prod')
  await expect(segment).toHaveCSS('background-color', 'rgb(229, 72, 77)')

  // A new Environment, recoloured, relabels the Source and its open tab.
  const manageEnvironments = async () => {
    await window.getByRole('button', { name: 'Settings' }).click()
    await window.getByRole('button', { name: 'Manage Environments…' }).click()
    return window.getByRole('dialog', { name: 'Environments' })
  }
  const closeEnvironments = async () => {
    await window.getByRole('dialog', { name: 'Environments' }).getByRole('button', { name: 'Done' }).click()
    await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Cancel' }).click()
  }
  let environments = await manageEnvironments()
  await environments.getByLabel('New Environment', { exact: true }).fill('uat')
  await environments.getByRole('button', { name: 'Add', exact: true }).click()
  await environments.getByLabel('Colour of uat').fill('#0090ff')
  await closeEnvironments()

  await sourceAction(window, 'Fixture prod', 'Edit…')
  const edit = window.getByRole('dialog', { name: 'Edit Fixture' })
  await edit.getByLabel('Environment').selectOption({ label: 'uat' })
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(badge).toHaveText('uat')
  await expect(tab).toHaveCSS('border-top-color', 'rgb(0, 144, 255)')
  await expect(segment).toHaveText('uat')

  // Deleting it leaves the Source unlabelled, and its tab stays open.
  environments = await manageEnvironments()
  await environments.getByRole('button', { name: 'Delete uat' }).click()
  await window.getByRole('alertdialog', { name: 'Delete uat?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(environments.getByLabel('Name of uat')).toHaveCount(0)
  await closeEnvironments()
  await expect(badge).toHaveCount(0)
  await expect(segment).toHaveCount(0)
  await expect(tab).toBeVisible()
})

test('follow a file that isn’t open yet, with Follow shown on, and stop following it', async () => {
  const window = await app.firstWindow()
  const logFile = join(dir, 'root', 'logs', 'app.log')
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await window.getByRole('treeitem', { name: 'app.log' }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Follow' }).click()

  const follow = window.getByRole('button', { name: 'Follow', exact: true })
  const editor = window.getByTestId('editor')
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toContainText('INFO hello from polyscope')
  await appendFile(logFile, 'INFO written while followed\n')
  await expect(editor).toContainText('INFO written while followed')

  await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  await appendFile(logFile, 'INFO written after\n')
  await window.waitForTimeout(3000)
  await expect(editor).not.toContainText('INFO written after')
})

test('wrap a file’s long lines, and hide the minimap for good', async () => {
  // One long line and one short one, with no newline after it, so there are two lines until wrapped.
  await writeFile(join(dir, 'root', 'logs', 'long.txt'), `${'word '.repeat(400)}\nshort`)
  const window = await app.firstWindow()
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()
  await window.getByRole('treeitem', { name: 'long.txt' }).click()

  const editor = window.getByTestId('editor')
  const lines = editor.locator('.view-line')
  const minimap = editor.locator('.minimap')
  const wrap = window.getByRole('button', { name: 'Wrap', exact: true })
  const minimapToggle = window.getByRole('button', { name: 'Minimap', exact: true })
  await expect(lines).toHaveCount(2)
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(minimapToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(minimap).toBeVisible()

  // The long line takes several rows once wrapped.
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => lines.count()).toBeGreaterThan(2)
  await wrap.click()
  await expect(lines).toHaveCount(2)

  await minimapToggle.click()
  await expect(minimapToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(minimap).toBeHidden()

  // Every viewer opened since goes without it too, a file or a followed log.
  await window.getByRole('treeitem', { name: 'long.txt' }).dblclick()
  await window.getByRole('treeitem', { name: 'app.log' }).dblclick()
  await expect(editor).toContainText('INFO hello from polyscope')
  await expect(minimap).toBeHidden()
  await window.getByRole('treeitem', { name: 'app.log' }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Follow' }).click()
  await expect(window.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(minimap).toBeHidden()
  // …and so do the tabs open already.
  await window.getByRole('tab', { name: 'long.txt' }).click()
  await expect(editor).toContainText('word word')
  await expect(minimap).toBeHidden()

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await relaunched.getByRole('treeitem', { name: 'Fixture' }).click()
  await relaunched.getByRole('treeitem', { name: 'logs' }).click()
  await relaunched.getByRole('treeitem', { name: 'long.txt' }).click()
  await expect(relaunched.getByRole('button', { name: 'Minimap', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(relaunched.getByTestId('editor').locator('.view-line').first()).toBeVisible()
  await expect(relaunched.getByTestId('editor').locator('.minimap')).toBeHidden()
})

test('start maximized, and resize the sidebar by dragging its edge, remembered after a relaunch', async () => {
  const window = await app.firstWindow()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true)

  const sidebar = window.getByRole('navigation')
  const handle = window.getByRole('separator', { name: 'Resize Sources' })
  const width = async () => (await sidebar.boundingBox())!.width
  const before = await width()
  const box = (await handle.boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + 100)
  await window.mouse.down()
  await window.mouse.move(box.x + box.width / 2 + 120, box.y + 100, { steps: 5 })
  await window.mouse.up()
  expect(await width()).toBeCloseTo(before + 120, -1)

  // Dragged far past its limit, it stops there.
  await window.mouse.move(box.x + 120 + box.width / 2, box.y + 100)
  await window.mouse.down()
  await window.mouse.move(box.x + 2000, box.y + 100, { steps: 5 })
  await window.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '640')

  await handle.focus()
  await window.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '624')

  await app.close()
  app = await launch()
  const relaunched = await app.firstWindow()
  await expect(relaunched.getByRole('separator', { name: 'Resize Sources' })).toHaveAttribute('aria-valuenow', '624')
})

test('open a Large File at its end, then scroll to any line once it is cached', async () => {
  // Writing, then caching, 60 MB takes a while on a slow runner.
  test.setTimeout(180_000)
  // 600,000 lines of 100 bytes: 60 MB, over the default 50 MB threshold.
  const line = (n: number) => `${String(n).padStart(10, '0')} INFO ${'x'.repeat(83)}\n`
  const block = (from: number) => Array.from({ length: 10_000 }, (_, i) => line(from + i)).join('')
  for (let from = 0; from < 600_000; from += 10_000) await appendFile(join(dir, 'root', 'logs', 'huge.log'), block(from))
  const window = await app.firstWindow()
  const consoleErrors: string[] = []
  window.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  window.on('pageerror', (error) => consoleErrors.push(error.message))
  await addSource(window, 'Fixture', join(dir, 'root'))
  await window.getByRole('treeitem', { name: 'Fixture' }).click()
  await window.getByRole('treeitem', { name: 'logs' }).click()

  await window.getByRole('treeitem', { name: /^huge\.log/ }).click()

  const view = window.getByTestId('large-file')
  await expect(view).toContainText('0000599999 INFO')
  await expect(window.getByTestId('editor')).toBeHidden()
  await expect(window.locator('.statusbar')).toContainText('Large File')
  const goTo = window.getByLabel('Go to line')
  await expect(goTo).toBeEnabled({ timeout: 30_000 })
  await expect(window.getByText('600,000 lines')).toBeVisible()
  // Once cached, the end is still in view, now with its line number.
  await expect(view).toContainText('6000000000599999 INFO')

  await goTo.fill('300001')
  await goTo.press('Enter')
  await expect(view).toContainText('0000300000 INFO')
  await expect(view).not.toContainText('0000599999 INFO')

  await view.press('Control+Home')
  await expect(view).toContainText('10000000000 INFO')
  await view.press('Control+End')
  await expect(view).toContainText('0000599999 INFO')
  expect(consoleErrors).toEqual([])
})
