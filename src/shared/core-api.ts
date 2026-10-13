// Types shared by the core API (main process) and its callers (renderer, tests).
// Everything here must be serialisable over IPC.

import type { Settings } from './settings'

export type SourceTypeId = 'local' | 'sshFiles' | 's3' | 'azureBlob' | 'kubernetesFiles' | 'kubernetesLogs' | 'dockerLogs' | 'cloudwatchLogs'

/** Every Source Type, in the default order of its sidebar group. */
export const sourceTypeIds: readonly SourceTypeId[] = [
  'local',
  'sshFiles',
  's3',
  'azureBlob',
  'kubernetesFiles',
  'kubernetesLogs',
  'dockerLogs',
  'cloudwatchLogs'
]

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
  auth?: AwsAuth
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

export interface NewAzureBlobSource {
  type: 'azureBlob'
  name: string
  /** The storage account's name, e.g. `contosologs`. */
  account: string
  container: string
  /** The blob name prefix the Source is rooted at, e.g. `logs/app`; the whole container when blank or left out. */
  prefix?: string
  /**
   * The account's blob endpoint, for signing in with a SAS token or as yourself: e.g.
   * `https://<account>.blob.core.usgovcloudapi.net` for Azure Government, `https://<account>.blob.core.chinacloudapi.cn`
   * for Azure in China, or `https://127.0.0.1:10000/devstoreaccount1` for Azurite; Azure's own
   * (`https://<account>.blob.core.windows.net`) when blank or left out. A connection string or SAS URL says where its
   * endpoint is itself.
   */
  endpoint?: string
  /** How the Source signs in: a connection string, a SAS, or as yourself through Azure CLI. A connection string unless given. */
  auth?: AzureBlobAuth
  /**
   * Signing in with a connection string: the storage account's, which says where its blob endpoint is and holds its key.
   * Goes into the OS keychain and never comes back out of the core. Blank or left out when editing keeps the stored one.
   */
  connectionString?: string
  /**
   * Signing in with a SAS: a SAS URL, or the token alone, kept like a connection string. A URL must be for the Source's
   * account and container, when it names them.
   */
  sas?: string
  /** A PEM file of CA certificates trusted as well as the OS trust store; none when blank or left out. */
  caBundlePath?: string
  /** A proxy for this Source alone, e.g. `http://proxy.corp:3128`; when blank or left out, HTTPS_PROXY / NO_PROXY decide. */
  proxyUrl?: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

export interface NewSshFilesSource {
  type: 'sshFiles'
  name: string
  /**
   * The server's host name or address, or a Host alias from the user's `~/.ssh/config`: either way, its HostName,
   * User, Port, IdentityFile and ProxyJump there are used, as ssh uses them.
   */
  host: string
  /** The user to sign in as; when blank, the SSH config's User for the host. */
  user: string
  /** When left out, the SSH config's Port for the host, or else 22. */
  port?: number
  /** The absolute path of the folder browsed on the server, e.g. `/var/log/app`. */
  path: string
  /** How to sign in: `keyFile` when left out. */
  auth?: SshAuth
  /**
   * The private key file that signs in with `keyFile`, on this computer; ignored otherwise. When blank, the SSH
   * config's IdentityFile for the host.
   */
  keyFile?: string
  /**
   * The key file's passphrase, if it's encrypted: goes into the OS keychain and never comes back out of the core.
   * Blank or left out when editing keeps the stored one.
   */
  passphrase?: string
  /** The password that signs in with `password`, kept like a passphrase; blank or left out when editing keeps it. */
  password?: string
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

/** The context a Docker Logs Source uses when it names none: the engine the Docker CLI reaches when told none. */
export const defaultDockerContext = 'default'

export interface NewDockerLogsSource {
  type: 'dockerLogs'
  name: string
  /**
   * The Docker context whose engine the Source reads. `default`, when blank or left out, follows the Docker CLI:
   * DOCKER_HOST's engine, or else DOCKER_CONTEXT's or the CLI's current context's, or else the local one.
   */
  context?: string
  /**
   * How to sign in to the host of an `ssh://` context, as an SSH Files Source signs in to its server: `agent` when left
   * out. Ignored for an engine reached otherwise.
   */
  auth?: SshAuth
  /** The private key file that signs in with `keyFile`; when blank, the SSH config's IdentityFile for the host. */
  keyFile?: string
  /** The key file's passphrase, kept as an SSH Files Source's is; blank or left out when editing keeps the stored one. */
  passphrase?: string
  /** The password that signs in with `password`, kept like a passphrase; blank or left out when editing keeps it. */
  password?: string
  /** The Environment the Source is labelled with; unlabelled when left out. */
  environmentId?: string
}

export interface NewCloudWatchLogsSource {
  type: 'cloudwatchLogs'
  name: string
  /** The one AWS region whose log groups the Source shows, e.g. `eu-west-1`. */
  region: string
  /** Shows only the log groups whose names start with it, e.g. `/aws/lambda/orders-`; all of them when blank or left out. */
  prefix?: string
  /** How the Source signs in, as an S3 Source does: typed keys, or an AWS profile. A profile unless given. */
  auth?: AwsAuth
  /** Signing in with keys: needed then, ignored otherwise. */
  accessKeyId?: string
  /** Signing in with keys: kept as an S3 Source's is. Blank or left out when editing keeps the stored one. */
  secretAccessKey?: string
  /** Signing in with a profile: its name in the local AWS config, SSO ones included; the default credential chain when blank or left out. */
  profile?: string
  /**
   * The CloudWatch Logs endpoint, e.g. a VPC endpoint's `https://vpce-….logs.eu-west-1.vpce.amazonaws.com`; the region's
   * own (or AWS_ENDPOINT_URL_CLOUDWATCH_LOGS's) when blank or left out. https is assumed without a scheme.
   */
  endpoint?: string
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

/** How a Source on AWS signs in: typed access and secret keys, or an AWS profile (or the default credential chain). */
export type AwsAuth = 'keys' | 'profile'

/** How a Source on AWS signs in unless told: an S3 Source with keys, as most S3-compatible stores have no profiles; a CloudWatch Logs Source with a profile. */
export const defaultAwsAuth = (type: 's3' | 'cloudwatchLogs'): AwsAuth => (type === 's3' ? 'keys' : 'profile')

/**
 * How an Azure Blob Storage Source signs in: a connection string or a SAS, both kept in the OS keychain, or as yourself
 * through Azure's default credentials (`az login`, `AZURE_*` variables, a managed identity), with nothing stored.
 */
export type AzureBlobAuth = 'connectionString' | 'sas' | 'azureCli'

/**
 * How an SSH Files Source signs in: with a key in the user's SSH agent (Pageant or OpenSSH's on Windows,
 * SSH_AUTH_SOCK's elsewhere), a private key file, or a password.
 */
export type SshAuth = 'agent' | 'keyFile' | 'password'

/** The user-editable settings of a Source; its Source Type decides which fields exist. */
export type NewSource =
  | NewLocalSource
  | NewSshFilesSource
  | NewS3Source
  | NewAzureBlobSource
  | NewKubernetesFilesSource
  | NewKubernetesLogsSource
  | NewDockerLogsSource
  | NewCloudWatchLogsSource

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
  auth: AwsAuth
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

export interface AzureBlobSourceInfo extends SourceIdentity {
  type: 'azureBlob'
  account: string
  container: string
  /** Normalised: no leading or trailing '/', blank for the whole container. */
  prefix: string
  /** Blank for Azure's own. */
  endpoint: string
  auth: AzureBlobAuth
  /** Whether a connection string is stored for the Source; the connection string itself never leaves the core. Always false unless signing in with one. */
  connectionStringSet: boolean
  /** Whether a SAS is stored for the Source, likewise. */
  sasSet: boolean
  /** Blank for none. */
  caBundlePath: string
  /** Normalised: a URL with its scheme; blank to follow HTTPS_PROXY / NO_PROXY. */
  proxyUrl: string
}

export interface SshFilesSourceInfo extends SourceIdentity {
  type: 'sshFiles'
  /** A host name or address, or an alias from `~/.ssh/config`. */
  host: string
  /** Blank to use the SSH config's. */
  user: string
  /** Left out to use the SSH config's, or else 22. */
  port?: number
  /** Normalised: absolute, without a trailing '/' (but `/` itself for the root). */
  path: string
  auth: SshAuth
  /** Blank unless it signs in with a key file named here rather than by the SSH config's IdentityFile. */
  keyFile: string
  /** Whether a passphrase is stored for the key file; the passphrase itself never leaves the core. */
  passphraseSet: boolean
  /** Whether a password is stored, signing in with one; the password itself never leaves the core. */
  passwordSet: boolean
}

export interface KubernetesLogsSourceInfo extends SourceIdentity {
  type: 'kubernetesLogs'
  context: string
  namespace: string
}

export interface DockerLogsSourceInfo extends SourceIdentity {
  type: 'dockerLogs'
  /** Normalised: `default` when none was named. */
  context: string
  /** How it signs in to an `ssh://` context's host. */
  auth: SshAuth
  /** Blank unless it signs in with a key file, and then blank for the SSH config's IdentityFile. */
  keyFile: string
  /** Whether a passphrase is stored for the key file; the passphrase itself never leaves the core. */
  passphraseSet: boolean
  /** Whether a password is stored; the password itself never leaves the core. */
  passwordSet: boolean
}

export interface CloudWatchLogsSourceInfo extends SourceIdentity {
  type: 'cloudwatchLogs'
  region: string
  /** Blank for every log group. */
  prefix: string
  auth: AwsAuth
  /** Blank when signing in with a profile. */
  accessKeyId: string
  /** Whether a secret key is stored for the Source; the key itself never leaves the core. Always false when signing in with a profile. */
  secretKeySet: boolean
  /** Blank for the default credential chain, and when signing in with keys. */
  profile: string
  /** Normalised: a URL with its scheme, or blank for the region's own. */
  endpoint: string
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

export type SourceInfo =
  | LocalSourceInfo
  | SshFilesSourceInfo
  | S3SourceInfo
  | AzureBlobSourceInfo
  | KubernetesFilesSourceInfo
  | KubernetesLogsSourceInfo
  | DockerLogsSourceInfo
  | CloudWatchLogsSourceInfo

/** A context in the user's kubeconfig, as offered when adding a Kubernetes Source. */
export interface KubeContext {
  name: string
  /** The namespace the context defaults to, if it names one. */
  namespace?: string
  /** Whether it's the kubeconfig's current context. */
  current: boolean
}

/** A context the Docker CLI knows, from its config folder, as offered when adding a Docker Logs Source. */
export interface DockerContext {
  name: string
  /** Where its engine is, e.g. `tcp://build.internal:2376` or `unix:///run/podman/podman.sock`. */
  host: string
  /** Whether the CLI uses it when told none: DOCKER_CONTEXT's, or else its config's current context. */
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

/** What a Log Source Type offers beyond what every one has; the log view and the sidebar show only what it offers. */
export interface LogCapabilities {
  /** Its Log Streams have a Previous Log, the log of the run before their current one, to switch to once they've restarted. */
  previousLog: boolean
  /** Its Log Streams restart: their nodes tell how many times, and a Follow carries on across restarts, marking each. */
  restarts: boolean
  /** Its nodes tell how they're doing (a Kubernetes pod's Pod Status, a Docker container's Container Status). */
  status: boolean
}

/**
 * A node in a Log Source's tree: a group, or a Log Stream, the log output of one thing that logs. A Log Stream may
 * have children of its own too. What the groups are depends on the Source Type (see `kubernetes`). A group with
 * exactly one child may carry it folded in (see `folded`).
 */
export type LogNode = LogGroupNode | LogStreamNode

interface LogNodeBase {
  name: string
  path: SourcePath
  /** How it's doing, from a Source Type with per-node status. */
  status?: NodeStatus
  /** Set when it had no children when listed: its row has nothing to expand. Left out when that isn't known. */
  empty?: true
}

/** A group of nodes in a Log Source's tree. */
export interface LogGroupNode extends LogNodeBase {
  kind: 'group'
  /**
   * Its only child, folded into it: its row stands in for the child's, opening the child's Log Stream or listing
   * the child's children. The child is still its child, under its path.
   */
  folded?: LogNode
  /** Set on a group that never folds its only child into it, however many it has (Kubernetes' groups of Workloads). */
  unfoldable?: true
  /** What the group is, in a Kubernetes Logs Source. */
  kubernetes?: KubernetesLogGroup
  /** What the group is, in a Docker Logs Source. */
  docker?: DockerLogGroup
}

/** A Log Stream in a Log Source's tree: what opens in a log view. */
export interface LogStreamNode extends LogNodeBase {
  kind: 'logStream'
  /** Set when it has children too, listed as a group's are. Its row still stands for its own log, folding nothing in. */
  hasChildren?: true
  /** How many times it has restarted, from a Source Type with restarts; left out until it has. */
  restarts?: number
  /** What the Log Stream is, in a Kubernetes Logs Source. */
  kubernetes?: KubernetesLogStream
  /** What the Log Stream is, in a Docker Logs Source. */
  docker?: DockerLogStream
  /** What the Log Stream is, in a CloudWatch Logs Source: a log stream, or a log group, its streams merged. */
  cloudwatch?: CloudWatchLogStream | CloudWatchLogGroup
}

/** The kinds of Workload a Kubernetes Logs Source groups its tree by; a Pod stands for a pod no Workload owns. */
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob' | 'Job' | 'Pod'

export const workloadKinds: readonly WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Pod']

/**
 * What a group is in a Kubernetes Logs Source. Its root holds one group per kind of Workload that has any; those hold
 * Workloads (or, for Pods, the pods themselves), a CronJob holds its Jobs, and the rest hold their pods, which hold
 * their containers: the Log Streams. A CronJob may fold in its only Job, a Workload its only pod, a pod its only container.
 */
export type KubernetesLogGroup =
  | { kind: 'workloads'; workloadKind: WorkloadKind }
  | {
      /** A Workload, or a CronJob's Job. */
      kind: 'workload'
      workloadKind: Exclude<WorkloadKind, 'Pod'>
      /** Deployments, StatefulSets and DaemonSets only: Jobs and CronJobs run to completion, so have none. */
      readyCount?: ReadyCount
    }
  | {
      kind: 'pod'
      /** How many containers the pod has, init and sidecar containers included. */
      containerCount: number
    }

/** What a Log Stream is in a Kubernetes Logs Source: a container. */
export interface KubernetesLogStream {
  kind: 'container'
  /** Set for an init container, or a sidecar (an init container that keeps running); left out for the pod's main containers. */
  role?: ContainerRole
}

export type ContainerRole = 'init' | 'sidecar'

/**
 * What a group is in a Docker Logs Source. Its root holds a group per Compose project, which holds a group per service,
 * which holds its containers: the Log Streams. Containers outside Compose are under one Standalone group, which never
 * folds. A project may fold in its only service, a service its only container.
 */
export type DockerLogGroup = { kind: 'project' } | { kind: 'service' } | { kind: 'standalone' }

/** The Standalone group's path, and name: never a Compose project's, which can't start with `_`. */
export const dockerStandaloneGroup = '_standalone'

/** What a Log Stream is in a Docker Logs Source: a container, running or stopped. */
export interface DockerLogStream {
  kind: 'container'
  /** The image it runs, as it was asked for, e.g. `nginx:1.27`. */
  image?: string
  /** Milliseconds since the epoch at which its current run started, or its last one if it isn't running; left out if it never has. */
  startedAt?: number
  /** Milliseconds since the epoch at which it exited, when it isn't running; left out while it is. */
  finishedAt?: number
}

/**
 * What a Log Stream with children is in a CloudWatch Logs Source: a log group, holding its log streams, newest event
 * first, whose log is theirs merged, interleaved by time, each line starting with a short form of its stream's name.
 */
export interface CloudWatchLogGroup {
  kind: 'logGroup'
  /** How many bytes of events it holds, as CloudWatch last worked it out. */
  storedBytes?: number
  /** How many days it keeps its events; left out when it keeps them for ever. */
  retentionDays?: number
}

/**
 * A CloudWatch log group's or stream's name as its path segment, and so its node's name: '/' stands in it as the
 * division slash (∕), which looks like it, as log groups' names are full of them and streams' often have some. A stream
 * whose own name has a division slash can't be told apart, so isn't found.
 */
export const cloudWatchSegment = (name: string) => name.replaceAll('/', '\u2215')

/** The name of the CloudWatch log group or stream a path segment stands for; see cloudWatchSegment. */
export const cloudWatchNameOf = (segment: string) => segment.replaceAll('\u2215', '/')

/** What a Log Stream is in a CloudWatch Logs Source: a log stream of a log group. */
export interface CloudWatchLogStream {
  kind: 'logStream'
  /** Milliseconds since the epoch of its newest event; left out while it has none. */
  lastEventTime?: number
}

/** How many of a Workload's pods are ready, out of how many it wants. */
export interface ReadyCount {
  ready: number
  desired: number
}

/** How a node is doing: as it should, on its way up, in trouble, or neither (going away, or out of touch). */
export type NodeHealth = 'healthy' | 'pending' | 'failing' | 'inactive'

/** A node's health as the tree shows it: a pod's Pod Status, or a container's Container Status (see GLOSSARY.md). */
export interface NodeStatus {
  /** What it's doing, or what's wrong with it, e.g. a pod's phase the way kubectl puts it: Running, Pending, CrashLoopBackOff, OOMKilled, Terminating… */
  reason: string
  health: NodeHealth
  /** Restarts of all it runs together, e.g. all a pod's containers. */
  restarts: number
  /** Milliseconds since the epoch at which what it runs last went down and restarted; left out if nothing has. */
  lastRestart?: number
  /** Why that run ended, e.g. OOMKilled or Error; left out if nothing has restarted. */
  lastTerminationReason?: string
}

/** A pod's health; see Pod Status in GLOSSARY.md. */
export type PodStatus = NodeStatus

export type TreeNode = EntryNode | LogNode | ErrorNode | MoreNode | FoldedNode

/** A Host alias in the user's `~/.ssh/config`, with what the config says about it. */
export interface SshHost {
  alias: string
  /** Its HostName, or the alias itself if it names none. */
  hostName: string
  user?: string
  port?: number
}

/** An SSH server's host key, as offered to the user to trust: never the key itself, which stays in the core. */
export interface HostKey {
  host: string
  port: number
  /** As OpenSSH names it, e.g. `ssh-ed25519`. */
  keyType: string
  /** As OpenSSH shows it: `SHA256:` and the key's SHA-256 hash in unpadded base64. */
  fingerprint: string
}

/** Whether the app is talking to a Source right now. Never persisted: every launch starts Disconnected. */
export type ConnectionState =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'connected' }
  /** `hostKey` is set when the failure is HOST_KEY_UNKNOWN: the key the user may trust (see trustHostKey). */
  | { state: 'error'; code: CoreErrorCode; message: string; hostKey?: HostKey }

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

/** The last lines of a Log Stream, as a snapshot. */
export interface LogSnapshot {
  view: 'log'
  /** What the lines are of: a Log Stream. */
  of: 'logStream'
  /** The Log Stream's path in its Source's tree. */
  path: SourcePath
  /** The Log Stream's name: a container's, say. */
  name: string
  /** Whether its Source Type has Previous Logs, so its log view offers to switch to one. */
  offersPreviousLog: boolean
  /** Whether this is the Log Stream's Previous Log: the log of its run before the current one. */
  previous: boolean
  /** Whether it had a Previous Log to switch to when read: it had restarted. Never, from a Source Type without Previous Logs. */
  restarted: boolean
  /** The lines asked for; the snapshot holds at most that many. */
  lastNLines: LastNLines
  /** Whether each line starts with when it was logged: an RFC 3339 timestamp in UTC, then a space. */
  timestamps: boolean
  /** The lines, joined by '\n', without a final line break. */
  content: string
  /**
   * Where the lines before these end, to read them with readEarlierLog; left out when there are none, or when its
   * Source Type can't read further back.
   */
  earlier?: string
}

/** How many of the lines before those a log view shows to read; see readEarlierLog. */
export interface EarlierLogOptions {
  /** Where they end: the `earlier` of the snapshot, or of the lines read further back last. */
  earlier: string
  /** How many to read; at most that many come. */
  lines: number
  /** Starts each line with when it was logged, as the snapshot's do. */
  timestamps?: boolean
}

/** Lines of a Log Stream before those a log view shows. */
export interface EarlierLog {
  /** The lines, joined by '\n', without a final line break. */
  content: string
  /** Where the lines before these end; left out at the log's start. */
  earlier?: string
}

export interface OpenLogOptions {
  /** How many of the last lines to fetch; the Source's remembered number (or the Settings default) when left out. */
  lastNLines?: LastNLines
  /** Fetches all of a log even when it's larger than the Large File threshold, rather than failing with LOG_TOO_LARGE. */
  allowLarge?: boolean
  /** Starts each line with when it was logged; off unless asked for. */
  timestamps?: boolean
  /** Reads the Log Stream's Previous Log rather than its current one, from a Source Type with Previous Logs. */
  previous?: boolean
}

/** A Log Stream's snapshot, and the Follow that goes on from its last line; see followLog. */
export interface FollowedLog extends LogSnapshot {
  followId: string
}

/** Why a Follow ended by itself: its Log Stream finished for good (a container, say), or went away, its Source was disconnected, or the connection it went over dropped. */
export type FollowEndReason = 'exited' | 'gone' | 'disconnected' | 'connectionLost'

/** What a Follow reports as its Log Stream goes on, in order. */
export type FollowUpdate =
  /** New lines, formatted like the snapshot's (with timestamps if it had them). */
  | { kind: 'lines'; lines: string[] }
  /** The Log Stream restarted (from a Source Type with restarts); the lines after this are its new run's. */
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

/** A Source's connection state, changed by itself; see onConnectionEvent. */
export type ConnectionEvent = ConnectionState & { sourceId: string }

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

/** The Source Types whose files grow, so can be Followed: S3 and Azure Blob objects don't. */
export const followableSourceTypes: readonly SourceTypeId[] = ['local', 'kubernetesFiles', 'sshFiles']

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
  /** A UNC share whose server VS Code hasn't been allowed to reach (its `security.allowedUNCHosts` setting). */
  | 'UNC_HOST_NOT_ALLOWED'
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
  /** A CloudWatch Logs Source without a region. */
  | 'REGION_REQUIRED'
  | 'ACCOUNT_REQUIRED'
  | 'CONTAINER_REQUIRED'
  | 'CONNECTION_STRING_REQUIRED'
  | 'INVALID_CONNECTION_STRING'
  | 'CONTAINER_NOT_FOUND'
  | 'SAS_REQUIRED'
  | 'INVALID_SAS'
  | 'SAS_EXPIRED'
  | 'ACCOUNT_NOT_FOUND'
  | 'ROLE_REQUIRED'
  | 'AZURE_LOGIN_REQUIRED'
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
  /** An SSH Files Source without a host. */
  | 'HOST_REQUIRED'
  | 'USER_REQUIRED'
  /** A port that isn't a whole number from 1 to 65535. */
  | 'INVALID_PORT'
  /** A folder path that isn't absolute, or climbs with '..'. */
  | 'INVALID_PATH'
  | 'KEY_FILE_REQUIRED'
  /** An SSH Files Source signing in with a password, with none given or stored. */
  | 'PASSWORD_REQUIRED'
  /** Signing in through the SSH agent with no agent running, or none at SSH_AUTH_SOCK. */
  | 'AGENT_NOT_FOUND'
  /** A key file that's missing, unreadable, or not a private key. */
  | 'KEY_FILE_UNREADABLE'
  /** An encrypted key file with no passphrase stored for it. */
  | 'PASSPHRASE_REQUIRED'
  | 'PASSPHRASE_WRONG'
  /** An SSH server whose host key isn't known yet; the failure carries the key for the user to trust. */
  | 'HOST_KEY_UNKNOWN'
  /** An SSH server whose host key isn't the one known for it: maybe an impostor, so it's never connected to. */
  | 'HOST_KEY_CHANGED'
  /** An SSH server that refused to let the user sign in. */
  | 'SIGN_IN_REFUSED'
  /** An SSH server with its SFTP subsystem turned off. */
  | 'SFTP_UNAVAILABLE'
  /** A host whose `~/.ssh/config` needs an option Polyscope doesn't support, like ProxyCommand; the message names it. */
  | 'UNSUPPORTED_SSH_OPTION'
  /** A Docker host (DOCKER_HOST's, or a context's) Polyscope can't reach an engine through, like an `fd://` one; the message names it. */
  | 'UNSUPPORTED_DOCKER_HOST'
  /** An `ssh://` Docker host without the `docker` command, or with none on the signed-in user's PATH. */
  | 'DOCKER_NOT_FOUND'
  | 'UNKNOWN'

/** What a connection test that passed found out. */
export interface TestedConnection {
  /** What the Source reached says it is, e.g. `Docker Engine 27.3.1`; left out by Source Types that don't tell. */
  serverVersion?: string
}

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
  testConnection(input: NewSource, sourceId?: string): Promise<TestedConnection>
  /** Drops the connection and stops all activity against the Source. */
  disconnect(sourceId: string): Promise<void>
  /**
   * Trusts an SSH server's host key, one a HOST_KEY_UNKNOWN failure just offered, keeping it in Polyscope's own
   * trusted host keys (never the user's `~/.ssh/known_hosts`). A key not offered since the app started is
   * HOST_KEY_UNKNOWN again: connecting once more offers it.
   */
  trustHostKey(hostKey: HostKey): Promise<void>
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
   * Fetches the last lines of a Log Stream in a Log Source. Asking for all of a log larger than the
   * Large File threshold fails with LOG_TOO_LARGE, unless `allowLarge` says to go ahead. Asking for the Previous Log
   * of a Log Stream whose Source Type has none fails with LOG_UNAVAILABLE.
   */
  openLog(sourceId: string, path: SourcePath, options?: OpenLogOptions): Promise<LogSnapshot>
  /**
   * Reads a Log Stream's lines before those a log view shows, from where its snapshot's (or the last lines read this
   * way's) `earlier` says. Fails with LOG_UNAVAILABLE when its Source Type can't read further back.
   */
  readEarlierLog(sourceId: string, path: SourcePath, options: EarlierLogOptions): Promise<EarlierLog>
  /**
   * Opens a Log Stream like openLog, and Follows it from its last line: what comes next arrives as
   * FollowEvents with the returned `followId`, until the Follow is stopped or ends by itself (disconnecting
   * its Source ends it). From a Source Type with restarts, the Follow goes on with each new run; from one
   * without, it ends when the Log Stream does. A Previous Log
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
   * The Follow ends when the file's pod is gone, its Source is disconnected, or the connection it goes over
   * drops (`connectionLost`). Only Local, Kubernetes Files and SSH Files Sources' files grow: an S3 or Azure Blob object
   * can't be followed, NOT_FOLLOWABLE.
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
  /**
   * The region a local AWS profile names, as the AWS CLI would use it; for blank, the default credential chain's
   * (AWS_REGION, or else the default profile's). Blank if none is named.
   */
  awsProfileRegion(profile: string): Promise<string>
  /** The Host aliases in the user's `~/.ssh/config` (and the files it Includes), in the order they come, with what it says about each. */
  listSshHosts(): Promise<SshHost[]>
  /** The contexts in the user's kubeconfig (KUBECONFIG, or ~/.kube/config), by name; none if there is no kubeconfig. */
  listKubeContexts(): Promise<KubeContext[]>
  /** The namespaces in a context's cluster, by name. */
  listKubeNamespaces(context: string): Promise<string[]>
  /**
   * The Workloads a Kubernetes Files Source can browse in a namespace of a context's cluster, by kind then name.
   * Kinds that can't be listed, say for lack of permission, are left out; fails only if none can be.
   */
  listKubeWorkloads(context: string, namespace: string): Promise<KubeWorkload[]>
  /** The contexts in the Docker CLI's config folder (DOCKER_CONFIG, or ~/.docker), by name; none if there are none. */
  listDockerContexts(): Promise<DockerContext[]>
  getSettings(): Promise<Settings>
  /** Changes the given settings, keeping the rest; all of them together must still be valid. */
  updateSettings(changes: Partial<Settings>): Promise<Settings>
}

/** What the core announces without being asked. Listeners run in the core's process; IPC forwards them. */
export interface CoreEvents {
  /** Calls `listener` with the new settings after each change is saved; returns a function that unsubscribes. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void
  /**
   * Calls `listener` when a Source's connection changes with nothing having asked it to, as connect and disconnect do: a
   * Source whose connection dropped going to Error, when connecting it again fails. Returns a function that unsubscribes.
   */
  onConnectionEvent(listener: (event: ConnectionEvent) => void): () => void
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
  'trustHostKey',
  'expand',
  'openFile',
  'largeFileStatus',
  'readLargeFileLines',
  'searchLargeFile',
  'cancelLargeFileSearch',
  'closeLargeFile',
  'openLog',
  'readEarlierLog',
  'followLog',
  'openFileLog',
  'followFile',
  'pauseFollow',
  'resumeFollow',
  'stopFollow',
  'rememberLastNLines',
  'listAwsProfiles',
  'awsProfileRegion',
  'listSshHosts',
  'listKubeContexts',
  'listKubeNamespaces',
  'listKubeWorkloads',
  'listDockerContexts',
  'getSettings',
  'updateSettings'
]

/** How a core call travels back over IPC: errors are values so their code survives. */
export type CoreResult<T> = { ok: true; value: T } | { ok: false; code: CoreErrorCode; message: string; hostKey?: HostKey }
