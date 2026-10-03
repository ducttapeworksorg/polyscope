// The messages between an Extension Copy's webviews and its extension host, standing in for the desktop app's IPC.
// Everything here crosses `postMessage`, so must survive JSON.

import type { FollowEvent, LargeFileEvent, LargeFileSearchEvent, SourcePath } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { PolyscopeBridge } from '../../preload/bridge'

/** What the sidebar asks the extension host to open, and where it was in the tree. */
export interface OpenRequest {
  /** A file, a Log Stream (or Previous Log) snapshot, or a Followed file. */
  kind: 'file' | 'log' | 'follow'
  sourceId: string
  path: SourcePath
  /** Opened in a tab of its own rather than the preview tab. */
  pinned: boolean
}

/** `window.polyscope` in a webview: the desktop app's bridge, plus asking the extension host to open things. */
export interface ExtensionBridge extends PolyscopeBridge {
  /** Opens a file, Log Stream or Follow wherever the extension host decides. */
  open(request: OpenRequest): Promise<void>
}

/** The bridge's calls: everything but its subscriptions. */
export type BridgeCall = Exclude<keyof ExtensionBridge, `on${string}`>

/** What each of the bridge's events carries. */
export interface BridgeEvents {
  settingsChanged: Settings
  followEvent: FollowEvent
  largeFileEvent: LargeFileEvent
  largeFileSearchEvent: LargeFileSearchEvent
  updateStatus: UpdateStatus
}

export type BridgeEvent = keyof BridgeEvents

/** A webview calling the extension host; answered by a reply with the same id. */
export interface CallMessage {
  kind: 'call'
  id: number
  method: BridgeCall
  args: unknown[]
}

/** The extension host answering a call. A core call's failure is a value; `ok: false` means the call itself failed. */
export type ReplyMessage = { kind: 'reply'; id: number; ok: true; value?: unknown } | { kind: 'reply'; id: number; ok: false; message: string }

export type EventMessage = { [E in BridgeEvent]: { kind: 'event'; event: E; payload: BridgeEvents[E] } }[BridgeEvent]

export type ToHost = CallMessage
export type ToWebview = ReplyMessage | EventMessage
