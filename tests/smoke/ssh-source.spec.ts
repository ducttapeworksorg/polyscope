import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../../src/main/core/ssh-test-server'

let dir: string
let home: string
let app: ElectronApplication
let server: TestSshServer

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  // A home of the test's own, with an empty known_hosts, so the server's host key is unknown.
  home = join(dir, 'home')
  await mkdir(join(home, '.ssh'), { recursive: true })
  await writeFile(join(home, '.ssh', 'known_hosts'), '')
  server = await startTestSshServer()
  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`],
    env: { ...process.env, HOME: home, USERPROFILE: home }
  })
})

test.afterEach(async () => {
  await app.close()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

async function openAddSshSource(window: Page) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption('sshFiles')
  return dialog
}

/** Picks a way to sign in, clicking its option as a user would: the radio itself is hidden beneath. */
const signInWith = (dialog: Locator, option: string) => dialog.locator('label.segmented__option', { hasText: option }).click()

test('an SSH Files Source has host, port, user and path fields, and is named after its host and path', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddSshSource(window)
  const name = dialog.getByLabel('Name', { exact: true })

  await expect(dialog.getByLabel('Port')).toHaveAttribute('placeholder', '22')
  await expect(dialog.getByLabel('User')).toBeVisible()

  await dialog.getByLabel('Host').pressSequentially('web-1')
  await dialog.getByLabel('Path').fill('/var/log')
  await expect(name).toHaveValue('web-1:/var/log')

  await name.fill('Web logs')
  await dialog.getByLabel('Path').fill('/opt/app/logs')
  await expect(name).toHaveValue('Web logs')
})

test('an SSH Files Source signs in through the agent unless a key file or password is picked', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddSshSource(window)
  const passwordField = dialog.locator('input[type="password"]')

  await expect(dialog.getByRole('radio', { name: 'SSH agent' })).toBeChecked()
  await expect(dialog.getByText(/Uses the keys in your SSH agent/)).toBeVisible()
  await expect(passwordField).toHaveCount(0)

  await signInWith(dialog, 'Key file')
  await expect(dialog.getByRole('textbox', { name: 'Key file', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Browse…' })).toBeVisible()
  await expect(dialog.getByLabel('Passphrase')).toHaveAttribute('type', 'password')

  await signInWith(dialog, 'Password')
  await expect(dialog.getByRole('textbox', { name: 'Key file', exact: true })).toHaveCount(0)
  await expect(passwordField).toHaveCount(1)
})

test('a relative path is refused', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddSshSource(window)
  await dialog.getByLabel('Host').fill('web-1')
  await dialog.getByLabel('User').fill('ops')
  await dialog.getByLabel('Path').fill('var/log')
  await signInWith(dialog, 'Key file')
  await dialog.getByRole('textbox', { name: 'Key file', exact: true }).fill('/keys/id_ed25519')

  await dialog.getByRole('button', { name: 'Add Source' }).click()

  await expect(dialog.getByRole('alert')).toHaveText('Enter an absolute path, like /var/log.')
})

test('testing a connection to an unknown host shows its fingerprint, and trusting it lets the test pass', async () => {
  const keyFile = join(dir, 'id_ed25519')
  await writeFile(keyFile, server.clientKey)
  const path = await server.seed({ 'app.log': 'hello' })
  const window = await app.firstWindow()
  const dialog = await openAddSshSource(window)
  await dialog.getByLabel('Host').fill(server.host)
  await dialog.getByLabel('Port').fill(String(server.port))
  await dialog.getByLabel('User').fill(server.user)
  await dialog.getByLabel('Path').fill(path)
  await signInWith(dialog, 'Key file')
  await dialog.getByRole('textbox', { name: 'Key file', exact: true }).fill(keyFile)

  await dialog.getByRole('button', { name: 'Test connection' }).click()

  await expect(dialog.getByText(/hasn’t seen 127\.0\.0\.1’s host key before/)).toBeVisible()
  await expect(dialog.getByText('Key type: ssh-ed25519')).toBeVisible()
  await expect(dialog.getByText(/^Fingerprint: SHA256:/)).toBeVisible()

  await dialog.getByRole('button', { name: 'Trust and test again' }).click()

  await expect(dialog.getByText('Connection succeeded.')).toBeVisible()
  expect(await readFile(join(home, '.ssh', 'known_hosts'), 'utf8')).toBe('')
})
