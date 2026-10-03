import { window, type Disposable } from 'vscode'
import { servePage, type WebviewOptions } from './webview-page'

/** The id of the Polyscope sidebar view, as the manifest contributes it. */
export const sidebarViewId = 'polyscope.sources'

/**
 * Registers the Polyscope sidebar: a webview view hosting the desktop app's Sources pane, its `window.polyscope`
 * bridged to the core here. It's kept alive while hidden, so the tree stays as it was left.
 */
export function registerSidebarView(options: WebviewOptions): Disposable {
  return window.registerWebviewViewProvider(
    sidebarViewId,
    {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true, localResourceRoots: [options.webviewRoot] }
        servePage(view.webview, view.onDidDispose, options, 'sidebar')
      }
    },
    { webviewOptions: { retainContextWhenHidden: true } }
  )
}
