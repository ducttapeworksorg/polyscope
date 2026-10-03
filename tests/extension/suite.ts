// The Extension Copy driven in real VS Code (see run.ts), checked through VS Code's API: what the editor sees.
// Run twice against the same VS Code profile, the second time as if the window had been reloaded.

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as vscode from 'vscode'
import type { TestApi } from '../../src/extension/extension'
import { polyscopeUri as uriOf } from '../../src/extension/polyscope-uri'

const phase = process.env['POLYSCOPE_TEST_PHASE']
/** The Local Source's root, in a folder of the test run's own. */
const files = process.env['POLYSCOPE_TEST_FILES'] ?? ''

const hello = 'hello from Polyscope\n'
const log = '2026-10-03 INFO started\n2026-10-03 WARN slow\n'

async function extension() {
  const api = await vscode.extensions.getExtension<TestApi>('ducttapeworks.polyscope')?.activate()
  assert.ok(api, 'The extension gives its tests their API')
  return api
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** Waits for `check` to pass, trying again until `timeout` runs out. */
async function eventually(check: () => void | Promise<void>, timeout = 15_000) {
  const until = Date.now() + timeout
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() > until) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

const firstRun: [string, () => Promise<void>][] = [
  [
    'the activity bar opens the Polyscope sidebar',
    async () => {
      await vscode.commands.executeCommand('workbench.view.extension.polyscope')
      await vscode.commands.executeCommand('polyscope.sources.focus')
    }
  ],
  [
    'a Local Source’s files read through VS Code’s file system, compressed ones decompressed, connecting the Source',
    async () => {
      await writeFile(join(files, 'hello.txt'), hello)
      await writeFile(join(files, 'app.log.gz'), gzipSync(log))
      const { core } = await extension()
      const source = await core.addSource({ type: 'local', name: 'Files', rootPath: files })
      // For the reloaded window, which reads it before waking the extension.
      await writeFile(join(files, '..', 'source-id'), source.id)

      assert.equal(text(await vscode.workspace.fs.readFile(uriOf(source.id, 'hello.txt'))), hello)
      assert.equal(text(await vscode.workspace.fs.readFile(uriOf(source.id, 'app.log.gz'))), log)
      assert.deepEqual(await core.connectionState(source.id), { state: 'connected' })
    }
  ],
  [
    'the files are read-only',
    async () => {
      const { core } = await extension()
      const [source] = await core.listSources()

      assert.equal(vscode.workspace.fs.isWritableFileSystem('polyscope'), false)
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(uriOf(source!.id, 'hello.txt'), Buffer.from('changed'))))
    }
  ],
  [
    'a file of a Disconnected Source reads, connecting it',
    async () => {
      const { core } = await extension()
      const [source] = await core.listSources()
      await core.disconnect(source!.id)

      assert.equal(text(await vscode.workspace.fs.readFile(uriOf(source!.id, 'hello.txt'))), hello)
      assert.deepEqual(await core.connectionState(source!.id), { state: 'connected' })
    }
  ],
  [
    'opening a file from the sidebar opens it in a text editor tab',
    async () => {
      const { core, open } = await extension()
      const [source] = await core.listSources()

      await open({ kind: 'file', sourceId: source!.id, path: 'hello.txt', pinned: true })

      await eventually(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
        assert.ok(input instanceof vscode.TabInputText, 'A text editor tab is active')
        assert.equal(input.uri.toString(), uriOf(source!.id, 'hello.txt').toString())
      })
    }
  ]
]

// VS Code's test windows exit without saving their layout, so no tab is actually restored: the test opens the file
// as VS Code does to restore one, before anything else has woken the extension or connected the Source.
const reloaded: [string, () => Promise<void>][] = [
  [
    'a polyscope tab restored after reloading the window activates the extension and shows its file again',
    async () => {
      const polyscope = vscode.extensions.getExtension<TestApi>('ducttapeworks.polyscope')
      assert.equal(polyscope?.isActive, false, 'Nothing has woken the extension yet')
      const [sourceId] = (await vscode.workspace.fs.readFile(vscode.Uri.file(join(files, '..', 'source-id')))).toString().split('\n')
      const uri = uriOf(sourceId!, 'hello.txt')

      const editor = await vscode.window.showTextDocument(uri)

      assert.equal(editor.document.getText(), hello)
      assert.deepEqual(await polyscope.exports.core.connectionState(sourceId!), { state: 'connected' })
    }
  ],
  [
    'Sources survive reloading the window',
    async () => {
      const { core } = await extension()

      assert.deepEqual(
        (await core.listSources()).map(({ name }) => name),
        ['Files']
      )
    }
  ]
]

/** Runs this phase's tests in order, as VS Code's test runner calls it; failing if any of them fails. */
export async function run(): Promise<void> {
  const tests = phase === 'reloaded' ? reloaded : firstRun
  const failures: string[] = []
  for (const [name, test] of tests) {
    try {
      await test()
      console.log(`  ✓ ${name}`)
    } catch (error) {
      failures.push(name)
      console.error(`  ✗ ${name}\n`, error)
    }
  }
  if (failures.length) throw new Error(`${failures.length} of ${tests.length} failed: ${failures.join('; ')}`)
}
