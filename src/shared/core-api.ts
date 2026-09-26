// Types shared by the core API (main process) and its callers (renderer, tests).
// Everything here must be serialisable over IPC.

export type SourceTypeId = 'local'

/** Every Source Type, in the default order of its sidebar group. */
export const sourceTypeIds: readonly SourceTypeId[] = ['local']

export interface NewLocalSource {
  type: 'local'
  name: string
  rootPath: string
}

/** The user-editable settings of a Source; its Source Type decides which fields exist. */
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
  | 'INVALID_ORDER'
  | 'UNKNOWN'

export interface CoreApi {
  /** Every Source, grouped by Source Type: groups in group order, Sources in their order within the group. */
  listSources(): Promise<SourceInfo[]>
  addSource(input: NewSource): Promise<SourceInfo>
  editSource(sourceId: string, input: NewSource): Promise<SourceInfo>
  /** Copies a Source (and its secrets) under a distinct name, placed right after the original. */
  duplicateSource(sourceId: string): Promise<SourceInfo>
  /** Removes a Source and any secrets stored for it. */
  deleteSource(sourceId: string): Promise<void>
  /** Moves a Source to `index` among the Sources of its own Source Type. */
  moveSource(sourceId: string, index: number): Promise<void>
  /** Moves a Source Type group to `index` among the groups that currently have Sources. */
  moveSourceGroup(type: SourceTypeId, index: number): Promise<void>
  expand(sourceId: string, path: SourcePath): Promise<TreeNode[]>
  openFile(sourceId: string, path: SourcePath): Promise<OpenedFile>
}

export type CoreMethod = keyof CoreApi

export const coreMethods: readonly CoreMethod[] = [
  'listSources',
  'addSource',
  'editSource',
  'duplicateSource',
  'deleteSource',
  'moveSource',
  'moveSourceGroup',
  'expand',
  'openFile'
]

/** How a core call travels back over IPC: errors are values so their code survives. */
export type CoreResult<T> = { ok: true; value: T } | { ok: false; code: CoreErrorCode; message: string }
