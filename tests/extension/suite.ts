// The Extension Copy driven in real VS Code (see run.mts), checked through VS Code's API: what the editor sees.
// Run twice against the same VS Code profile, the second time as if the window had been reloaded.

import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as vscode from 'vscode'
import type { FollowEvent } from '@shared/core-api'
import { MB } from '@shared/settings'
import { kubeConfigFor } from '../../src/main/core/kubeconfig'
import { execInPod } from '../../src/main/core/kubernetes-exec'
import { startTestApiServer } from '../../src/main/core/kubernetes-test-api-server'
import {
  hasTestCluster,
  podsNamed,
  restartedOnceNamespace,
  seedContainerFolder,
  testFilesNamespace,
  testKubernetesFilesSource,
  testKubernetesLogsSource,
  tickerNamespace
} from '../../src/main/core/kubernetes-test-cluster'
import { hasTestStore, seedPrefix, testS3Source } from '../../src/main/core/s3-test-store'
import type { TestApi } from '../../src/extension/extension'
import { polyscopeLogUri as logUriOf, polyscopeUri as uriOf } from '../../src/extension/polyscope-uri'
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

/** The active tab, once it's the Polyscope viewer tab `label`led so: not one an earlier test left open. */
const activeViewerTab = (label: string) => {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab
  assert.ok(tab?.input instanceof vscode.TabInputWebview, 'A webview tab is active')
  // VS Code prefixes the view type of the webview tabs it reports.
  assert.ok(tab.input.viewType.endsWith(viewerViewType), `A Polyscope viewer tab is active, not ${tab.input.viewType}`)
  assert.equal(tab.label, label, 'The viewer tab just opened is active')
  return tab
}

/** The active tab's URI, or its kind if it has none, to tell that nothing else opened. */
const activeTab = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputText ? input.uri.toString() : input?.constructor.name
}

/** What `uri` shows, once it's open in the active text editor tab. */
async function shownInTextTab(uri: vscode.Uri) {
  await eventually(() => assert.equal(activeTextTab().uri.toString(), uri.toString()))
  const document = await eventually(() => {
    const found = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === uri.toString())
    assert.ok(found, `${uri.toString()} is open`)
    return found
  })
  return document.getText()
}

const ownViewerSetting = () => vscode.workspace.getConfiguration('polyscope').inspect<boolean>('ownViewer')

/** Runs `test` with `polyscope.ownViewer` set as the user would in their settings, then leaves it unset again. */
async function withOwnViewer(on: boolean, test: () => Promise<void>) {
  await vscode.workspace.getConfiguration('polyscope').update('ownViewer', on, vscode.ConfigurationTarget.Global)
  try {
    await test()
  } finally {
    await vscode.workspace.getConfiguration('polyscope').update('ownViewer', undefined, vscode.ConfigurationTarget.Global)
  }
}

/** Runs `test` with the Large File threshold at 1 MB and the "open anyway" limit at 2 MB, then puts them back. */
async function withSmallLimits(core: TestApi['core'], test: () => Promise<void>) {
  const { largeFileThreshold, openAnywayLimit, cacheSizeCap } = await core.getSettings()
  await core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: 2 * MB, cacheSizeCap: 4 * MB })
  try {
    await test()
  } finally {
    await core.updateSettings({ largeFileThreshold, openAnywayLimit, cacheSizeCap })
  }
}

/** The kubeconfig user of withLogsSource's context by default: a token, which the stand-in takes without checking. */
const tokenUser = ['    token: not-a-real-token']

/**
 * Runs `test` with a Kubernetes Logs Source of a stand-in API server, whose pod `counter` logs `line 1` to `line 3`,
 * then deletes the Source. `user` is the kubeconfig user's settings; given a `token`, the stand-in asks for it.
 */
async function withLogsSource(
  core: TestApi['core'],
  test: (sourceId: string) => Promise<void>,
  { user = tokenUser, token }: { user?: string[]; token?: string } = {}
) {
  const server = await startTestApiServer({ token })
  const kubeconfig = join(tmpdir(), `polyscope-kubeconfig-${process.pid}`)
  await writeFile(
    kubeconfig,
    [
      'apiVersion: v1',
      'kind: Config',
      'current-context: fake',
      'clusters:',
      '- name: fake',
      '  cluster:',
      `    server: ${server.url}`,
      `    certificate-authority: ${JSON.stringify(server.caPath)}`,
      // The stand-in's certificate is for localhost.
      '    tls-server-name: localhost',
      'users:',
      '- name: fake',
      '  user:',
      ...user,
      'contexts:',
      '- name: fake',
      '  context:',
      '    cluster: fake',
      '    user: fake'
    ].join('\n')
  )
  // The extension host is this process, so its core reads this kubeconfig.
  const before = process.env['KUBECONFIG']
  process.env['KUBECONFIG'] = kubeconfig
  const source = await core.addSource({ type: 'kubernetesLogs', name: 'Cluster', context: 'fake', namespace: 'shop' })
  try {
    await test(source.id)
  } finally {
    await core.deleteSource(source.id)
    if (before === undefined) delete process.env['KUBECONFIG']
    else process.env['KUBECONFIG'] = before
    await server.close()
    await rm(kubeconfig, { force: true })
  }
}

const counterLog = { kind: 'log', path: 'pods/counter/counter', name: 'counter', pinned: true } as const

/**
 * Runs `test` with an exec auth plugin standing in for `aws`, `gke-gcloud-auth-plugin` or `kubelogin`, given the
 * kubeconfig user that runs it and the token it prints, as withLogsSource takes them. Elsewhere it's a script found on
 * PATH, as they are; Windows runs only executables without a shell, so there it's VS Code's own, running as Node.
 */
async function withExecPlugin(test: (signIn: { user: string[]; token: string }) => Promise<void>) {
  const token = 'from-the-plugin'
  const credential = JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token } })
  const exec = ['    exec:', '      apiVersion: client.authentication.k8s.io/v1']
  if (process.platform === 'win32') {
    const print = `process.stdout.write(${JSON.stringify(credential)})`
    const args = ['      args:', '      - -e', `      - ${JSON.stringify(print)}`]
    const env = ['      env:', '      - name: ELECTRON_RUN_AS_NODE', '        value: "1"']
    return test({ user: [...exec, `      command: ${JSON.stringify(process.execPath)}`, ...args, ...env], token })
  }
  const dir = await mkdtemp(join(tmpdir(), 'polyscope-auth-plugin-'))
  await writeFile(join(dir, 'polyscope-test-auth'), `#!/bin/sh\nprintf '%s' '${credential}'\n`, { mode: 0o755 })
  // The extension host is this process, so its core runs the plugin with this PATH.
  const before = process.env['PATH'] ?? ''
  process.env['PATH'] = [dir, before].filter(Boolean).join(delimiter)
  try {
    await test({ user: [...exec, '      command: polyscope-test-auth'], token })
  } finally {
    process.env['PATH'] = before
    await rm(dir, { recursive: true, force: true })
  }
}

/** The S3 Source signing in with keys that the S3 tests share, and its seeded prefix; the last of them deletes both. */
let sharedSource: { sourceId: string; prefix: string; remove: () => Promise<void> } | undefined
const sharedS3Source = () => {
  assert.ok(sharedSource, 'The S3 Source was added')
  return sharedSource
}

const objectText = 'an object in S3\n'

/** Checks that the S3 object `a.log` reads through VS Code's file system, which needs the Source to sign in. */
async function readsObject(sourceId: string) {
  assert.equal(text(await vscode.workspace.fs.readFile(uriOf(sourceId, 'a.log'))), objectText)
}

/** Runs `test` with the AWS SDK reading a credentials file of its own, holding the test store's keys as `polyscope`. */
async function withAwsProfile(test: () => Promise<void>) {
  const { accessKeyId, secretAccessKey } = testS3Source('', '')
  const credentials = join(tmpdir(), `polyscope-aws-credentials-${process.pid}`)
  const config = join(tmpdir(), `polyscope-aws-config-${process.pid}`)
  await writeFile(credentials, `[polyscope]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`)
  await writeFile(config, '')
  // The extension host is this process, so its core reads these files, as with the kubeconfig above.
  const names = ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = credentials
  process.env['AWS_CONFIG_FILE'] = config
  try {
    await test()
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(credentials, { force: true })
    await rm(config, { force: true })
  }
}

// Against the test S3 store, as the core's S3 tests; skipped without one.
const firstRunS3: [string, () => Promise<void>][] = [
  [
    'an S3 Source signing in with keys connects, and its objects read through VS Code’s file system',
    async () => {
      const { core, open } = await extension()
      const { prefix, remove } = await seedPrefix({ 'a.log': objectText, 'logs/b.log': 'b\n' })
      const source = await core.addSource(testS3Source('Bucket', prefix))
      sharedSource = { sourceId: source.id, prefix, remove }

      assert.deepEqual((await core.connect(source.id)).map((node) => ('name' in node ? node.name : node.kind)).sort(), ['a.log', 'logs'])
      await readsObject(source.id)
      await open({ kind: 'file', sourceId: source.id, path: 'a.log', name: 'a.log', pinned: true })
      await eventually(() => assert.equal(activeTextTab().uri.toString(), uriOf(source.id, 'a.log', source.name).toString()))
    }
  ],
  [
    'an S3 Source keeps its secret key when edited without retyping it',
    async () => {
      const { core } = await extension()
      const { sourceId, prefix } = sharedS3Source()
      const { secretAccessKey: _, ...settings } = testS3Source('Bucket', prefix)

      const edited = await core.editSource(sourceId, settings)
      await core.disconnect(sourceId)

      assert.equal(edited.type === 's3' && edited.secretKeySet, true)
      await readsObject(sourceId)
    }
  ],
  [
    'duplicating an S3 Source copies its secret key, and deleting the copy forgets the copy’s alone',
    async () => {
      const { core, secrets } = await extension()
      const { sourceId } = sharedS3Source()

      const copy = await core.duplicateSource(sourceId)
      assert.equal(copy.type === 's3' && copy.secretKeySet, true)
      await readsObject(copy.id)

      await core.deleteSource(copy.id)
      assert.equal(await secrets.get(copy.id, 'secretKey'), undefined)
      assert.ok(await secrets.get(sourceId, 'secretKey'), 'The original keeps its secret key')
    }
  ],
  [
    // VS Code keeps SecretStorage in memory in a test run, so the reloaded window can't check this (see run.mts): a core
    // started afresh stands in for the reloaded window's, knowing only what the extension's data and SecretStorage hold.
    'an S3 Source’s secret key survives a reload, signing in a core started afresh',
    async () => {
      const { startCore } = await extension()
      const { sourceId } = sharedS3Source()
      const reloaded = startCore()

      const source = (await reloaded.listSources()).find(({ id }) => id === sourceId)
      assert.equal(source?.type === 's3' && source.secretKeySet, true)
      assert.ok((await reloaded.connect(sourceId)).some((node) => 'name' in node && node.name === 'a.log'))
      await reloaded.disconnect(sourceId)
    }
  ],
  [
    'deleting an S3 Source forgets its secret key',
    async () => {
      const { core, secrets } = await extension()
      const { sourceId, remove } = sharedS3Source()

      try {
        await core.deleteSource(sourceId)
        assert.equal(await secrets.get(sourceId, 'secretKey'), undefined)
      } finally {
        await remove()
      }
    }
  ],
  [
    'a Large S3 object opens in a viewer tab',
    async () => {
      const { core, open } = await extension()
      const { prefix, remove } = await seedPrefix({ 'big.log': 'a line of a Large File\n'.repeat(50_000) })
      const source = await core.addSource(testS3Source('Large', prefix))

      try {
        // As expanding it in the sidebar does, before any of its files can be opened.
        await core.connect(source.id)
        await withSmallLimits(core, async () => {
          await open({ kind: 'file', sourceId: source.id, path: 'big.log', name: 'big.log', pinned: true })
          await eventually(() => activeViewerTab('big.log'))
        })
      } finally {
        await core.deleteSource(source.id)
        await remove()
      }
    }
  ],
  [
    'an S3 Source signing in with an AWS profile connects',
    async () => {
      const { core } = await extension()
      const { prefix, remove } = await seedPrefix({ 'a.log': objectText })
      const { accessKeyId: _, secretAccessKey: __, ...settings } = testS3Source('Profile', prefix)

      await withAwsProfile(async () => {
        const source = await core.addSource({ ...settings, auth: 'profile', profile: 'polyscope' })
        try {
          await readsObject(source.id)
        } finally {
          await core.deleteSource(source.id)
          await remove()
        }
      })
    }
  ]
]

/** A tree node's name, or its kind if it has none (an error's). */
const nameOf = (node: { kind: string; name?: string }) => node.name ?? node.kind

/** Collects the lines every Follow gets from now on, until `unsubscribe`. */
function followedLines(core: TestApi['core']) {
  const lines: FollowEvent[] = []
  const unsubscribe = core.onFollowEvent((event) => event.kind === 'lines' && lines.push(event))
  return { lines, unsubscribe }
}

// Against the test cluster, as the core's Kubernetes tests; skipped without one.
const firstRunKubernetes: [string, () => Promise<void>][] = [
  [
    'a Kubernetes Logs Source lists Workloads with their Ready Count, and their pods with their Pod Status',
    async () => {
      const { core } = await extension()
      const source = await core.addSource(testKubernetesLogsSource())

      try {
        await core.connect(source.id)

        const web = (await core.expand(source.id, 'deployments')).find((node) => nameOf(node) === 'web')
        assert.ok(web?.kind === 'workload')
        const { pod: folded, ...workload } = web
        assert.deepEqual(workload, { kind: 'workload', workloadKind: 'Deployment', name: 'web', path: 'deployments/web', readyCount: { ready: 1, desired: 1 } })
        // Its only pod, folded into its row, and still its child.
        assert.deepEqual(folded?.status, { reason: 'Running', health: 'healthy', restarts: 0 })
        assert.deepEqual(await core.expand(source.id, 'deployments/web'), [folded])
      } finally {
        await core.deleteSource(source.id)
      }
    }
  ],
  [
    'a Kubernetes Log Stream opens in a viewer tab, whose Follow gets what the container logs until the tab is closed',
    async () => {
      const { core, open } = await extension()
      const namespace = `polyscope-vscode-follow-${process.pid}`
      // Logs a line a second, for longer than the test takes.
      const { remove } = await tickerNamespace(namespace, 3_600)
      const source = await core.addSource(testKubernetesLogsSource('Ticker', namespace))
      const { lines, unsubscribe } = followedLines(core)

      try {
        // As expanding it in the sidebar does, before any of its logs can be opened.
        await core.connect(source.id)
        await open({ kind: 'log', sourceId: source.id, path: 'pods/ticker/ticker', name: 'ticker', pinned: true })
        const tab = await eventually(() => activeViewerTab('ticker'))
        const followId = await eventually(() => {
          assert.ok(lines[0], 'The viewer tab’s Follow got the lines logged')
          return lines[0].followId
        }, 30_000)

        await vscode.window.tabGroups.close(tab)
        await sleep(1_000)
        lines.length = 0
        await sleep(3_000)

        assert.deepEqual(
          lines.filter((event) => event.followId === followId),
          [],
          'The closed tab’s Follow was stopped'
        )
      } finally {
        unsubscribe()
        await core.deleteSource(source.id)
        await remove()
      }
    }
  ],
  [
    'a restarted container lists no Previous Log of its own, and opens in a viewer tab that can switch to it',
    async () => {
      const { core, open } = await extension()
      const namespace = `polyscope-vscode-previous-${process.pid}`
      // Crashed on its first run, logging "crashing", then kept running.
      const { remove } = await restartedOnceNamespace(namespace)
      const source = await core.addSource(testKubernetesLogsSource('Restarted', namespace))
      const container = 'pods/restarted/restarted'

      try {
        await core.connect(source.id)
        assert.deepEqual((await core.expand(source.id, 'pods/restarted')).map(nameOf), ['restarted'])

        await open({ kind: 'log', sourceId: source.id, path: container, name: 'restarted', pinned: true })
        const tab = await eventually(() => activeViewerTab('restarted'))
        await vscode.window.tabGroups.close(tab)

        // What the viewer tab's Previous toggle reads.
        assert.deepEqual(await core.openLog(source.id, container, { previous: true }).then(({ content, restarted }) => ({ content, restarted })), {
          content: 'crashing',
          restarted: true
        })
      } finally {
        await core.deleteSource(source.id)
        await remove()
      }
    }
  ],
  [
    'a Kubernetes Files Source shows a folder for each pod, whose files read and open in a text editor tab, and Follow in a viewer tab',
    async () => {
      const { core, open } = await extension()
      const pods = await podsNamed('files-busybox')
      const pod = pods[0]!
      const seeded = await seedContainerFolder(pod, { 'app.log': 'one\ntwo\n' })
      const source = await core.addSource(testKubernetesFilesSource({ path: seeded.path }))
      const file = `${pod}/app.log`
      const config = kubeConfigFor(testKubernetesFilesSource().context)
      const target = { namespace: testFilesNamespace, pod, container: 'app' }
      const append = () => execInPod(config, target, ['sh', '-c', 'echo more >> "$1"', 'sh', `${seeded.path}/app.log`])
      const { lines, unsubscribe } = followedLines(core)

      try {
        // Read while Disconnected, which connects it, as for a tab VS Code restores.
        const folders = await vscode.workspace.fs.readDirectory(uriOf(source.id, ''))
        assert.deepEqual(folders.sort(), pods.map((name) => [name, vscode.FileType.Directory]))
        assert.equal(text(await vscode.workspace.fs.readFile(uriOf(source.id, file))), 'one\ntwo\n')

        await open({ kind: 'file', sourceId: source.id, path: file, name: 'app.log', pinned: true })
        assert.equal(await shownInTextTab(uriOf(source.id, file, source.name)), 'one\ntwo\n')

        await open({ kind: 'follow', sourceId: source.id, path: file, name: 'app.log', pinned: true })
        const tab = await eventually(() => activeViewerTab('app.log'))
        // The tab follows once its page has loaded; until then, what's appended goes unseen.
        await eventually(async () => {
          await append()
          await sleep(1_000)
          assert.ok(lines.length, 'The viewer tab’s Follow got the appended lines')
        }, 60_000)
        await vscode.window.tabGroups.close(tab)
      } finally {
        unsubscribe()
        await core.deleteSource(source.id)
        await seeded.remove()
      }
    }
  ]
]

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
    'opening a file from the sidebar opens it in a text editor tab, named after the file and labelled with its Source',
    async () => {
      const { core, open } = await extension()
      const [source] = await core.listSources()

      await open({ kind: 'file', sourceId: source!.id, path: 'hello.txt', name: 'hello.txt', pinned: true })

      // The manifest's label formatter describes it by its query's Source name and its path: `Files: /hello.txt`.
      await eventually(() => assert.equal(activeTextTab().uri.toString(), uriOf(source!.id, 'hello.txt', 'Files').toString()))
      assert.equal(JSON.parse(activeTextTab().uri.query).source, 'Files')
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'hello.txt')
    }
  ],
  [
    'a polyscope tab of a Source labelled with an Environment, like the Protected prod, is tinted with its colour, and again when it changes',
    async () => {
      const { core, tabDecorations, shell } = await extension()
      const [source] = await core.listSources()
      const environments = await core.listEnvironments()
      const prod = environments.find(({ name }) => name === 'prod')!
      const uri = uriOf(source!.id, 'hello.txt', source!.name)
      const decorationOf = async () => {
        const decoration = await tabDecorations.provideFileDecoration(uri, new vscode.CancellationTokenSource().token)
        return decoration && { color: decoration.color?.id, tooltip: decoration.tooltip }
      }
      const changed: unknown[] = []
      const listening = tabDecorations.onDidChangeFileDecorations?.((event) => changed.push(event))
      assert.equal(prod.protected, true)
      assert.equal(await decorationOf(), undefined, 'An unlabelled Source’s tabs aren’t tinted')

      try {
        await core.editSource(source!.id, { type: 'local', name: 'Files', rootPath: files, environmentId: prod.id })
        shell.sourcesChanged()

        assert.deepEqual(await decorationOf(), { color: 'polyscope.environment.red', tooltip: 'prod' })
        assert.equal(changed.length, 1, 'VS Code is told to decorate polyscope tabs again')
      } finally {
        listening?.dispose()
        await core.editSource(source!.id, { type: 'local', name: 'Files', rootPath: files })
      }
    }
  ],
  [
    'Settings show the extension’s version and open its VS Code settings',
    async () => {
      const { shell } = await extension()
      const polyscope = vscode.extensions.getExtension('ducttapeworks.polyscope')!

      assert.equal(await shell.appVersion(), polyscope.packageJSON.version)
      await shell.openExtensionSettings()

      await eventually(() => assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Settings'))
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }
  ],
  [
    'Copy diagnostics puts a redacted report with the VS Code version on VS Code’s clipboard',
    async () => {
      const { shell } = await extension()

      await shell.copyDiagnostics()

      const report = await vscode.env.clipboard.readText()
      assert.match(report, /^### Polyscope diagnostics\n/)
      assert.ok(report.includes(`- VS Code: ${vscode.version} (${vscode.env.appName})\n`), report)
      assert.ok(report.includes(`- Extension host: Node.js ${process.versions.node}\n`), report)
      assert.ok(report.includes('started (VS Code'), 'The recent log is in it')
      assert.ok(!report.includes(homedir()), 'The home folder is redacted')
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
        const tab = await eventually(() => activeViewerTab('growing.log'))
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
        await eventually(() => activeViewerTab('big.log'))
        await eventually(() => assert.ok(opened.length, 'The viewer tab opened the Large File'), 30_000)

        await open({ ...request, inEditor: true })
        await eventually(() => assert.equal(activeTextTab().uri.toString(), uriOf(source!.id, 'big.log', 'Files').toString()))
      } finally {
        unsubscribe()
        const { largeFileThreshold, openAnywayLimit, cacheSizeCap } = before
        await core.updateSettings({ largeFileThreshold, openAnywayLimit, cacheSizeCap })
      }
    }
  ],
  [
    'polyscope.ownViewer is a setting of VS Code’s, on by default',
    async () => {
      await extension()

      assert.equal(ownViewerSetting()?.defaultValue, true)
    }
  ],
  [
    'with ownViewer on, a Log Stream opens in a viewer tab',
    async () => {
      const { core, open } = await extension()

      await withLogsSource(core, async (sourceId) => {
        await open({ ...counterLog, sourceId })

        await eventually(() => activeViewerTab(counterLog.name))
      })
    }
  ],
  [
    'with ownViewer off, a Log Stream opens in a text editor tab with its Source’s Last N lines',
    async () => {
      const { core, open } = await extension()

      await withOwnViewer(false, () =>
        withLogsSource(core, async (sourceId) => {
          await core.rememberLastNLines(sourceId, 2)

          await open({ ...counterLog, sourceId })

          assert.equal(await shownInTextTab(logUriOf(sourceId, counterLog.path, 'Cluster')), 'line 2\nline 3')
        })
      )
    }
  ],
  [
    'a kubeconfig context signing in with an exec auth plugin connects',
    async () => {
      const { core } = await extension()

      await withExecPlugin((signIn) =>
        withLogsSource(
          core,
          async (sourceId) => {
            await core.connect(sourceId)

            assert.deepEqual((await core.expand(sourceId, 'pods')).map(nameOf), ['counter'])
          },
          signIn
        )
      )
    }
  ],
  [
    'with ownViewer off, a Large File within the "open anyway" limit opens in a text editor tab, and no Follow opens',
    async () => {
      const { core, open } = await extension()
      const [source] = await core.listSources()
      await writeFile(join(files, 'big.log'), 'a line of a Large File\n'.repeat(50_000))
      const big = uriOf(source!.id, 'big.log', 'Files').toString()

      await withOwnViewer(false, () =>
        withSmallLimits(core, async () => {
          await open({ kind: 'file', sourceId: source!.id, path: 'big.log', name: 'big.log', pinned: true })
          await eventually(() => assert.equal(activeTextTab().uri.toString(), big))

          await open({ kind: 'follow', sourceId: source!.id, path: 'growing.log', name: 'growing.log', pinned: true })
          await sleep(1_000)
          assert.equal(activeTab(), big, 'Nothing else opened')
        })
      )
    }
  ],
  [
    'with ownViewer off, a file over the "open anyway" limit is refused, the notification’s button turning ownViewer on and opening it in a viewer tab',
    async () => {
      const { core, open, answerNotifications } = await extension()
      const [source] = await core.listSources()
      await writeFile(join(files, 'huge.log'), 'a line of a huge file\n'.repeat(100_000))
      const request = { kind: 'file', sourceId: source!.id, path: 'huge.log', name: 'huge.log', pinned: true } as const
      const notified: { message: string; actions: string[] }[] = []

      await withOwnViewer(false, () =>
        withSmallLimits(core, async () => {
          const before = activeTab()
          answerNotifications((message, actions) => void notified.push({ message, actions }))
          await open(request)
          await eventually(() => assert.equal(notified.length, 1))
          assert.match(notified[0]!.message, /huge\.log is too large for VS Code’s editor/)
          await sleep(500)
          assert.equal(activeTab(), before, 'Nothing opened')
          assert.equal(ownViewerSetting()?.globalValue, false)

          // Its button, which turns ownViewer on: the next open goes by it, without a reload.
          answerNotifications((_, [useOwnViewer]) => useOwnViewer)
          await open(request)

          await eventually(() => activeViewerTab('huge.log'))
          assert.equal(ownViewerSetting()?.globalValue, true)
        })
      )
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
  const tests = phase === 'reloaded' ? reloaded : [...firstRun, ...(hasTestCluster ? firstRunKubernetes : []), ...(hasTestStore ? firstRunS3 : [])]
  if (phase !== 'reloaded' && !hasTestCluster) {
    console.log(`  - ${firstRunKubernetes.length} Kubernetes tests skipped: POLYSCOPE_TEST_KUBE_CONTEXT isn’t set`)
  }
  if (phase !== 'reloaded' && !hasTestStore) console.log(`  - ${firstRunS3.length} S3 tests skipped: POLYSCOPE_TEST_S3_ENDPOINT isn’t set`)
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
