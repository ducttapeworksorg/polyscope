// The Extension Copy driven in real VS Code (see run.ts), checked through VS Code's API: what the editor sees.
// Run twice against the same VS Code profile, the second time as if the window had been reloaded.

import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as vscode from 'vscode'
import type { FollowEvent } from '@shared/core-api'
import { MB } from '@shared/settings'
import type { TestApi } from '../../src/extension/extension'
import { polyscopeUri as uriOf } from '../../src/extension/polyscope-uri'
import { viewerViewType } from '../../src/extension/viewer-tab'

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

/** Waits for `check` to pass, trying again until `timeout` runs out; resolves to what it returns. */
async function eventually<T>(check: () => T | Promise<T>, timeout = 15_000): Promise<T> {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The active tab, once it's a text editor tab. */
const activeTextTab = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  assert.ok(input instanceof vscode.TabInputText, 'A text editor tab is active')
  return input
}

/** The active tab, once it's a Polyscope viewer tab. */
const activeViewerTab = () => {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab
  assert.ok(tab?.input instanceof vscode.TabInputWebview, 'A webview tab is active')
  // VS Code prefixes the view type of the webview tabs it reports.
  assert.ok(tab.input.viewType.endsWith(viewerViewType), `A Polyscope viewer tab is active, not ${tab.input.viewType}`)
  return tab
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

      await open({ kind: 'file', sourceId: source!.id, path: 'hello.txt', name: 'hello.txt', pinned: true })

      await eventually(() => assert.equal(activeTextTab().uri.toString(), uriOf(source!.id, 'hello.txt').toString()))
    }
  ],
  [
    'following a file opens a viewer tab, whose Follow gets the lines appended to the file until the tab is closed',
    async () => {
      const { core, open } = await extension()
      const [source] = await core.listSources()
      const file = join(files, 'growing.log')
      await writeFile(file, 'line 1\n')
      const lines: FollowEvent[] = []
      const unsubscribe = core.onFollowEvent((event) => event.kind === 'lines' && lines.push(event))

      try {
        await open({ kind: 'follow', sourceId: source!.id, path: 'growing.log', name: 'growing.log', pinned: true })
        const tab = await eventually(activeViewerTab)
        // The tab follows once its page has loaded; until then, what's appended goes unseen.
        await eventually(async () => {
          await appendFile(file, 'more\n')
          await sleep(500)
          assert.ok(lines.length, 'The viewer tab’s Follow got the appended lines')
        }, 30_000)
        const [{ followId }] = lines as [FollowEvent]

        await vscode.window.tabGroups.close(tab)
        await sleep(500)
        lines.length = 0
        await appendFile(file, 'after closing\n')
        await sleep(2_000)

        assert.deepEqual(
          lines.filter((event) => event.followId === followId),
          [],
          'The closed tab’s Follow was stopped'
        )
      } finally {
        unsubscribe()
      }
    }
  ],
  [
    'a Large File opens in a viewer tab, and in a text editor tab when opened anyway',
    async () => {
      const { core, open } = await extension()
      const [source] = await core.listSources()
      const before = await core.getSettings()
      await core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: 2 * MB, cacheSizeCap: 4 * MB })
      await writeFile(join(files, 'big.log'), 'a line of a Large File\n'.repeat(50_000))
      const opened: string[] = []
      const unsubscribe = core.onLargeFileEvent(({ largeFileId }) => opened.push(largeFileId))
      const request = { kind: 'file', sourceId: source!.id, path: 'big.log', name: 'big.log', pinned: true } as const

      try {
        await open(request)
        await eventually(activeViewerTab)
        await eventually(() => assert.ok(opened.length, 'The viewer tab opened the Large File'), 30_000)

        await open({ ...request, inEditor: true })
        await eventually(() => assert.equal(activeTextTab().uri.toString(), uriOf(source!.id, 'big.log').toString()))
      } finally {
        unsubscribe()
        const { largeFileThreshold, openAnywayLimit, cacheSizeCap } = before
        await core.updateSettings({ largeFileThreshold, openAnywayLimit, cacheSizeCap })
      }
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
