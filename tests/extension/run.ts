// Runs the Extension Copy's integration tests (suite.ts) in real VS Code, downloaded into .vscode-test the first
// time: once, then again with the same profile and workspace, as if the window had been reloaded.
// Needs the extension and the suite built first: `npm run test:extension` does both.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTests } from '@vscode/test-electron'

const root = resolve(import.meta.dirname, '..', '..')
const dir = await mkdtemp(join(tmpdir(), 'polyscope-vscode-'))
const workspace = join(dir, 'workspace')
const files = join(dir, 'files')
await mkdir(workspace)
await mkdir(files)

const run = (phase: 'first' | 'reloaded') => {
  console.log(`VS Code, ${phase === 'first' ? 'first run' : 'reloaded'}:`)
  return runTests({
    extensionDevelopmentPath: join(root, 'extension'),
    extensionTestsPath: join(root, 'extension', 'test-dist', 'suite.js'),
    // A workspace, so VS Code restores its editors; a profile of its own, kept between the runs.
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${join(dir, 'user-data')}`],
    extensionTestsEnv: { POLYSCOPE_TEST_PHASE: phase, POLYSCOPE_TEST_FILES: files }
  })
}

try {
  await run('first')
  await run('reloaded')
} finally {
  await rm(dir, { recursive: true, force: true })
}
