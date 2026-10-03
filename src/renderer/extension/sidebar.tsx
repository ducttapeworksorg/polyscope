import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/red-hat-mono'
import '../src/styles/app.css'
import './sidebar.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ContainerNode, EntryNode, PreviousLogNode, SourceInfo } from '@shared/core-api'
import { createWebviewBridge } from '../../extension/bridge/webview'
import type { OpenRequest } from '../../extension/bridge/protocol'
import { SourcesPane } from '../src/components/SourcesPane'
import { useSources } from '../src/components/use-sources'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

// Before anything reaches the core: every call goes to the extension host instead of the desktop app's main process.
const vscode = acquireVsCodeApi()
const bridge = createWebviewBridge({
  post: (message) => vscode.postMessage(message),
  listen: (listener) => window.addEventListener('message', (event) => listener(event.data))
})
window.polyscope = bridge

/** Asks the extension host to open what was picked in the tree; it decides where. */
const opener =
  (kind: OpenRequest['kind']) =>
  (source: SourceInfo, node: EntryNode | ContainerNode | PreviousLogNode, options?: { pinned: boolean }) =>
    void bridge.open({ kind, sourceId: source.id, path: node.path, pinned: options?.pinned ?? false })

/** The Polyscope sidebar in VS Code: the desktop app's Sources pane, opening files in VS Code's editor. */
function Sidebar() {
  const model = useSources()
  const { settings } = model
  if (!settings) return null
  return (
    <SourcesPane
      model={{ ...model, settings }}
      update={{ state: 'off' }}
      onOpenFile={opener('file')}
      onOpenLog={opener('log')}
      onFollowFile={opener('follow')}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sidebar />
  </StrictMode>
)
