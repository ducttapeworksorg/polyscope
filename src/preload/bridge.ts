import type { CoreMethod, CoreResult } from '@shared/core-api'
import type { Settings } from '@shared/settings'

/** What the preload script exposes to the renderer as `window.polyscope`. */
export interface PolyscopeBridge {
  invokeCore(method: CoreMethod, args: unknown[]): Promise<CoreResult<unknown>>
  pickFolder(): Promise<string | null>
  /** Subscribes to the core's settings changes; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
}
