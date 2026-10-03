import { ViewColumn, window } from 'vscode'
import { t } from '../renderer/src/i18n'
import type { HostShell } from './bridge/host'
import type { OpenRequest } from './bridge/protocol'
import { servePage, type WebviewOptions } from './webview-page'

/** The view type of Polyscope's viewer tabs. */
export const viewerViewType = 'polyscope.viewer'

/** A viewer tab's title, as the desktop app names its tabs. */
const titleOf = ({ name, previous }: OpenRequest) => (previous ? t('logView.previous', { name }) : name)

/**
 * Opens a Polyscope viewer tab: a webview tab hosting the desktop app's viewer for one Followed file, Log Stream or
 * Large File, its `window.polyscope` bridged to the core here. Closing it stops its Follow and lets its Large File
 * go. It's kept alive while hidden, so a Follow goes on behind other tabs, but isn't restored after a reload: no
 * serializer is registered for it.
 */
export function openViewerTab(options: WebviewOptions, request: OpenRequest): void {
  const panel = window.createWebviewPanel(viewerViewType, titleOf(request), ViewColumn.Active, {
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
    }
  }
  servePage(panel.webview, panel.onDidDispose, { ...options, shell }, 'viewer', request)
}
