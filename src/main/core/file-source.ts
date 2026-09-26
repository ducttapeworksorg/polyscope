import type { EntryProblem, SourcePath } from '@shared/core-api'

export interface FileEntry {
  kind: 'folder' | 'file'
  name: string
  /** Set when the entry is listed but can't be expanded or opened, e.g. a symlink loop or no permission. */
  problem?: EntryProblem
}

export interface FileStat {
  kind: 'folder' | 'file'
  size: number
  modifiedTime: number
}

/** `length` bytes starting `offset` bytes into a file; both whole numbers, zero or more. */
export interface ByteRange {
  offset: number
  length: number
}

/**
 * The contract every File Source Type implements, checked by the shared suite in
 * file-source-contract.ts. Paths are Source-relative ('/'-separated, '' for the root);
 * implementations throw CoreError on failure.
 */
export interface FileSource {
  /** The entries of a folder, in no particular order. */
  listChildren(path: SourcePath): Promise<FileEntry[]>
  stat(path: SourcePath): Promise<FileStat>
  /** The bytes in `range`: fewer when it runs past the end of the file, none when it starts at the end or beyond. */
  read(path: SourcePath, range: ByteRange): Promise<Uint8Array>
}
