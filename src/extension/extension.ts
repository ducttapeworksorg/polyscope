import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { commands, ConfigurationTarget, EventEmitter, ExtensionMode, Uri, version, window, workspace, type ExtensionContext } from 'vscode'
import { createAppLog } from '../main/app-log'
import { createCore, type Core } from '../main/core/core'
import type { SecretStore } from '../main/core/secret-store'
import { t } from '../renderer/src/i18n'
import { formatSize } from '../renderer/src/i18n/format'
import type { HostShell } from './bridge/host'
import type { OpenRequest } from './bridge/protocol'
import { createFileProvider } from './file-provider'
import { polyscopeLogUri, polyscopeScheme, polyscopeUri } from './polyscope-uri'
import { createVsCodeSecretStore } from './secret-storage'
import { registerSidebarView } from './sidebar-view'
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
  /** Answers the notifications the extension shows from now on in the user's place, with one of their actions or none. */
  answerNotifications(answer: (message: string, actions: string[]) => string | undefined): void
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
  const startCore = (secrets: SecretStore) => createCore({ dataDir, secrets })
  const secrets = createVsCodeSecretStore(context.secrets)
  const core = startCore(secrets)

  let notify = async (message: string, ...actions: string[]) => window.showWarningMessage(message, ...actions)
  const ownViewerChanged = new EventEmitter<boolean>()
  context.subscriptions.push(
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
    async copyDiagnostics() {
      void window.showInformationMessage('Copy diagnostics isn’t available in VS Code yet.')
    },
    appVersion: async () => context.extension.packageJSON.version as string,
    open,
    ownViewer: async () => ownViewer(),
    onOwnViewerChanged(listener) {
      const subscription = ownViewerChanged.event(listener)
      return () => subscription.dispose()
    }
  }
  const webviewOptions: WebviewOptions = { core, log, shell, webviewRoot: Uri.joinPath(context.extensionUri, 'dist', 'webview') }

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
      return inVsCodeEditor(polyscopeUri(sourceId, path))
    }
    if (ownViewer()) return openViewerTab(webviewOptions, request)
    if (kind === 'log') return inVsCodeEditor(polyscopeLogUri(sourceId, path))
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
    registerSidebarView(webviewOptions)
  )

  const answerNotifications: TestApi['answerNotifications'] = (answer) => {
    notify = async (message, ...actions) => answer(message, actions)
  }
  return context.extensionMode === ExtensionMode.Test ? { core, secrets, startCore: () => startCore(createVsCodeSecretStore(context.secrets)), open, answerNotifications } : undefined
}

export function deactivate(): void {}
