import type { BridgeCall, BridgeEvent, BridgeEvents, ExtensionBridge, ToHost, ToWebview } from './protocol'

interface Channel {
  /** Sends a message to the extension host. */
  post(message: ToHost): void
  /** Hears every message from the extension host. */
  listen(listener: (message: ToWebview) => void): void
}

/** `window.polyscope` in a webview: each call becomes a message to the extension host, and its events come back as messages. */
export function createWebviewBridge({ post, listen }: Channel): ExtensionBridge {
  let lastId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const listeners: { [E in BridgeEvent]: Set<(payload: BridgeEvents[E]) => void> } = {
    settingsChanged: new Set(),
    followEvent: new Set(),
    largeFileEvent: new Set(),
    largeFileSearchEvent: new Set(),
    updateStatus: new Set(),
    ownViewerChanged: new Set()
  }

  listen((message) => {
    if (message.kind === 'event') {
      for (const listener of listeners[message.event]) (listener as (payload: unknown) => void)(message.payload)
      return
    }
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    if (message.ok) call.resolve(message.value)
    else call.reject(new Error(message.message))
  })

  const call =
    <M extends BridgeCall>(method: M) =>
    (...args: Parameters<ExtensionBridge[M]>) =>
      new Promise((resolve, reject) => {
        const id = ++lastId
        pending.set(id, { resolve, reject })
        post({ kind: 'call', id, method, args })
      }) as ReturnType<ExtensionBridge[M]>

  const on =
    <E extends BridgeEvent>(event: E) =>
    (listener: (payload: BridgeEvents[E]) => void) => {
      // Wrapped, so the same function subscribed twice is told twice and unsubscribes independently.
      const subscription = (payload: BridgeEvents[E]) => listener(payload)
      listeners[event].add(subscription)
      return () => void listeners[event].delete(subscription)
    }

  return {
    copy: 'extension',
    invokeCore: call('invokeCore'),
    pickFolder: call('pickFolder'),
    pickFile: call('pickFile'),
    secretStorageIsWeak: call('secretStorageIsWeak'),
    copyDiagnostics: call('copyDiagnostics'),
    appVersion: call('appVersion'),
    getUpdateStatus: call('getUpdateStatus'),
    checkForUpdates: call('checkForUpdates'),
    applyUpdate: call('applyUpdate'),
    openExtensionSettings: call('openExtensionSettings'),
    open: call('open'),
    retitle: call('retitle'),
    ownViewer: call('ownViewer'),
    onOwnViewerChanged: on('ownViewerChanged'),
    onUpdateStatus: on('updateStatus'),
    onSettingsChanged: on('settingsChanged'),
    onFollowEvent: on('followEvent'),
    onLargeFileEvent: on('largeFileEvent'),
    onLargeFileSearchEvent: on('largeFileSearchEvent')
  }
}
