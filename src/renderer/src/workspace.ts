import type { OpenedFile } from '@shared/core-api'

/** A file open in the viewer. Tabs live only in the renderer and are never persisted. */
export interface OpenTab {
  key: string
  sourceId: string
  sourceName: string
  file: OpenedFile
}
