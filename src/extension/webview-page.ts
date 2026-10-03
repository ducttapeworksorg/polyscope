import { randomBytes } from 'node:crypto'
import { Uri, type Event, type Webview } from 'vscode'
import type { AppLog } from '../main/app-log'
import type { Core } from '../main/core/core'
import { serveBridge, type HostShell } from './bridge/host'
import type { ToWebview } from './bridge/protocol'

/** The pages built from src/renderer/extension: the sidebar's, and a viewer tab's. */
export type WebviewPage = 'sidebar' | 'viewer'

/** What the extension's webviews are served with. */
export interface WebviewOptions {
  core: Core
  log: AppLog
  shell: HostShell
  /** The folder the webviews' bundle is built into. */
  webviewRoot: Uri
}

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A webview's page: `page`'s script and the stylesheet the pages share, from the bundle built into `webviewRoot`,
 * allowed to load nothing else. `data` reaches the page as JSON in its root's `data-polyscope` attribute.
 */
function webviewPage(webview: Webview, webviewRoot: Uri, page: WebviewPage, data?: unknown) {
  const nonce = randomBytes(16).toString('base64')
  const asset = (name: string) => webview.asWebviewUri(Uri.joinPath(webviewRoot, name))
  const { cspSource } = webview
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
  const dataAttribute = data === undefined ? '' : ` data-polyscope="${escapeAttribute(JSON.stringify(data))}"`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${asset('webview.css')}" />
  </head>
  <body>
    <div id="root"${dataAttribute}></div>
    <script type="module" nonce="${nonce}" src="${asset(`${page}.js`)}"></script>
  </body>
</html>`
}

/** Shows `page` in a webview, its `window.polyscope` bridged to the core here until the webview is disposed. */
export function servePage(
  webview: Webview,
  onDidDispose: Event<void>,
  { core, log, shell, webviewRoot }: WebviewOptions,
  page: WebviewPage,
  data?: unknown
): void {
  const bridge = serveBridge({ core, log, shell, post: (message: ToWebview) => void webview.postMessage(message) })
  const received = webview.onDidReceiveMessage((message) => void bridge.receive(message))
  onDidDispose(() => {
    received.dispose()
    bridge.dispose()
  })
  webview.html = webviewPage(webview, webviewRoot, page, data)
}
