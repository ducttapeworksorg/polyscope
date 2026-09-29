import type { CoreMethod, CoreResult, FollowEvent, LargeFileEvent, LargeFileSearchEvent } from '@shared/core-api'
import type { Settings } from '@shared/settings'

/** What the preload script exposes to the renderer as `window.polyscope`. */
export interface PolyscopeBridge {
  invokeCore(method: CoreMethod, args: unknown[]): Promise<CoreResult<unknown>>
  pickFolder(): Promise<string | null>
  /** Asks for a file, offering to show those matching each filter in turn (`*` for any); null if none was picked. */
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>
  /** Copies the versions, OS and recent app log, with secrets redacted, to the clipboard. */
  copyDiagnostics(): Promise<void>
  /** Subscribes to the core's settings changes; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** Subscribes to every Follow's updates; returns a function that unsubscribes. */
  onFollowEvent(listener: (event: FollowEvent) => void): () => void
  /** Subscribes to every Large File's status changes; returns a function that unsubscribes. */
  onLargeFileEvent(listener: (event: LargeFileEvent) => void): () => void
  /** Subscribes to every Large File search's updates; returns a function that unsubscribes. */
  onLargeFileSearchEvent(listener: (event: LargeFileSearchEvent) => void): () => void
}
