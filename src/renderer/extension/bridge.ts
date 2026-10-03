import { createWebviewBridge } from '../../extension/bridge/webview'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

// Before anything reaches the core: every call goes to the extension host instead of the desktop app's main process.
const vscode = acquireVsCodeApi()

/** The page's `window.polyscope`, bridged to the extension host. */
export const bridge = createWebviewBridge({
  post: (message) => vscode.postMessage(message),
  listen: (listener) => window.addEventListener('message', (event) => listener(event.data))
})
window.polyscope = bridge
