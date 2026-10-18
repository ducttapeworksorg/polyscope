import { mkdir } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { commands, ConfigurationTarget, env, EventEmitter, ExtensionMode, ProgressLocation, Uri, version, window, workspace, type ExtensionContext } from 'vscode'
import type { CoreErrorCode, CoreResult, SaveCopyStarted } from '@shared/core-api'
import { createAppLog } from '../main/app-log'
import { resultOf } from '../main/core-call'
import { createCore, type Core } from '../main/core/core'
import { suggestedName } from '../main/core/save-copy'
import type { SecretStore } from '../main/core/secret-store'
import { formatDiagnostics, osDescription } from '../main/diagnostics'
import { t } from '../renderer/src/i18n'
import { formatSize } from '../renderer/src/i18n/format'
import type { HostShell } from './bridge/host'
import type { OpenRequest } from './bridge/protocol'
import { createFileProvider } from './file-provider'
import { polyscopeLogUri, polyscopeScheme, polyscopeUri } from './polyscope-uri'
import { watchSave } from './save-progress'
import { createVsCodeSecretStore } from './secret-storage'
import { registerSidebarView } from './sidebar-view'
import { createTabDecorations, type TabDecorations } from './tab-decorations'
import { openViewerTab } from './viewer-tab'
import type { WebviewOptions } from './webview-page'

/** What the extension hands its integration tests, and nothing else. */
export interface TestApi {
  core: Core
  /** The core's secret store, to tell what became of a Source's secrets. */
  secrets: SecretStore
  /** Starts another core over the extension's data and SecretStorage, as reloading the window does. */
  startCore(): Core
  /** Opens what the sidebar asks for, as it does. */
  open(request: OpenRequest): Promise<void>
  /** What the webviews' bridges ask of VS Code, e.g. copying diagnostics. */
  shell: HostShell
  /** How `polyscope` tabs are decorated. */
  tabDecorations: TabDecorations
  /** Answers the notifications the extension shows from now on in the user's place, with one of their actions or none. */
  answerNotifications(answer: (message: string, actions: string[]) => string | undefined): void
  /** Answers the Save dialogs the extension shows from now on in the user's place, with a place or none, given what's suggested. */
  answerSaveDialogs(answer: (suggested: Uri) => Uri | undefined): void
}

/** Whether `polyscope.ownViewer` is on: Follows, Log Streams and Large Files open in Polyscope's viewer tabs. */
const ownViewer = () => workspace.getConfiguration('polyscope').get<boolean>('ownViewer', true)

/** Turns `polyscope.ownViewer` on, in the workspace's settings if they turn it off, else in the user's. */
async function turnOwnViewerOn() {
  const config = workspace.getConfiguration('polyscope')
  const inWorkspace = config.inspect<boolean>('ownViewer')?.workspaceValue !== undefined
  await config.update('ownViewer', true, inWorkspace ? ConfigurationTarget.Workspace : ConfigurationTarget.Global)
}

export async function activate(context: ExtensionContext): Promise<TestApi | undefined> {
  // An Extension Copy keeps its own Sources and settings, apart from the desktop app's.
  const dataDir = context.globalStorageUri.fsPath
  await mkdir(dataDir, { recursive: true })
  const log = createAppLog({ dir: join(dataDir, 'logs') })
  log.info(`Polyscope ${context.extension.packageJSON.version} started (VS Code ${version}, ${process.platform} ${process.arch})`)
  // Unlike the desktop app (see login-shell-path.ts), the login shell's PATH isn't loaded for kubeconfig exec auth
  // plugins: VS Code starts its extension host, local or remote, with the environment its login shell sets up.
  // ssh2's helper for talking to Pageant, which the build copies beside the bundle (see scripts/build-extension.mts).
  const pageantHelper = join(context.extensionPath, 'dist', 'pagent.exe')
  const startCore = (secrets: SecretStore) => createCore({ dataDir, secrets, ...(process.platform === 'win32' && { pageantHelper }) })
  const secrets = createVsCodeSecretStore(context.secrets)
  const core = startCore(secrets)

  let notify = async (message: string, ...actions: string[]) => window.showWarningMessage(message, ...actions)
  let askWhere = async (suggested: Uri) => window.showSaveDialog({ defaultUri: suggested })
  const ownViewerChanged = new EventEmitter<boolean>()
  const tabDecorations = createTabDecorations(core)
  context.subscriptions.push(
    tabDecorations,
    ownViewerChanged,
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('polyscope.ownViewer') && ownViewerChanged.fire(ownViewer()))
  )

  const shell: HostShell = {
    async pickFolder() {
      const [picked] = (await window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })) ?? []
      return picked?.fsPath ?? null
    },
    async pickFile(filters) {
      const [picked] =
        (await window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: Object.fromEntries(filters.map(({ name, extensions }) => [name, extensions]))
        })) ?? []
      return picked?.fsPath ?? null
    },
    // The same report as the desktop app's, naming VS Code (or the editor it is) and its extension host instead.
    async copyDiagnostics() {
      const report = formatDiagnostics({
        appVersion: context.extension.packageJSON.version as string,
        os: osDescription(release()),
        versions: {
          'VS Code': `${version} (${env.appName})`,
          'Extension host': `Node.js ${process.versions.node}${env.remoteName ? `, remote (${env.remoteName})` : ''}`
        },
        homeDir: homedir(),
        log: await log.recent()
      })
      await env.clipboard.writeText(report)
    },
    copyText: async (text) => env.clipboard.writeText(text),
    saveCopy: (sourceId, path) => saveWith('saveCopy', suggestedName(path), (target) => core.saveCopy(sourceId, path, target)),
    saveLogCopy: (name, text) => saveWith('saveLogCopy', suggestedName(name), (target) => core.saveLogCopy(text, target)),
    appVersion: async () => context.extension.packageJSON.version as string,
    async openExtensionSettings() {
      await commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    },
    open,
    // Only a viewer tab has a title of its own to change; see openViewerTab.
    retitle: async () => {},
    sourcesChanged: () => tabDecorations.refresh(),
    ownViewer: async () => ownViewer(),
    onOwnViewerChanged(listener) {
      const subscription = ownViewerChanged.event(listener)
      return () => subscription.dispose()
    }
  }
  /**
   * Asks where to save a copy named `name`, suggesting it where VS Code's own Save As would: in the workspace's
   * folder, else the home folder of the machine the extension runs on, which under Remote-SSH, WSL or a Dev Container
   * is the remote one. Then saves it there with `start`, showing how it goes in a notification with Cancel, and how
   * it ended unless cancelled, logging a failure to start as `call`'s. Null if no place was picked.
   */
  async function saveWith(call: string, name: string, start: (target: string) => Promise<SaveCopyStarted>): Promise<CoreResult<SaveCopyStarted | null>> {
    const folder = workspace.workspaceFolders?.[0]?.uri ?? Uri.file(homedir())
    const picked = await askWhere(name ? Uri.joinPath(folder, name) : folder)
    if (!picked) return { ok: true, value: null }
    const failed = ({ code, message }: { code: CoreErrorCode; message: string }) => {
      void window.showErrorMessage(`${t('saveCopy.failed', { name })}: ${t(`error.${code}`, { message })}`)
      return { ok: false as const, code, message }
    }
    // Only a place on the machine the extension runs on, which the dialog's "Show Local" under a remote isn't.
    if (picked.scheme !== 'file') return failed({ code: 'SAVE_UNWRITABLE', message: t('saveCopy.notWhereItRuns') })

    const saving = watchSave(core)
    const result = await resultOf(log, call, () => start(picked.fsPath))
    if (!result.ok) {
      saving.stop()
      return failed(result)
    }
    const { saveId, target } = result.value
    void window
      .withProgress({ location: ProgressLocation.Notification, title: t('saveCopy.saving', { name }), cancellable: true }, (progress, cancel) =>
        saving.follow(saveId, { report: (update) => progress.report(update), onCancel: (listener) => void cancel.onCancellationRequested(listener) })
      )
      .then((ended) => {
        if (ended.state === 'saved') void window.showInformationMessage(t('saveCopy.saved', { name, target }))
        if (ended.state === 'failed') failed(ended)
      })
    return result
  }

  const webviewOptions: WebviewOptions = { core, log, shell, webviewRoot: Uri.joinPath(context.extensionUri, 'dist', 'webview') }

  /** The Source's name, to label its tabs by; none if it's gone, which VS Code's editor then shows. */
  const sourceNameOf = async (sourceId: string) => (await core.listSources()).find(({ id }) => id === sourceId)?.name

  /** Whether a file is a Large File; if that can't be told, VS Code's editor shows why it can't be read either. */
  const isLargeFile = ({ sourceId, path }: OpenRequest) => core.isLargeFile(sourceId, path).catch(() => false)
  /** Whether a file is over the "open anyway" limit; if that can't be told, VS Code's editor shows why, as above. */
  const isOverOpenAnywayLimit = ({ sourceId, path }: OpenRequest) => core.isOverOpenAnywayLimit(sourceId, path).catch(() => false)

  /**
   * Opens what a webview asks for where it belongs (ADR 0005), read through the `polyscope` file system when it's
   * VS Code's editor. With `polyscope.ownViewer` on: a file in VS Code's editor unless it's a Large File; Large Files,
   * Log Streams and Follows in a viewer tab. Off: everything in VS Code's editor, a Log Stream as a snapshot of its
   * Last N lines, bar a file over the "open anyway" limit, refused; Follows aren't offered then.
   */
  async function open(request: OpenRequest) {
    const { kind, sourceId, path, pinned, inEditor } = request
    // Like opening a file from VS Code's Explorer: the preview tab unless pinned, and its binary or error editor if need be.
    const inVsCodeEditor = async (uri: Uri) => {
      await commands.executeCommand('vscode.open', uri, { preview: !pinned })
    }
    if (kind === 'file') {
      const large = !inEditor && (await isLargeFile(request))
      if (large && ownViewer()) return openViewerTab(webviewOptions, request)
      // Refused before VS Code's editor reads it, as it would hold all of it in memory. Only a compressed file's
      // content has to be read (up to the limit) to tell.
      if (large && (await isOverOpenAnywayLimit(request))) return void refuseTooLarge(request)
      return inVsCodeEditor(polyscopeUri(sourceId, path, await sourceNameOf(sourceId)))
    }
    if (ownViewer()) return openViewerTab(webviewOptions, request)
    if (kind === 'log') return inVsCodeEditor(polyscopeLogUri(sourceId, path, await sourceNameOf(sourceId)))
    // A Follow isn't offered with ownViewer off: VS Code's editor can't append to what it shows.
  }

  /** Tells the user a file is too large for VS Code's editor, offering to turn ownViewer on and open it in a viewer tab. */
  async function refuseTooLarge(request: OpenRequest) {
    const { openAnywayLimit } = await core.getSettings()
    const useOwnViewer = t('largeFile.useOwnViewer')
    const answer = await notify(t('largeFile.tooLargeForEditor', { name: request.name, limit: formatSize(openAnywayLimit) }), useOwnViewer)
    if (answer !== useOwnViewer) return
    await turnOwnViewerOn()
    await open(request)
  }

  context.subscriptions.push(
    workspace.registerFileSystemProvider(polyscopeScheme, createFileProvider(core), { isReadonly: true, isCaseSensitive: true }),
    window.registerFileDecorationProvider(tabDecorations),
    registerSidebarView(webviewOptions)
  )

  const answerNotifications: TestApi['answerNotifications'] = (answer) => {
    notify = async (message, ...actions) => answer(message, actions)
  }
  const answerSaveDialogs: TestApi['answerSaveDialogs'] = (answer) => {
    askWhere = async (suggested) => answer(suggested)
  }
  return context.extensionMode === ExtensionMode.Test
    ? { core, secrets, startCore: () => startCore(createVsCodeSecretStore(context.secrets)), open, shell, tabDecorations, answerNotifications, answerSaveDialogs }
    : undefined
}

export function deactivate(): void {}
