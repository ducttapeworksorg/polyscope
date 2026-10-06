import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/red-hat-mono'
import '../src/styles/app.css'
import './webview.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ContainerNode, EntryNode, SourceInfo } from '@shared/core-api'
import type { OpenRequest } from '../../extension/bridge/protocol'
import { SourcesPane } from '../src/components/SourcesPane'
import { useSources } from '../src/components/use-sources'
import { bridge } from './bridge'

/** Asks the extension host to open what was picked in the tree; it decides where. */
const opener =
  (kind: OpenRequest['kind']) =>
  (source: SourceInfo, node: EntryNode | ContainerNode, options?: { pinned: boolean }) => {
    const pinned = options?.pinned ?? false
    void bridge.open({ kind, sourceId: source.id, path: node.path, name: node.name, pinned })
  }

/**
 * The Polyscope sidebar in VS Code: the desktop app's Sources pane, opening what's picked where the extension host
 * decides. Files offer Follow only while `polyscope.ownViewer` is on, as VS Code's editor can't follow.
 */
function Sidebar() {
  const model = useSources()
  const { settings } = model
  const [ownViewer, setOwnViewer] = useState(true)
  useEffect(() => {
    const unsubscribe = bridge.onOwnViewerChanged(setOwnViewer)
    void bridge.ownViewer().then(setOwnViewer)
    return unsubscribe
  }, [])
  if (!settings) return null
  return (
    <SourcesPane
      model={{ ...model, settings }}
      update={{ state: 'off' }}
      onOpenFile={opener('file')}
      onOpenLog={opener('log')}
      onFollowFile={ownViewer ? opener('follow') : undefined}
      onOpenExtensionSettings={() => void bridge.openExtensionSettings()}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sidebar />
  </StrictMode>
)
