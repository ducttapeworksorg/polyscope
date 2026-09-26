import type { SourcePath } from '@shared/core-api'

export interface FileEntry {
  kind: 'folder' | 'file'
  name: string
}

export interface FileStat {
  kind: 'folder' | 'file'
  size: number
  modifiedTime: number
}

/**
 * The contract every File Source Type implements. Paths are Source-relative
 * ('/'-separated, '' for the root); implementations throw CoreError on failure.
 */
export interface FileSource {
  listChildren(path: SourcePath): Promise<FileEntry[]>
  stat(path: SourcePath): Promise<FileStat>
  read(path: SourcePath): Promise<Uint8Array>
}
