import type { CoreMethod, CoreResult, FollowEvent, LargeFileEvent, LargeFileSearchEvent } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'

/** What the preload script exposes to the renderer as `window.polyscope`. */
export interface PolyscopeBridge {
  /** Which copy of Polyscope this is: the desktop app, or an Extension Copy, which leaves out what VS Code does itself. */
  copy: 'desktop' | 'extension'
  invokeCore(method: CoreMethod, args: unknown[]): Promise<CoreResult<unknown>>
  pickFolder(): Promise<string | null>
  /** Asks for a file, offering to show those matching each filter in turn (`*` for any); null if none was picked. */
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>
  /** Whether secrets would only be obfuscated at rest, as on Linux with no keyring running. */
  secretStorageIsWeak(): Promise<boolean>
  /** Copies the versions, OS and recent app log, with secrets redacted, to the clipboard. */
  copyDiagnostics(): Promise<void>
  /** This copy's version, e.g. `0.1.0`. */
  appVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatus>
  /** Looks for a newer release now; the outcome arrives through `onUpdateStatus`. */
  checkForUpdates(): Promise<void>
  /** Restarts into the update downloaded, or opens the download page of the one found. */
  applyUpdate(): Promise<void>
  /** Subscribes to update status changes; returns a function that unsubscribes. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  /** Subscribes to the core's settings changes; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** Subscribes to every Follow's updates; returns a function that unsubscribes. */
  onFollowEvent(listener: (event: FollowEvent) => void): () => void
  /** Subscribes to every Large File's status changes; returns a function that unsubscribes. */
  onLargeFileEvent(listener: (event: LargeFileEvent) => void): () => void
  /** Subscribes to every Large File search's updates; returns a function that unsubscribes. */
  onLargeFileSearchEvent(listener: (event: LargeFileSearchEvent) => void): () => void
}
