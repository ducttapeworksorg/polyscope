import type { CoreMethod, CoreResult, FollowEvent } from '@shared/core-api'
import type { Settings } from '@shared/settings'

/** What the preload script exposes to the renderer as `window.polyscope`. */
export interface PolyscopeBridge {
  invokeCore(method: CoreMethod, args: unknown[]): Promise<CoreResult<unknown>>
  pickFolder(): Promise<string | null>
  /** Asks for a file, offering to show those matching each filter in turn (`*` for any); null if none was picked. */
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>
  /** Subscribes to the core's settings changes; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** Subscribes to every Follow's updates; returns a function that unsubscribes. */
  onFollowEvent(listener: (event: FollowEvent) => void): () => void
}
