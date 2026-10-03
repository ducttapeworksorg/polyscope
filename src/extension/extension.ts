import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { commands, ExtensionMode, Uri, version, window, workspace, type ExtensionContext } from 'vscode'
import { createAppLog } from '../main/app-log'
import { createCore, type Core } from '../main/core/core'
import type { HostShell } from './bridge/host'
import type { OpenRequest } from './bridge/protocol'
import { createFileProvider } from './file-provider'
import { polyscopeScheme, polyscopeUri } from './polyscope-uri'
import { registerSidebarView } from './sidebar-view'
import { openViewerTab } from './viewer-tab'
import type { WebviewOptions } from './webview-page'

/** What the extension hands its integration tests, and nothing else. */
export interface TestApi {
  core: Core
  /** Opens what the sidebar asks for, as it does. */
  open(request: OpenRequest): Promise<void>
}

export async function activate(context: ExtensionContext): Promise<TestApi | undefined> {
  // An Extension Copy keeps its own Sources and settings, apart from the desktop app's.
  const dataDir = context.globalStorageUri.fsPath
  await mkdir(dataDir, { recursive: true })
  const log = createAppLog({ dir: join(dataDir, 'logs') })
  log.info(`Polyscope ${context.extension.packageJSON.version} started (VS Code ${version}, ${process.platform} ${process.arch})`)
  const core = createCore({ dataDir })

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
    open
  }
  const webviewOptions: WebviewOptions = { core, log, shell, webviewRoot: Uri.joinPath(context.extensionUri, 'dist', 'webview') }

  /** Whether a file is a Large File; if that can't be told, VS Code's editor shows why it can't be read either. */
  const isLargeFile = ({ sourceId, path }: OpenRequest) => core.isLargeFile(sourceId, path).catch(() => false)

  /**
   * Opens what a webview asks for where it belongs (ADR 0005): a file in VS Code's editor, read through the
   * `polyscope` file system, unless it's a Large File; Large Files, Log Streams and Follows in a viewer tab.
   */
  async function open(request: OpenRequest) {
    const { kind, sourceId, path, pinned, inEditor } = request
    if (kind === 'file' && (inEditor || !(await isLargeFile(request)))) {
      // Like opening a file from VS Code's Explorer: the preview tab unless pinned, and its binary or error editor if need be.
      await commands.executeCommand('vscode.open', polyscopeUri(sourceId, path), { preview: !pinned })
      return
    }
    openViewerTab(webviewOptions, request)
  }

  context.subscriptions.push(
    workspace.registerFileSystemProvider(polyscopeScheme, createFileProvider(core), { isReadonly: true, isCaseSensitive: true }),
    registerSidebarView(webviewOptions)
  )

  return context.extensionMode === ExtensionMode.Test ? { core, open } : undefined
}

export function deactivate(): void {}
