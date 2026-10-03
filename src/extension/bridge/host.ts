import type { CoreApi, CoreEvents } from '@shared/core-api'
import type { AppLog } from '../../main/app-log'
import { callCore } from '../../main/core-call'
import type { BridgeCall, BridgeEvent, BridgeEvents, CallMessage, ExtensionBridge, OpenRequest, ToWebview } from './protocol'

/** What only the extension host can do for a webview, through VS Code. */
export interface HostShell {
  pickFolder(): Promise<string | null>
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>
  copyDiagnostics(): Promise<void>
  appVersion(): Promise<string>
  open(request: OpenRequest): Promise<void>
}

interface Options {
  core: CoreApi & CoreEvents
  log: Pick<AppLog, 'warn' | 'error'>
  shell: HostShell
  /** Sends a message to the webview. */
  post(message: ToWebview): void
}

const isCall = (value: unknown): value is CallMessage =>
  typeof value === 'object' &&
  value !== null &&
  (value as CallMessage).kind === 'call' &&
  typeof (value as CallMessage).id === 'number' &&
  Array.isArray((value as CallMessage).args)

/**
 * Serves one webview's bridge: answers its calls with the core and the host's shell, and forwards every core
 * event to it until disposed. Like the desktop app's IPC, a core call's errors come back as values with their code.
 */
export function serveBridge({ core, log, shell, post }: Options) {
  const calls: { [M in BridgeCall]: (...args: Parameters<ExtensionBridge[M]>) => Promise<unknown> } = {
    invokeCore: (method, args) => callCore(core, log, method, args),
    pickFolder: () => shell.pickFolder(),
    pickFile: (filters) => shell.pickFile(filters),
    // VS Code's SecretStorage is backed by the OS keychain, or by its own encryption where there's none.
    secretStorageIsWeak: async () => false,
    copyDiagnostics: () => shell.copyDiagnostics(),
    appVersion: () => shell.appVersion(),
    // The editor's marketplace updates an Extension Copy.
    getUpdateStatus: async () => ({ state: 'off' }),
    checkForUpdates: async () => {},
    applyUpdate: async () => {},
    open: (request) => shell.open(request)
  }

  const send = <E extends BridgeEvent>(event: E) => (payload: BridgeEvents[E]) => post({ kind: 'event', event, payload } as ToWebview)
  const unsubscribes = [
    core.onSettingsChanged(send('settingsChanged')),
    core.onFollowEvent(send('followEvent')),
    core.onLargeFileEvent(send('largeFileEvent')),
    core.onLargeFileSearchEvent(send('largeFileSearchEvent'))
  ]

  return {
    /** Handles a message from the webview; anything that isn't a call is ignored. */
    async receive(message: unknown): Promise<void> {
      if (!isCall(message)) return
      const { id, method, args } = message
      const call = Object.hasOwn(calls, method) ? (calls[method] as (...a: unknown[]) => Promise<unknown>) : null
      try {
        if (!call) throw new Error(`Unknown call: ${String(method)}`)
        post({ kind: 'reply', id, ok: true, value: await call(...args) })
      } catch (error) {
        log.error(`${String(method)} failed`, error)
        post({ kind: 'reply', id, ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    },

    /** Stops forwarding core events, once the webview is gone. */
    dispose(): void {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }
}
