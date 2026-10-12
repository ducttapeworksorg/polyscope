import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
    env: { ...process.env, DOCKER_HOST: engine.host }
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
