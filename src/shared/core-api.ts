// Types shared by the core API (main process) and its callers (renderer, tests).
// Everything here must be serialisable over IPC.

export type SourceTypeId = 'local'

export interface NewLocalSource {
  type: 'local'
  name: string
  rootPath: string
}

export type NewSource = NewLocalSource

export interface SourceInfo {
  id: string
  type: SourceTypeId
  name: string
  rootPath: string
}

/** A path inside a Source: '/'-separated, relative to the Source root, '' for the root itself. */
export type SourcePath = string

export interface TreeNode {
  kind: 'folder' | 'file'
  name: string
  path: SourcePath
}

export interface OpenedFile {
  path: SourcePath
  name: string
  content: string
  size: number
  modifiedTime: number
}

export type CoreErrorCode =
  | 'NAME_REQUIRED'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_NOT_A_FOLDER'
  | 'SOURCE_NOT_FOUND'
  | 'PATH_OUTSIDE_SOURCE'
  | 'NOT_FOUND'
  | 'NOT_A_FOLDER'
  | 'NOT_A_FILE'
  | 'UNKNOWN'

export interface CoreApi {
  listSources(): Promise<SourceInfo[]>
  addSource(input: NewSource): Promise<SourceInfo>
  expand(sourceId: string, path: SourcePath): Promise<TreeNode[]>
  openFile(sourceId: string, path: SourcePath): Promise<OpenedFile>
}

export type CoreMethod = keyof CoreApi

export const coreMethods: readonly CoreMethod[] = ['listSources', 'addSource', 'expand', 'openFile']

/** How a core call travels back over IPC: errors are values so their code survives. */
export type CoreResult<T> = { ok: true; value: T } | { ok: false; code: CoreErrorCode; message: string }
