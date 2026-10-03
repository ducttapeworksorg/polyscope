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

/** What the extension hands its integration tests, and nothing else. */
export interface TestApi {
  core: Core
  /** Opens what the sidebar asks for, as it does. */
  open(request: OpenRequest): Promise<void>
}

/** Opens a sidebar request: for now every file goes to VS Code's editor, read through the `polyscope` file system. */
async function open({ kind, sourceId, path, pinned }: OpenRequest) {
  if (kind !== 'file') {
    void window.showInformationMessage('Polyscope can’t open Log Streams or Follow files in VS Code yet.')
    return
  }
  // Like opening a file from VS Code's Explorer: the preview tab unless pinned, and its binary or error editor if need be.
  await commands.executeCommand('vscode.open', polyscopeUri(sourceId, path), { preview: !pinned })
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

  context.subscriptions.push(
    workspace.registerFileSystemProvider(polyscopeScheme, createFileProvider(core), { isReadonly: true, isCaseSensitive: true }),
    registerSidebarView({ core, log, shell, webviewRoot: Uri.joinPath(context.extensionUri, 'dist', 'webview') })
  )

  return context.extensionMode === ExtensionMode.Test ? { core, open } : undefined
}

export function deactivate(): void {}
