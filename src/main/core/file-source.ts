import type { EntryProblem, KubernetesEntry, SourcePath } from '@shared/core-api'

export interface FileEntry {
  kind: 'folder' | 'file'
  name: string
  /** In bytes, when listing finds it out along the way. */
  size?: number
  /** Milliseconds since the epoch, when listing finds it out along the way. */
  modifiedTime?: number
  /** Set when the entry is listed but can't be expanded or opened, e.g. a symlink loop or no permission. */
  problem?: EntryProblem
  /** Set by a Kubernetes Files Source on the folders standing for its pods and containers. */
  kubernetes?: KubernetesEntry
}

export type FileStat =
  | {
      kind: 'file'
      size: number
      modifiedTime: number
      /**
       * Which file it is, beyond its name, when the backend can tell (e.g. its device and inode): another file
       * put in its place, as log rotation does, has another.
       */
      identity?: string
    }
  /** Milliseconds since the epoch, only when the backend keeps one for folders. */
  | { kind: 'folder'; modifiedTime?: number }

/** One page of a folder's entries. */
export interface FileListing {
  entries: FileEntry[]
  /** Set when there are more entries; passing it back lists the next page. */
  cursor?: string
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
  /**
   * The entries of a folder, in no particular order, a page at a time: `cursor` is the one the
   * previous page ended with, left out for the first page. A Source Type may list everything in one page.
   */
  listChildren(path: SourcePath, cursor?: string): Promise<FileListing>
  stat(path: SourcePath): Promise<FileStat>
  /** The bytes in `range`: fewer when it runs past the end of the file, none when it starts at the end or beyond. */
  read(path: SourcePath, range: ByteRange): Promise<Uint8Array>
}
