import { ViewColumn, window } from 'vscode'
import type { HostShell } from './bridge/host'
import type { OpenRequest } from './bridge/protocol'
import { servePage, type WebviewOptions } from './webview-page'

/** The view type of Polyscope's viewer tabs. */
export const viewerViewType = 'polyscope.viewer'

/**
 * Opens a Polyscope viewer tab: a webview tab hosting the desktop app's viewer for one Followed file, Log Stream or
 * Large File, its `window.polyscope` bridged to the core here. Closing it stops its Follow and lets its Large File
 * go. It's kept alive while hidden, so a Follow goes on behind other tabs, but isn't restored after a reload: no
 * serializer is registered for it.
 */
export function openViewerTab(options: WebviewOptions, request: OpenRequest): void {
  // Named by the viewer once it's open, as its log view switches to a Previous Log and back.
  const panel = window.createWebviewPanel(viewerViewType, request.name, ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [options.webviewRoot],
    retainContextWhenHidden: true
  })
  const shell: HostShell = {
    ...options.shell,
    // A Large File opened in VS Code's editor anyway takes the place of its viewer tab, as it does in the desktop app.
    async open(opened) {
      await options.shell.open(opened)
      if (opened.inEditor) panel.dispose()
    },
    async retitle(title) {
      panel.title = title
    }
  }
  servePage(panel.webview, panel.onDidDispose, { ...options, shell }, 'viewer', request)
}
