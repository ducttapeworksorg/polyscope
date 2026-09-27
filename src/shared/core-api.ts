// Types shared by the core API (main process) and its callers (renderer, tests).
// Everything here must be serialisable over IPC.

import type { Settings } from './settings'

export type SourceTypeId = 'local' | 's3'

/** Every Source Type, in the default order of its sidebar group. */
export const sourceTypeIds: readonly SourceTypeId[] = ['local', 's3']

export interface NewLocalSource {
  type: 'local'
  name: string
  rootPath: string
  /** Whether dotfiles and files marked hidden are listed; on unless turned off. */
  showHidden?: boolean
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

export interface NewS3Source {
  type: 's3'
  name: string
  /** The store's address, e.g. `https://minio.internal:9000`; https is assumed without a scheme. Blank for AWS itself. */
  host: string
  bucket: string
  /** The key prefix the Source is rooted at, e.g. `logs/app`; the whole bucket when blank or left out. */
  prefix?: string
  /** `us-east-1` when blank or left out. */
  region?: string
  /** Addresses the bucket in the path rather than the host name, as MinIO and most self-hosted stores need; off unless given. */
  pathStyle?: boolean
  accessKeyId: string
  /** Goes into the OS keychain and never comes back out of the core. Blank or left out when editing keeps the stored one. */
  secretAccessKey?: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

/** The user-editable settings of a Source; its Source Type decides which fields exist. */
export type NewSource = NewLocalSource | NewS3Source

interface SourceIdentity {
  id: string
  name: string
  /** Left out when the Source isn't labelled with an Environment. */
  environmentId?: string
}

export interface LocalSourceInfo extends SourceIdentity {
  type: 'local'
  rootPath: string
  showHidden: boolean
}

export interface S3SourceInfo extends SourceIdentity {
  type: 's3'
  /** Normalised: a URL with its scheme, or blank for AWS itself. */
  host: string
  bucket: string
  /** Normalised: no leading or trailing '/', blank for the whole bucket. */
  prefix: string
  region: string
  pathStyle: boolean
  accessKeyId: string
  /** Whether a secret key is stored for the Source; the key itself never leaves the core. */
  secretKeySet: boolean
}

export type SourceInfo = LocalSourceInfo | S3SourceInfo

/** A user-defined label for the kind of system Sources point at, e.g. prod or dev. */
export interface Environment {
  id: string
  name: string
  /** A CSS colour, always lowercase `#rrggbb`. */
  color: string
  /** Marks an Environment that needs extra care; no behavioural effect in v1. */
  protected: boolean
}

/** The user-editable settings of an Environment. */
export interface NewEnvironment {
  name: string
  color: string
  /** Off unless given. */
  protected?: boolean
}

/** A path inside a Source: '/'-separated, relative to the Source root, '' for the root itself. */
export type SourcePath = string

/** Why an entry is shown but can't be expanded or opened. */
export interface EntryProblem {
  code: CoreErrorCode
  message: string
}

/** The name of an icon in Material Icon Theme's `icons` folder, without '.svg'. */
export type IconKey = string

/** A folder or file in a Source's tree. */
export interface EntryNode {
  kind: 'folder' | 'file'
  name: string
  path: SourcePath
  /** The Material Icon Theme icon for the entry, e.g. 'log' or 'folder-src'; a folder's open icon adds '-open'. */
  icon: IconKey
  /** In bytes; files only, and only when the backend reports it. */
  size?: number
  /** Milliseconds since the epoch; only when the backend reports it, never made up. */
  modifiedTime?: number
  /** Set when the entry can't be expanded or opened, e.g. a symlink loop or no permission to read it. */
  problem?: EntryProblem
}

/** Stands in for the children of `path` when they couldn't be listed; expanding `path` again retries. */
export interface ErrorNode {
  kind: 'error'
  path: SourcePath
  code: CoreErrorCode
  message: string
}

/** Stands in for the rest of a folder too long to list at once; expanding `path` with `cursor` lists the next page. */
export interface MoreNode {
  kind: 'more'
  /** The folder being listed. */
  path: SourcePath
  cursor: string
}

export type TreeNode = EntryNode | ErrorNode | MoreNode

/** Whether the app is talking to a Source right now. Never persisted: every launch starts Disconnected. */
export type ConnectionState =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; code: CoreErrorCode; message: string }

/** The text encodings a file can be decoded with, detected or asked for. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1'

export const textEncodings: readonly TextEncoding[] = ['utf-8', 'utf-16le', 'utf-16be', 'latin1']

/** How a file's bytes were compressed; the core decompresses them before anything else. */
export type Compression = 'gzip' | 'zstd'

/** A Monaco language id, e.g. 'typescript', or 'plaintext' when nothing better is known. */
export type LanguageId = string

/** How to open a file instead of the way the core would pick. */
export interface OpenOptions {
  /** Decode as this encoding, even if the file looks binary. */
  encoding?: TextEncoding
  /** Show the (decompressed) bytes as a hex dump. Ignored when `encoding` is given. */
  hex?: boolean
}

interface OpenedFileFacts {
  path: SourcePath
  name: string
  /** In bytes, as stored: before any decompression. */
  size: number
  modifiedTime: number
  /** Set when the file was decompressed before being shown. */
  compression?: Compression
}

/** A file shown as text in the editor. */
export interface TextFile extends OpenedFileFacts {
  view: 'editor'
  content: string
  /** How the bytes were decoded into `content`. */
  encoding: TextEncoding
  /** Detected from the name (the inner name, for a compressed file). */
  language: LanguageId
}

/** A file whose bytes don't look like text; nothing of it is shown until asked. */
export interface BinaryFile extends OpenedFileFacts {
  view: 'binary'
  /** In bytes, after any decompression. */
  contentLength: number
}

/** A file shown as a hex dump: offset, bytes and printable characters, 16 bytes per line. */
export interface HexFile extends OpenedFileFacts {
  view: 'hex'
  /** The dump of the first `shownLength` bytes; a large file's is cut short. */
  content: string
  /** In bytes, after any decompression. */
  contentLength: number
  shownLength: number
}

/** An opened file, in whichever view suits its content (or was asked for). */
export type OpenedFile = TextFile | BinaryFile | HexFile

export type CoreErrorCode =
  | 'NAME_REQUIRED'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_NOT_A_FOLDER'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_DISCONNECTED'
  | 'PATH_OUTSIDE_SOURCE'
  | 'NOT_FOUND'
  | 'NOT_A_FOLDER'
  | 'NOT_A_FILE'
  | 'PERMISSION_DENIED'
  | 'SYMLINK_LOOP'
  | 'INVALID_RANGE'
  | 'INVALID_ORDER'
  | 'ENVIRONMENT_NOT_FOUND'
  | 'ENVIRONMENT_NAME_REQUIRED'
  | 'ENVIRONMENT_NAME_TAKEN'
  | 'INVALID_COLOR'
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_SETTINGS'
  | 'INVALID_ENCODING'
  | 'DECOMPRESSION_FAILED'
  | 'INVALID_HOST'
  | 'BUCKET_REQUIRED'
  | 'ACCESS_KEY_REQUIRED'
  | 'SECRET_KEY_REQUIRED'
  | 'BUCKET_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'UNREACHABLE'
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
  /** Every Environment, oldest first; prod, staging, qa and dev until the user changes them. */
  listEnvironments(): Promise<Environment[]>
  addEnvironment(input: NewEnvironment): Promise<Environment>
  /** Renames, recolours or (un)protects an Environment, keeping its id and place. */
  editEnvironment(environmentId: string, input: NewEnvironment): Promise<Environment>
  /** Removes an Environment; the Sources labelled with it become unlabelled. */
  deleteEnvironment(environmentId: string): Promise<void>
  connectionState(sourceId: string): Promise<ConnectionState>
  /** Resolves the Source's settings, checks it can be reached and returns its root's children (the first page of them). */
  connect(sourceId: string): Promise<TreeNode[]>
  /**
   * Checks that settings could be connected to, without saving anything. When editing, `sourceId`
   * names the Source whose stored secrets stand in for any left blank.
   */
  testConnection(input: NewSource, sourceId?: string): Promise<void>
  /** Drops the connection and stops all activity against the Source. */
  disconnect(sourceId: string): Promise<void>
  /**
   * The children of a node in a Connected Source, a page at a time: a long listing ends in a more node,
   * whose `cursor` lists the next page. If they can't be listed, a single error node instead.
   */
  expand(sourceId: string, path: SourcePath, cursor?: string): Promise<TreeNode[]>
  /** Reads a file and decides how to show it; `options` reopens it another way, e.g. in another encoding. */
  openFile(sourceId: string, path: SourcePath, options?: OpenOptions): Promise<OpenedFile>
  getSettings(): Promise<Settings>
  /** Changes the given settings, keeping the rest; all of them together must still be valid. */
  updateSettings(changes: Partial<Settings>): Promise<Settings>
}

/** What the core announces without being asked. Listeners run in the core's process; IPC forwards them. */
export interface CoreEvents {
  /** Calls `listener` with the new settings after each change is saved; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
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
  'listEnvironments',
  'addEnvironment',
  'editEnvironment',
  'deleteEnvironment',
  'connectionState',
  'connect',
  'testConnection',
  'disconnect',
  'expand',
  'openFile',
  'getSettings',
  'updateSettings'
]

/** How a core call travels back over IPC: errors are values so their code survives. */
export type CoreResult<T> = { ok: true; value: T } | { ok: false; code: CoreErrorCode; message: string }
