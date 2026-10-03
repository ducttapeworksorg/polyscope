import { randomBytes } from 'node:crypto'
import { Uri, window, type Disposable, type WebviewView } from 'vscode'
import type { Core } from '../main/core/core'
import type { AppLog } from '../main/app-log'
import { serveBridge, type HostShell } from './bridge/host'
import type { ToWebview } from './bridge/protocol'

/** The id of the Polyscope sidebar view, as the manifest contributes it. */
export const sidebarViewId = 'polyscope.sources'

interface Options {
  core: Core
  log: AppLog
  shell: HostShell
  /** The folder the webviews' bundle is built into. */
  webviewRoot: Uri
}

/** The sidebar's page: the bundle built from src/renderer/extension, allowed to load nothing else. */
function sidebarHtml(view: WebviewView, webviewRoot: Uri) {
  const nonce = randomBytes(16).toString('base64')
  const asset = (name: string) => view.webview.asWebviewUri(Uri.joinPath(webviewRoot, name))
  const { cspSource } = view.webview
  // Styles allow inline ones, as React sets style attributes (e.g. a Source's Environment colour).
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    // The page's own script, and the chunks it imports.
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `worker-src ${cspSource} blob:`
  ].join('; ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${asset('sidebar.css')}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${asset('sidebar.js')}"></script>
  </body>
</html>`
}

/**
 * Registers the Polyscope sidebar: a webview view hosting the desktop app's Sources pane, its `window.polyscope`
 * bridged to the core here. It's kept alive while hidden, so the tree stays as it was left.
 */
export function registerSidebarView({ core, log, shell, webviewRoot }: Options): Disposable {
  return window.registerWebviewViewProvider(
    sidebarViewId,
    {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] }
        const bridge = serveBridge({ core, log, shell, post: (message: ToWebview) => void view.webview.postMessage(message) })
        const received = view.webview.onDidReceiveMessage((message) => void bridge.receive(message))
        view.onDidDispose(() => {
          received.dispose()
          bridge.dispose()
        })
        view.webview.html = sidebarHtml(view, webviewRoot)
      }
    },
    { webviewOptions: { retainContextWhenHidden: true } }
  )
}
