import type { CoreMethod, CoreResult } from '@shared/core-api'

/** What the preload script exposes to the renderer as `window.polyscope`. */
export interface PolyscopeBridge {
  invokeCore(method: CoreMethod, args: unknown[]): Promise<CoreResult<unknown>>
  pickFolder(): Promise<string | null>
}
