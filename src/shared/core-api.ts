// Types shared by the core API (main process) and its callers (renderer, tests).
// Everything here must be serialisable over IPC.

import type { Settings } from './settings'

export type SourceTypeId = 'local' | 's3' | 'kubernetesFiles' | 'kubernetesLogs'

/** Every Source Type, in the default order of its sidebar group. */
export const sourceTypeIds: readonly SourceTypeId[] = ['local', 's3', 'kubernetesFiles', 'kubernetesLogs']

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
  /** How the Source signs in: typed keys, or an AWS profile. Keys unless given. */
  auth?: S3Auth
  /** Signing in with keys: needed then, ignored otherwise. */
  accessKeyId?: string
  /**
   * Signing in with keys: goes into the OS keychain and never comes back out of the core.
   * Blank or left out when editing keeps the stored one.
   */
  secretAccessKey?: string
  /** Signing in with a profile: its name in the local AWS config, SSO ones included; the default credential chain when blank or left out. */
  profile?: string
  /** Whether the store's TLS certificate is checked; on unless turned off. */
  verifyTls?: boolean
  /** A PEM file of CA certificates trusted as well as the OS trust store; none when blank or left out. */
  caBundlePath?: string
  /** A proxy for this Source alone, e.g. `http://proxy.corp:3128`; when blank or left out, HTTPS_PROXY / NO_PROXY decide. */
  proxyUrl?: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

export interface NewKubernetesLogsSource {
  type: 'kubernetesLogs'
  name: string
  /** A context in the user's kubeconfig; the cluster and credentials come from there, exec auth plugins included. */
  context: string
  /** The one namespace whose Workloads the Source shows. */
  namespace: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

/** The kinds of Workload a Kubernetes Files Source can browse: those whose pods run for good. */
export type FilesWorkloadKind = Extract<WorkloadKind, 'Deployment' | 'StatefulSet' | 'DaemonSet'>

export const filesWorkloadKinds: readonly FilesWorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']

/** A Workload a Kubernetes Files Source can browse, with where volumes are mounted in its browsable containers. */
export interface KubeWorkload {
  kind: FilesWorkloadKind
  name: string
  /** Absolute, sorted, each once. */
  mountPaths: string[]
}

export interface NewKubernetesFilesSource {
  type: 'kubernetesFiles'
  name: string
  /** A context in the user's kubeconfig; the cluster and credentials come from there, exec auth plugins included. */
  context: string
  namespace: string
  workloadKind: FilesWorkloadKind
  /** The one Workload whose pods the Source browses. */
  workloadName: string
  /** The absolute path of the folder browsed in each container, e.g. `/var/log/app`. */
  path: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

/** How an S3 Source signs in: typed access and secret keys, or an AWS profile (or the default credential chain). */
export type S3Auth = 'keys' | 'profile'

/** The user-editable settings of a Source; its Source Type decides which fields exist. */
export type NewSource = NewLocalSource | NewS3Source | NewKubernetesFilesSource | NewKubernetesLogsSource

/** How many of a log's last lines a log view fetches and keeps: a number of lines, or all of them. */
export type LastNLines = number | 'all'

/** The choices a log view offers before the user types a number of their own. */
export const lastNLinesChoices: readonly LastNLines[] = [1_000, 10_000, 50_000, 100_000, 'all']

interface SourceIdentity {
  id: string
  name: string
  /** Left out when the Source isn't labelled with an Environment. */
  environmentId?: string
  /** The "Last N lines" last picked in a log view of the Source; left out to go by the Settings default. */
  lastNLines?: LastNLines
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
  auth: S3Auth
  /** Blank when signing in with a profile. */
  accessKeyId: string
  /** Whether a secret key is stored for the Source; the key itself never leaves the core. Always false when signing in with a profile. */
  secretKeySet: boolean
  /** Blank for the default credential chain, and when signing in with keys. */
  profile: string
  verifyTls: boolean
  /** Blank for none. */
  caBundlePath: string
  /** Normalised: a URL with its scheme; blank to follow HTTPS_PROXY / NO_PROXY. */
  proxyUrl: string
}

export interface KubernetesLogsSourceInfo extends SourceIdentity {
  type: 'kubernetesLogs'
  context: string
  namespace: string
}

export interface KubernetesFilesSourceInfo extends SourceIdentity {
  type: 'kubernetesFiles'
  context: string
  namespace: string
  workloadKind: FilesWorkloadKind
  workloadName: string
  /** Normalised: absolute, without a trailing '/' (but `/` itself for the root). */
  path: string
}

export type SourceInfo = LocalSourceInfo | S3SourceInfo | KubernetesFilesSourceInfo | KubernetesLogsSourceInfo

/** A context in the user's kubeconfig, as offered when adding a Kubernetes Source. */
export interface KubeContext {
  name: string
  /** The namespace the context defaults to, if it names one. */
  namespace?: string
  /** Whether it's the kubeconfig's current context. */
  current: boolean
}

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
  /** Set on the folders a Kubernetes Files Source shows for its pods and their containers. */
  kubernetes?: KubernetesEntry
}

/** What a Kubernetes Files folder stands for: a pod, or (when its pod has several) a container. */
export type KubernetesEntry =
  | {
      kind: 'pod'
      status: PodStatus
      /** How many of its containers can be browsed: its main containers and sidecars. */
      containerCount: number
    }
  | { kind: 'container'; role?: Extract<ContainerRole, 'sidecar'> }

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

/**
 * The only child of the node being listed, folded into it (a Kubernetes Files Source's root, for its Workload's one
 * pod): the listing's other nodes are this child's children, under its path. It isn't a row of its own; its details
 * go to the listed node's.
 */
export interface FoldedNode {
  kind: 'folded'
  name: string
  path: SourcePath
  /** Set when it's a Kubernetes Files Source's pod. */
  kubernetes?: KubernetesEntry
}

/** The kinds of Workload a Kubernetes Logs Source groups its tree by; a Pod stands for a pod no Workload owns. */
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob' | 'Job' | 'Pod'

export const workloadKinds: readonly WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Pod']

/**
 * A node in a Log Source's tree. Its root holds one group per kind of Workload that has any; groups hold
 * Workloads (or, for Pods, the pods themselves), a CronJob holds its Jobs, and the rest hold their pods,
 * which hold their containers: the Log Streams. A level below a group with exactly one child carries it folded
 * in: a CronJob its only Job (see its `job`), a Workload its only pod (its `pod`), a pod its only container (its `container`).
 */
export type LogNode = { kind: 'group'; workloadKind: WorkloadKind; name: string; path: SourcePath } | WorkloadNode | PodNode | ContainerNode

/** A Workload in a Log Source's tree, or a CronJob's Job. */
export interface WorkloadNode {
  kind: 'workload'
  workloadKind: Exclude<WorkloadKind, 'Pod'>
  name: string
  path: SourcePath
  /** Deployments, StatefulSets and DaemonSets only: Jobs and CronJobs run to completion, so have none. */
  readyCount?: ReadyCount
  /**
   * A CronJob's only Job, when it has exactly one, folded into it: the CronJob's row stands in for the Job's.
   * The Job is still the CronJob's child, under its path.
   */
  job?: WorkloadNode
  /**
   * The Workload's only pod, when it has exactly one, folded into it (never a CronJob's: its pods are its Jobs').
   * The Workload's row stands in for the pod's; the pod is still its child, under its path.
   */
  pod?: PodNode
  /**
   * Set when the Workload had no pods when listed (a CronJob, no Jobs): its row has nothing to expand. Left out when
   * that isn't known, say if the user may not list pods.
   */
  empty?: true
}

/** A pod in a Log Source's tree. */
export interface PodNode {
  kind: 'pod'
  name: string
  path: SourcePath
  status: PodStatus
  /** How many containers the pod has, init and sidecar containers included. */
  containerCount: number
  /**
   * The pod's only container, when it has exactly one, folded into it: the pod's row opens that container's
   * Log Stream rather than listing it. The container is still the pod's child, under its path.
   */
  container?: ContainerNode
}

export type ContainerRole = 'init' | 'sidecar'

/** How many of a Workload's pods are ready, out of how many it wants. */
export interface ReadyCount {
  ready: number
  desired: number
}

/** How a pod is doing: as it should, on its way up, in trouble, or neither (going away, or its node out of touch). */
export type PodHealth = 'healthy' | 'pending' | 'failing' | 'inactive'

/** A pod's health as the tree shows it; see Pod Status in CONTEXT.md. */
export interface PodStatus {
  /** Its phase, or what's wrong with it, the way kubectl puts it: Running, Pending, CrashLoopBackOff, OOMKilled, Terminating… */
  reason: string
  health: PodHealth
  /** Restarts of all its containers together. */
  restarts: number
  /** Milliseconds since the epoch at which a container of the pod last went down and restarted; left out if none has. */
  lastRestart?: number
  /** Why that container's previous run ended, e.g. OOMKilled or Error; left out if none has restarted. */
  lastTerminationReason?: string
}

/** A container in a Log Source's tree: what opens as a Log Stream. */
export interface ContainerNode {
  kind: 'container'
  name: string
  path: SourcePath
  /** Set for an init container, or a sidecar (an init container that keeps running); left out for the pod's main containers. */
  role?: ContainerRole
  /** How many times the container has restarted; left out until it has. Its log view then offers its Previous Log. */
  restarts?: number
}

export type TreeNode = EntryNode | LogNode | ErrorNode | MoreNode | FoldedNode

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
  /**
   * Opens a file over the Large File threshold in the editor anyway, as long as its content (once decompressed)
   * is no larger than the "open anyway" limit: OVER_OPEN_ANYWAY_LIMIT otherwise.
   */
  inEditor?: boolean
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
  /** In bytes, after any decompression; left out for a Large compressed file, which isn't decompressed whole just to tell. */
  contentLength?: number
}

/** A file shown as a hex dump: offset, bytes and printable characters, 16 bytes per line. */
export interface HexFile extends OpenedFileFacts {
  view: 'hex'
  /** The dump of the first `shownLength` bytes; a large file's is cut short. */
  content: string
  /** In bytes, after any decompression; left out for a Large compressed file, which isn't decompressed whole just to tell. */
  contentLength?: number
  shownLength: number
}

/**
 * The encodings a Large File can be shown in: its lines are found by their line feed bytes, so only
 * encodings whose line feed is a byte of its own.
 */
export type LargeFileEncoding = Extract<TextEncoding, 'utf-8' | 'latin1'>

/**
 * A Large File, opened in the Large File Viewer: its last lines straight away, while the core caches the
 * whole file and indexes its lines in the background (see largeFileStatus), after which any of its lines
 * can be read (see readLargeFileLines).
 */
export interface LargeFile extends OpenedFileFacts {
  view: 'large'
  /** Names this opening of the file in the Large File calls and events, until closeLargeFile. */
  largeFileId: string
  /** How its lines are decoded. */
  encoding: LargeFileEncoding
  /**
   * Its last lines, read from its end, and exactly its last ones, so the first of them is line `lineCount -
   * lastLines.length` once that's known. Empty for a compressed file, whose end is only reached by decompressing all of it.
   */
  lastLines: string[]
}

/** How far caching and indexing a Large File has got. */
export type LargeFileStatus =
  /** Reading the file into the cache (or, once cached, through the cache), `loadedBytes` of `totalBytes` so far. */
  | { state: 'caching'; loadedBytes: number; totalBytes: number }
  /**
   * Cached and indexed: any of its lines can be read, and it can be searched. `contentLength` is in bytes, once
   * decompressed. `fromCache` when it was cached already when opened.
   */
  | { state: 'ready'; lineCount: number; contentLength: number; fromCache: boolean }
  /** Caching stopped; only the last lines it opened with is shown. */
  | { state: 'failed'; code: CoreErrorCode; message: string }

export type LargeFileEvent = LargeFileStatus & { largeFileId: string }

/** Lines of a Large File, from `firstLine` (from 0) on. */
export interface LargeFileLines {
  firstLine: number
  /** Without their line breaks; a line too long to show is cut short, ending in '…'. */
  lines: string[]
}

/** What to search a Large File for: a JavaScript regular expression, matched against each line in turn. */
export interface LargeFileSearchQuery {
  pattern: string
  /** Tells upper and lower case apart; off unless asked for. */
  matchCase?: boolean
}

/** A line of a Large File that matches a search, with a piece of it around its first match. */
export interface LargeFileMatch {
  /** From 0. */
  line: number
  /** Part of the line, starting a little before its first match; the whole line when it's short. */
  preview: string
  /** Where the first match is in `preview`: from `start` up to (not including) `end`. */
  start: number
  end: number
}

/** What a search of a Large File reports as it reads through the file, in order. */
export type LargeFileSearchUpdate =
  /** How far it has read, `scannedBytes` of `totalBytes`, and the matching lines found since the last update, in order. */
  | { kind: 'progress'; scannedBytes: number; totalBytes: number; matches: LargeFileMatch[] }
  /**
   * The whole file has been searched: `matchedLines` lines match. When `limited`, there were more than the
   * matches reported, which stop at largeFileSearchLimit.
   */
  | { kind: 'done'; matchedLines: number; limited: boolean }
  /** It stopped, say because the file couldn't be read. */
  | { kind: 'failed'; code: CoreErrorCode; message: string }

export type LargeFileSearchEvent = LargeFileSearchUpdate & { searchId: string }

/** The most matching lines a search reports; it counts the rest without sending them. */
export const largeFileSearchLimit = 10_000

/** An opened file, in whichever view suits its content (or was asked for). */
export type OpenedFile = TextFile | BinaryFile | HexFile | LargeFile

/** The last lines of a container's log, as a snapshot. */
export interface LogSnapshot {
  view: 'log'
  /** What the lines are of: a container's Log Stream. */
  of: 'logStream'
  /** The container's path in its Source's tree. */
  path: SourcePath
  /** The container's name. */
  name: string
  /** The pod the container is in. */
  pod: string
  /** Whether this is the container's Previous Log: the log of its run before the current one. */
  previous: boolean
  /** Whether the container had restarted when read, so has a Previous Log to switch to. */
  restarted: boolean
  /** The lines asked for; the snapshot holds at most that many. */
  lastNLines: LastNLines
  /** Whether each line starts with when it was logged: an RFC 3339 timestamp in UTC, then a space. */
  timestamps: boolean
  /** The lines, joined by '\n', without a final line break. */
  content: string
}

export interface OpenLogOptions {
  /** How many of the last lines to fetch; the Source's remembered number (or the Settings default) when left out. */
  lastNLines?: LastNLines
  /** Fetches all of a log even when it's larger than the Large File threshold, rather than failing with LOG_TOO_LARGE. */
  allowLarge?: boolean
  /** Starts each line with when it was logged; off unless asked for. */
  timestamps?: boolean
  /** Reads the container's Previous Log rather than its current one. */
  previous?: boolean
}

/** A Log Stream's snapshot, and the Follow that goes on from its last line; see followLog. */
export interface FollowedLog extends LogSnapshot {
  followId: string
}

/** Why a Follow ended by itself: its container finished for good, its pod or container went away, or its Source was disconnected. */
export type FollowEndReason = 'exited' | 'gone' | 'disconnected'

/** What a Follow reports as its Log Stream goes on, in order. */
export type FollowUpdate =
  /** New lines, formatted like the snapshot's (with timestamps if it had them). */
  | { kind: 'lines'; lines: string[] }
  /** The container restarted; the lines after this are its new run's. */
  | { kind: 'restarted' }
  /** A followed file was cut short; the lines after this are from its start. */
  | { kind: 'truncated' }
  /** Another file took a followed file's place, as log rotation does; the lines after this are the new one's. */
  | { kind: 'rotated' }
  /** The stream failed, say the network dropped; it's tried again in `retryIn` milliseconds. */
  | { kind: 'failed'; code: CoreErrorCode; message: string; retryIn: number }
  /** Following again after failing. */
  | { kind: 'recovered' }
  /** Nothing more comes. */
  | { kind: 'ended'; reason: FollowEndReason }

export type FollowEvent = FollowUpdate & { followId: string }

/** The last lines of a file, shown in a log view. */
export interface FileLog {
  view: 'log'
  /** What the lines are of: a file. */
  of: 'file'
  path: SourcePath
  /** The file's name. */
  name: string
  /** A file has no Previous Log. */
  previous: false
  /** The lines asked for; the log view holds at most that many. */
  lastNLines: LastNLines
  /** A file's lines come as they are, with no timestamps added. */
  timestamps: false
  /** The lines, joined by '\n', without a final line break; decoded as UTF-8. */
  content: string
}

/** What a log view's lines are of: a container's Log Stream, or a file. */
export type LogOf = LogSnapshot['of'] | FileLog['of']

/** The Source Types whose files grow, so can be Followed: S3 objects don't. */
export const followableSourceTypes: readonly SourceTypeId[] = ['local', 'kubernetesFiles']

/** How many of a file's last lines to show; see OpenLogOptions. */
export type FileLogOptions = Pick<OpenLogOptions, 'lastNLines' | 'allowLarge'>

/** A file's last lines, and the Follow that goes on from them; see followFile. */
export interface FollowedFile extends FileLog {
  followId: string
}

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
  /** A Kubernetes RBAC denial; the message says what's missing, e.g. `get pods/log in namespace shop`. */
  | 'MISSING_PERMISSION'
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
  | 'CREDENTIALS_UNAVAILABLE'
  | 'INVALID_PROXY'
  | 'CA_BUNDLE_UNREADABLE'
  | 'CERTIFICATE_UNTRUSTED'
  | 'UNREACHABLE'
  | 'CONTEXT_REQUIRED'
  | 'CONTEXT_NOT_FOUND'
  | 'KUBECONFIG_UNREADABLE'
  | 'INVALID_NAMESPACE'
  | 'NAMESPACE_NOT_FOUND'
  | 'NOT_A_LOG_STREAM'
  | 'LOG_UNAVAILABLE'
  /** A Previous Log whose run Kubernetes no longer keeps, say a crash-looping container's run before its last. */
  | 'PREVIOUS_LOG_GONE'
  | 'LOG_TOO_LARGE'
  | 'INVALID_LINE_COUNT'
  | 'NOT_FOLLOWABLE'
  | 'INVALID_WORKLOAD_KIND'
  | 'WORKLOAD_REQUIRED'
  | 'WORKLOAD_NOT_FOUND'
  | 'INVALID_CONTAINER_PATH'
  /** A Kubernetes Files pod that's gone, say after a rollout replaced it. */
  | 'POD_GONE'
  | 'CONTAINER_NOT_RUNNING'
  /** A container image without `sh`, so its files can't be listed or read. */
  | 'NO_SHELL'
  /** A container whose shell lacks a tool listing or reading needs; the message names it. */
  | 'TOOLS_MISSING'
  /** A Large File closed, or never opened: its id names nothing. */
  | 'LARGE_FILE_NOT_OPEN'
  /** A Large File's lines were asked for before it was cached and indexed. */
  | 'LARGE_FILE_NOT_READY'
  /** A Large File bigger than the whole local cache, so it can't be cached. */
  | 'CACHE_TOO_SMALL'
  /** The local cache couldn't be written, say for a full disk. */
  | 'CACHE_UNWRITABLE'
  /** A file to be opened in the editor anyway whose content is over the "open anyway" limit. */
  | 'OVER_OPEN_ANYWAY_LIMIT'
  /** A search pattern that isn't a regular expression, or is empty. */
  | 'INVALID_PATTERN'
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
  /**
   * Reads a file and decides how to show it; `options` reopens it another way, e.g. in another encoding. A file
   * over the Large File threshold (once decompressed, if it's compressed) opens as a LargeFile, which stays
   * open, caching, until closeLargeFile.
   */
  openFile(sourceId: string, path: SourcePath, options?: OpenOptions): Promise<OpenedFile>
  /** How far caching a Large File has got; its changes come as LargeFileEvents too. */
  largeFileStatus(largeFileId: string): Promise<LargeFileStatus>
  /**
   * Up to `count` of a Large File's lines from `firstLine` (from 0) on, once it's ready: fewer at its end, none
   * past it. Before then, LARGE_FILE_NOT_READY.
   */
  readLargeFileLines(largeFileId: string, firstLine: number, count: number): Promise<LargeFileLines>
  /**
   * Starts searching a ready Large File, line by line from its start; its matches and progress arrive as
   * LargeFileSearchEvents with the returned `searchId`, ending with `done` or `failed`. Before it's ready,
   * LARGE_FILE_NOT_READY; a pattern that isn't a regular expression, INVALID_PATTERN. Lines too long to show
   * are searched as far as they're shown.
   */
  searchLargeFile(largeFileId: string, query: LargeFileSearchQuery): Promise<{ searchId: string }>
  /** Stops a search; nothing more is sent for it. Nothing happens to one already finished. */
  cancelLargeFileSearch(searchId: string): Promise<void>
  /** Stops caching a Large File, and any searches of it, and lets it go; the cache keeps what was cached. Nothing happens to one already closed. */
  closeLargeFile(largeFileId: string): Promise<void>
  /**
   * Fetches the last lines of a container's log in a Log Source. Asking for all of a log larger than the
   * Large File threshold fails with LOG_TOO_LARGE, unless `allowLarge` says to go ahead.
   */
  openLog(sourceId: string, path: SourcePath, options?: OpenLogOptions): Promise<LogSnapshot>
  /**
   * Opens a container's log like openLog, and Follows it from its last line: what comes next arrives as
   * FollowEvents with the returned `followId`, until the Follow is stopped or ends by itself (disconnecting
   * its Source ends it). While the container restarts, the Follow goes on with its new run. A Previous Log
   * has ended, so can't be followed: asking for one fails with NOT_FOLLOWABLE.
   */
  followLog(sourceId: string, path: SourcePath, options?: OpenLogOptions): Promise<FollowedLog>
  /**
   * Reads a file's last lines to show in a log view, reading back from its end only as far as they go, so a
   * huge file's are as quick to read as a small one's. Asking for all of a file larger than the Large File
   * threshold fails with LOG_TOO_LARGE, unless `allowLarge` says to go ahead.
   */
  openFileLog(sourceId: string, path: SourcePath, options?: FileLogOptions): Promise<FileLog>
  /**
   * Opens a file's last lines like openFileLog, holding back a last line not yet ended, and Follows the file
   * from there: its new lines arrive as FollowEvents with the returned `followId`, with a mark when the
   * file is cut short (`truncated`) or replaced by another (`rotated`), each then followed from its start.
   * The Follow ends when the file's pod is gone, or its Source is disconnected. Only Local and Kubernetes
   * Files Sources' files grow: an S3 object can't be followed, NOT_FOLLOWABLE.
   */
  followFile(sourceId: string, path: SourcePath, options?: FileLogOptions): Promise<FollowedFile>
  /** Holds a Follow's updates back until it's resumed, keeping at most its "Last N lines" of them. Does nothing to a Follow that has ended. */
  pauseFollow(followId: string): Promise<void>
  /** Sends a paused Follow's held updates, then goes on as before. */
  resumeFollow(followId: string): Promise<void>
  /** Stops a Follow; nothing more is sent for it. */
  stopFollow(followId: string): Promise<void>
  /** Remembers the "Last N lines" for a Source's log views; null forgets it, going back to the Settings default. */
  rememberLastNLines(sourceId: string, lastNLines: LastNLines | null): Promise<void>
  /** The profiles in the local AWS config and credentials files, by name, `default` first; none if there are no such files. */
  listAwsProfiles(): Promise<string[]>
  /** The contexts in the user's kubeconfig (KUBECONFIG, or ~/.kube/config), by name; none if there is no kubeconfig. */
  listKubeContexts(): Promise<KubeContext[]>
  /** The namespaces in a context's cluster, by name. */
  listKubeNamespaces(context: string): Promise<string[]>
  /**
   * The Workloads a Kubernetes Files Source can browse in a namespace of a context's cluster, by kind then name.
   * Kinds that can't be listed, say for lack of permission, are left out; fails only if none can be.
   */
  listKubeWorkloads(context: string, namespace: string): Promise<KubeWorkload[]>
  getSettings(): Promise<Settings>
  /** Changes the given settings, keeping the rest; all of them together must still be valid. */
  updateSettings(changes: Partial<Settings>): Promise<Settings>
}

/** What the core announces without being asked. Listeners run in the core's process; IPC forwards them. */
export interface CoreEvents {
  /** Calls `listener` with the new settings after each change is saved; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /** Calls `listener` with every Follow's updates; returns a function that unsubscribes. */
  onFollowEvent(listener: (event: FollowEvent) => void): () => void
  /** Calls `listener` whenever a Large File's status changes; returns a function that unsubscribes. */
  onLargeFileEvent(listener: (event: LargeFileEvent) => void): () => void
  /** Calls `listener` with every Large File search's updates; returns a function that unsubscribes. */
  onLargeFileSearchEvent(listener: (event: LargeFileSearchEvent) => void): () => void
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
  'largeFileStatus',
  'readLargeFileLines',
  'searchLargeFile',
  'cancelLargeFileSearch',
  'closeLargeFile',
  'openLog',
  'followLog',
  'openFileLog',
  'followFile',
  'pauseFollow',
  'resumeFollow',
  'stopFollow',
  'rememberLastNLines',
  'listAwsProfiles',
  'listKubeContexts',
  'listKubeNamespaces',
  'listKubeWorkloads',
  'getSettings',
  'updateSettings'
]

/** How a core call travels back over IPC: errors are values so their code survives. */
export type CoreResult<T> = { ok: true; value: T } | { ok: false; code: CoreErrorCode; message: string }
