import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { writeDockerConfig } from '../../src/main/core/docker-test-config'
import { startTestDockerEngine, type TestDockerEngine } from '../../src/main/core/docker-test-engine'

let dir: string
let app: ElectronApplication
let engine: TestDockerEngine

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-smoke-'))
  engine = await startTestDockerEngine([
    { name: 'shop-web-1', labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' } },
    { name: 'redis', logs: [{ stream: 'stdout', time: '2026-10-12T10:00:00.000000000Z', text: 'Ready to accept connections' }] }
  ])
  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js'), `--user-data-dir=${join(dir, 'user-data')}`],
    env: {
      ...process.env,
      DOCKER_HOST: engine.host,
      DOCKER_CONTEXT: '',
      DOCKER_CONFIG: await writeDockerConfig({
        currentContext: 'podman',
        contexts: [
          { name: 'podman', host: engine.host },
          { name: 'build-box', host: 'tcp://build.internal:2376' },
          { name: 'vm', host: 'ssh://ops@vm.internal' }
        ]
      })
    }
  })
})

test.afterEach(async () => {
  await app.close()
  await engine.close()
  await rm(dir, { recursive: true, force: true })
})

async function openAddDockerSource(window: Page) {
  await window.getByRole('navigation').getByRole('button', { name: 'Add Source' }).first().click()
  const dialog = window.getByRole('dialog', { name: 'Add Source' })
  await dialog.getByLabel('Source Type').selectOption('dockerLogs')
  return dialog
}

test('a Docker Logs Source uses the default context, is named Docker, and its test tells the engine’s version', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddDockerSource(window)

  await expect(dialog.getByLabel('Context', { exact: true })).toHaveValue('default')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Docker')

  await dialog.getByRole('button', { name: 'Test connection' }).click()

  await expect(dialog.getByText(`Connection succeeded: Docker Engine ${engine.version}.`)).toBeVisible()
})

test('a Docker Logs Source groups its containers by Compose project, the rest under Standalone', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddDockerSource(window)

  await dialog.getByRole('button', { name: 'Add Source' }).click()
  await window.getByRole('treeitem', { name: 'Docker' }).click()

  await expect(window.getByRole('treeitem', { name: 'shop' })).toBeVisible()
  await expect(window.getByRole('treeitem', { name: 'Standalone' })).toBeVisible()
})

test('a Docker Logs Source offers the Docker CLI’s contexts, and is named after the one picked', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddDockerSource(window)
  const context = dialog.getByLabel('Context', { exact: true })

  await expect(context.locator('option')).toHaveText(['default', 'build-box', 'podman', 'vm'])
  await expect(dialog.getByText('the current context, podman')).toBeVisible()

  await context.selectOption('build-box')

  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('build-box')
  await expect(dialog.getByText('Its engine: tcp://build.internal:2376')).toBeVisible()
})

test('a Docker Logs Source asks how to sign in only for an ssh:// context', async () => {
  const window = await app.firstWindow()
  const dialog = await openAddDockerSource(window)
  const signIn = dialog.getByRole('radiogroup', { name: 'Sign in with' })

  await expect(signIn).toBeHidden()

  await dialog.getByLabel('Context', { exact: true }).selectOption('vm')

  await expect(signIn.getByRole('radio', { name: 'SSH agent' })).toBeChecked()
  await signIn.locator('label.segmented__option', { hasText: 'Key file' }).click()
  await expect(dialog.getByRole('textbox', { name: 'Key file', exact: true })).toBeVisible()
})
