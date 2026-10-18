import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type {
  AzureBlobSourceInfo,
  CloudWatchLogsSourceInfo,
  Compression,
  ConnectionEvent,
  ConnectionState,
  CoreApi,
  CoreEvents,
  DockerLogsSourceInfo,
  EntryNode,
  FoldedNode,
  Environment,
  FileLog,
  FilesWorkloadKind,
  FollowEndReason,
  FollowEvent,
  FollowUpdate,
  KubernetesFilesSourceInfo,
  KubernetesLogsSourceInfo,
  LargeFileEvent,
  LargeFileSearchEvent,
  SaveCopyEvent,
  SaveCopyStarted,
  LastNLines,
  LocalSourceInfo,
  LogCapabilities,
  LogNode,
  LogSnapshot,
  NewAzureBlobSource,
  NewCloudWatchLogsSource,
  NewEnvironment,
  NewS3Source,
  NewSource,
  NewSshFilesSource,
  LargeFile,
  OpenLogOptions,
  OpenOptions,
  OpenedFile,
  S3SourceInfo,
  SourceInfo,
  SourcePath,
  SourceTypeId,
  SshAuth,
  SshFilesSourceInfo,
  SystemdJournalSourceInfo,
  TextEncoding,
  FileLogOptions,
  TreeNode
} from '@shared/core-api'
import { defaultAwsAuth, defaultDockerContext, filesWorkloadKinds, followableSourceTypes, workloadKinds } from '@shared/core-api'
import { searchRegExp } from '@shared/search'
import { defaultSettings, isRecord, pickSettings, settingProblems, type Settings } from '@shared/settings'
import { awsProfileRegion, listAwsProfiles } from './aws-profiles'
import type { AwsCredentials } from './aws-sign-in'
import { checkConnectionString, checkSas, createAzureBlobFileSource, type AzureBlobTarget } from './azure-blob-file-source'
import { createCloudWatchLogSource, type CloudWatchTarget } from './cloudwatch-log-source'
import { CoreError } from './core-error'
import { dockerEndpointOf, listDockerContexts } from './docker-contexts'
import { connectDockerEngine } from './docker-log-source'
import { dialerOver } from './docker-ssh'
import { createEnvironmentStore, defaultEnvironments, isColor } from './environment-store'
import {
  binarySniffLength,
  checkEncoding,
  compressionOf,
  decode,
  detectEncoding,
  detectLargeFileEncoding,
  hexDump,
  hexDumpLimit,
  inflate
} from './file-content'
import { readLastLines, startFileFollow } from './file-follow'
import { fileIcon, folderIcon } from './file-icons'
import type { FileSource, FileStat } from './file-source'
import { kubeConfigFor, listKubeContexts } from './kubeconfig'
import { listNamespaces } from './kubernetes-api'
import { createKubernetesFileSource, listWorkloads } from './kubernetes-file-source'
import { createKubernetesLogSource } from './kubernetes-log-source'
import { createHostKeyStore } from './host-keys'
import { createJournalLogSource, journalHostOver, thisMachine } from './journal-log-source'
import { languageFor } from './languages'
import { chunksOf, openLargeFile, readLastLinesBytes, lastLinesOf, type OpenLargeFile } from './large-file'
import { createLargeFileCache } from './large-file-cache'
import { searchLargeFile, type LargeFileSearch } from './large-file-search'
import { createLocalFileSource } from './local-file-source'
import { startFollow, type Follow } from './log-follow'
import { currentRunOf, type LogReadOptions, type LogSource } from './log-source'
import { readCaBundle } from './network-agents'
import { createRegistryStore, emptyRegistry, type SavedSource } from './registry-store'
import { createS3FileSource, type S3Target } from './s3-file-source'
import { saveCopy as startSaveCopy, type SavingCopy } from './save-copy'
import { createSecretStore, type SecretStore } from './secret-store'
import { createSettingsStore } from './settings-store'
import { findSshAgent } from './ssh-agent'
import { readSshConfig, routeTo } from './ssh-config'
import { connectSsh, type PresentedHostKey, type SshSignIn } from './ssh-connection'
import { createSshFileSource } from './ssh-file-source'

const asCoreError = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const isLastNLines = (value: unknown): value is LastNLines => value === 'all' || (Number.isSafeInteger(value) && (value as number) > 0)

function checkLastNLines(value: unknown): LastNLines {
  if (!isLastNLines(value)) throw new CoreError('INVALID_LINE_COUNT', `Not a whole number of lines greater than zero, or all: ${String(value)}`)
  return value
}

const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i

/** A Since, an RFC 3339 time in any time zone, as one in UTC. */
function checkSince(value: unknown): string {
  const time = typeof value === 'string' && rfc3339.test(value) ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) throw new CoreError('INVALID_SINCE', `Not an RFC 3339 time: ${String(value)}`)
  return new Date(time).toISOString()
}

/** The RFC 3339 timestamp a log line read with timestamps starts with; an empty line may be its timestamp alone. */
const timestampOf = (line: string) => line.slice(0, line.indexOf(' ') < 0 ? line.length : line.indexOf(' '))

/** A Source without its remembered "Last N lines". */
const withoutLastNLines = <S extends SavedSource>({ lastNLines: _, ...source }: S) => source as S

/** Fills in settings added since a Source was saved with their defaults, and drops a "Last N lines" that makes no sense. */
function withDefaults(saved: SavedSource): SavedSource {
  const source = saved.lastNLines === undefined || isLastNLines(saved.lastNLines) ? saved : withoutLastNLines(saved)
  switch (source.type) {
    case 'local':
      return { ...source, showHidden: source.showHidden ?? true }
    case 's3':
      return {
        ...source,
        auth: source.auth ?? 'keys',
        profile: source.profile ?? '',
        verifyTls: source.verifyTls ?? true,
        caBundlePath: source.caBundlePath ?? '',
        proxyUrl: source.proxyUrl ?? ''
      }
    case 'sshFiles':
      // Before agent and password sign-in, every SSH Files Source signed in with a key file.
      return { ...source, auth: source.auth ?? 'keyFile', keyFile: source.keyFile ?? '' }
    case 'dockerLogs':
      // Before ssh:// contexts, a Docker Logs Source had no way of signing in.
      return { ...source, auth: source.auth ?? 'agent', keyFile: source.keyFile ?? '' }
    case 'azureBlob':
      // Before SAS and Azure CLI sign-in, every Azure Blob Storage Source signed in with a connection string.
      return { ...source, auth: source.auth ?? 'connectionString', endpoint: source.endpoint ?? '', caBundlePath: source.caBundlePath ?? '', proxyUrl: source.proxyUrl ?? '' }
    case 'cloudwatchLogs':
      // Before CA bundles and proxies, every CloudWatch Logs Source went straight to its endpoint.
      return { ...source, caBundlePath: source.caBundlePath ?? '', proxyUrl: source.proxyUrl ?? '' }
    case 'systemdJournal':
      // Before hosts over SSH, every systemd Journal Source read this machine's journal.
      return { ...source, host: source.host ?? '', user: source.user ?? '', auth: source.auth ?? 'agent', keyFile: source.keyFile ?? '' }
    case 'kubernetesFiles':
    case 'kubernetesLogs':
      return source
  }
}

/** A Source without its Environment label. */
const unlabelled = <S extends SavedSource>({ environmentId: _, ...source }: S) => source as S

/** Where a Source points and how it gets there: its settings, less its id, name, label and remembered view choices. */
type Target =
  | Pick<LocalSourceInfo, 'type' | 'rootPath' | 'showHidden'>
  | Pick<SshFilesSourceInfo, 'type' | 'host' | 'user' | 'port' | 'path' | 'auth' | 'keyFile'>
  | Omit<S3SourceInfo, 'id' | 'name' | 'environmentId' | 'lastNLines' | 'secretKeySet'>
  | Pick<AzureBlobSourceInfo, 'type' | 'account' | 'container' | 'prefix' | 'endpoint' | 'auth' | 'caBundlePath' | 'proxyUrl'>
  | Pick<KubernetesFilesSourceInfo, 'type' | 'context' | 'namespace' | 'workloadKind' | 'workloadName' | 'path'>
  | Pick<KubernetesLogsSourceInfo, 'type' | 'context' | 'namespace'>
  | Pick<DockerLogsSourceInfo, 'type' | 'context' | 'auth' | 'keyFile'>
  | Omit<CloudWatchLogsSourceInfo, 'id' | 'name' | 'environmentId' | 'lastNLines' | 'secretKeySet'>
  | Pick<SystemdJournalSourceInfo, 'type' | 'target' | 'host' | 'user' | 'port' | 'auth' | 'keyFile'>

type S3Settings = Extract<Target, { type: 's3' }>
type CloudWatchSettings = Extract<Target, { type: 'cloudwatchLogs' }>
type AzureBlobSettings = Extract<Target, { type: 'azureBlob' }>

/** Whether a Source is on AWS, signing in as an S3 Source does. */
const isAwsSource = <S extends { type: SourceTypeId }>(settings: S): settings is Extract<S, { type: 's3' | 'cloudwatchLogs' }> =>
  settings.type === 's3' || settings.type === 'cloudwatchLogs'

/**
 * The name a Source's one secret is stored under, when its settings have a use for one: a Source on AWS's secret key
 * when it signs in with keys, an Azure Blob Storage Source's connection string or SAS, an SSH Files Source's (or a Docker
 * Logs Source's, for an ssh:// host, or a systemd Journal Source's, on a host over SSH) key file passphrase or password.
 */
function secretNameOf(settings: { type: SourceTypeId; auth?: string; target?: string }) {
  if (settings.type === 's3' || settings.type === 'cloudwatchLogs') return (settings.auth ?? defaultAwsAuth(settings.type)) === 'keys' ? 'secretKey' : undefined
  if (settings.type === 'azureBlob') {
    const auth = settings.auth ?? 'connectionString'
    return auth === 'azureCli' ? undefined : auth
  }
  if (settings.type === 'systemdJournal' && settings.target !== 'ssh') return undefined
  if (settings.type !== 'sshFiles' && settings.type !== 'dockerLogs' && settings.type !== 'systemdJournal') return undefined
  const auth = settings.auth ?? (settings.type === 'sshFiles' ? 'keyFile' : 'agent')
  return auth === 'keyFile' ? 'passphrase' : auth === 'password' ? 'password' : undefined
}

const isBlank = (value: string | undefined) => !value?.trim()

/** Whether a Source Type's Sources may sign in over SSH, as SSH Files Sources do, and keep a passphrase or password. */
const signsInOverSsh = <S extends { type: SourceTypeId }>(settings: S): settings is Extract<S, { type: 'sshFiles' | 'dockerLogs' | 'systemdJournal' }> =>
  settings.type === 'sshFiles' || settings.type === 'dockerLogs' || settings.type === 'systemdJournal'

/** An http(s) address as a URL with a scheme (`scheme` unless given), or blank if it's blank; failing with `code` if it's neither. */
function normaliseUrl(input: string, scheme: 'http' | 'https', code: 'INVALID_HOST' | 'INVALID_PROXY') {
  const address = input.trim()
  if (!address) return ''
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `${scheme}://${address}`
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (!parsed?.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new CoreError(code, `Not an http(s) address: ${input}`)
  }
  return url.replace(/\/+$/, '')
}

/** A Kubernetes namespace name: a DNS label, lowercase letters, digits and '-', at most 63 characters. */
const isNamespace = (name: string) => name.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)

/**
 * A folder's absolute path in a container or on a server, without repeated or trailing '/'; failing with `code` if it
 * isn't absolute or climbs with '..'.
 */
function normaliseAbsolutePath(input: string, code: 'INVALID_CONTAINER_PATH' | 'INVALID_PATH') {
  const path = input.trim()
  const segments = path.split('/').filter(Boolean)
  if (!path.startsWith('/') || segments.some((s) => s === '..' || s === '.')) {
    throw new CoreError(code, `Not an absolute path: ${input}`)
  }
  return `/${segments.join('/')}`
}

/** A server to reach over SSH, as a Source's settings name it, and how to sign in to it; blanks are the SSH config's. */
type SshServerSettings = Pick<SshFilesSourceInfo, 'host' | 'user' | 'port' | 'auth' | 'keyFile'>

/**
 * The server a Source reaches over SSH and how it signs in, as its settings name them, checked and trimmed: an SSH Files
 * Source's, or a systemd Journal Source's on a host. `who` is what needs a host, in the failure saying it has none.
 */
function sshServerSettingsOf(input: Partial<SshServerSettings>, defaultAuth: SshAuth, who: string): SshServerSettings {
  const host = input.host?.trim() ?? ''
  if (!host) throw new CoreError('HOST_REQUIRED', `${who} needs a host`)
  const { port } = input
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new CoreError('INVALID_PORT', `Not a port from 1 to 65535: ${String(port)}`)
  }
  const auth = input.auth ?? defaultAuth
  const keyFile = auth === 'keyFile' ? (input.keyFile?.trim() ?? '') : ''
  const user = input.user?.trim() ?? ''
  return { host, user, ...(port !== undefined && { port }), auth, keyFile }
}

/** An SSH Files Source's settings, checked and trimmed. */
function sshTargetOf(input: NewSshFilesSource): Extract<Target, { type: 'sshFiles' }> {
  // Before agent and password sign-in, every SSH Files Source signed in with a key file.
  const server = sshServerSettingsOf(input, 'keyFile', 'An SSH Files Source')
  return { type: 'sshFiles', ...server, path: normaliseAbsolutePath(input.path ?? '', 'INVALID_PATH') }
}

/** Who a Source reaching a server over SSH is, in the failures saying what its settings are missing. */
const sshWho = { sshFiles: 'An SSH Files Source', systemdJournal: 'A systemd Journal Source' } as const

/** The server a Source's settings say it reaches over SSH, and what it is: an SSH Files Source's, or a systemd Journal Source's on a host. */
function sshSettingsOf(target: Target) {
  if (target.type === 'sshFiles' || (target.type === 'systemdJournal' && target.target === 'ssh')) return { server: target, who: sshWho[target.type] }
  return undefined
}

/**
 * The servers a Source reaching `target` over SSH goes through, as ~/.ssh/config routes its host, bastions first and its own
 * server last; each with a user to sign in as, and a key file where it signs in with one. Its own server's user and key
 * file are those in its settings, or else the config's; a bastion's, the config's, or else its own server's. `who` is
 * what needs them, in the failures saying what's missing.
 */
async function sshRouteOf(target: SshServerSettings, who = 'An SSH Files Source') {
  const route = routeTo(await readSshConfig(), { host: target.host, ...(target.user && { user: target.user }), ...(target.port && { port: target.port }) })
  const server = route.at(-1)!
  const user = server.user
  if (!user) throw new CoreError('USER_REQUIRED', `${who} needs a user to sign in as, here or as the User in ~/.ssh/config`)
  // As ssh does, the first IdentityFile that's there; if none is, the first, for the failure to name.
  const configured = (files: string[]) => files.find((file) => existsSync(file)) ?? files[0]
  const keyFile = target.keyFile || configured(server.identityFiles) || ''
  if (target.auth === 'keyFile' && !keyFile) {
    throw new CoreError('KEY_FILE_REQUIRED', `${who} needs a key file to sign in with, here or as the IdentityFile in ~/.ssh/config`)
  }
  return route.map((endpoint) => ({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user ?? user,
    keyFile: endpoint === server ? keyFile : (configured(endpoint.identityFiles) ?? keyFile)
  }))
}

/** A kubeconfig context's name, checked and trimmed. */
function contextOf(input: string | undefined) {
  const context = input?.trim() ?? ''
  if (!context) throw new CoreError('CONTEXT_REQUIRED', 'A Kubernetes Source needs a kubeconfig context')
  return context
}

/** A Workload kind a Kubernetes Files Source can browse, checked. */
function workloadKindOf(kind: FilesWorkloadKind) {
  if (!filesWorkloadKinds.includes(kind)) throw new CoreError('INVALID_WORKLOAD_KIND', `Not a Deployment, StatefulSet or DaemonSet: ${String(kind)}`)
  return kind
}

/** A Kubernetes Source's context and namespace, checked and trimmed. */
function clusterOf(input: { context?: string; namespace?: string }) {
  const context = contextOf(input.context)
  const namespace = input.namespace?.trim() ?? ''
  if (!isNamespace(namespace)) throw new CoreError('INVALID_NAMESPACE', `Not a namespace name: ${namespace}`)
  return { context, namespace }
}

/** Checks the settings specific to a Source's Source Type and returns them normalised. */
function targetOf(input: NewSource): Target {
  if (input.type === 'local') return { type: 'local', rootPath: input.rootPath.trim(), showHidden: input.showHidden ?? true }
  if (input.type === 'kubernetesLogs') return { type: 'kubernetesLogs', ...clusterOf(input) }
  if (input.type === 'dockerLogs') {
    // The agent unless told: it signs in without Polyscope holding a key or password.
    const auth = input.auth ?? 'agent'
    return { type: 'dockerLogs', context: input.context?.trim() || defaultDockerContext, auth, keyFile: auth === 'keyFile' ? (input.keyFile?.trim() ?? '') : '' }
  }
  if (input.type === 'kubernetesFiles') {
    const cluster = clusterOf(input)
    const workloadKind = workloadKindOf(input.workloadKind)
    const workloadName = input.workloadName?.trim() ?? ''
    if (!workloadName) throw new CoreError('WORKLOAD_REQUIRED', 'A Kubernetes Files Source needs a Workload')
    return { type: 'kubernetesFiles', ...cluster, workloadKind, workloadName, path: normaliseAbsolutePath(input.path ?? '', 'INVALID_CONTAINER_PATH') }
  }
  if (input.type === 'sshFiles') return sshTargetOf(input)
  if (input.type === 'azureBlob') return azureBlobTargetOf(input)
  if (input.type === 'cloudwatchLogs') return cloudWatchTargetOf(input)
  if (input.type === 'systemdJournal') {
    // As for Docker's ssh:// contexts, the agent unless told: it signs in without Polyscope holding a key or password.
    if (input.target === 'ssh') return { type: 'systemdJournal', target: 'ssh', ...sshServerSettingsOf(input, 'agent', sshWho.systemdJournal) }
    // This machine has a journal only on Linux.
    if (process.platform !== 'linux') throw new CoreError('NO_JOURNAL', 'Only Linux has a systemd journal, and this machine isn’t running it')
    return { type: 'systemdJournal', target: 'thisMachine', host: '', user: '', auth: 'agent', keyFile: '' }
  }
  const s3: NewS3Source = input
  // Blank for AWS itself; a store is most likely https, a proxy http.
  const host = normaliseUrl(s3.host ?? '', 'https', 'INVALID_HOST')
  const bucket = s3.bucket?.trim() ?? ''
  if (!bucket) throw new CoreError('BUCKET_REQUIRED', 'An S3 Source needs a bucket')
  return {
    type: 's3',
    host,
    bucket,
    prefix: normalisePrefix(s3.prefix),
    region: s3.region?.trim() || 'us-east-1',
    pathStyle: s3.pathStyle ?? false,
    ...awsSignInOf(s3, 'An S3 Source'),
    verifyTls: s3.verifyTls ?? true,
    caBundlePath: s3.caBundlePath?.trim() ?? '',
    proxyUrl: normaliseUrl(s3.proxyUrl ?? '', 'http', 'INVALID_PROXY')
  }
}

/**
 * How a Source on AWS signs in, checked and trimmed: only what the chosen way of signing in uses is kept, so an access
 * key typed before switching to a profile goes. `who` is what needs it, in the failure saying what's missing.
 */
function awsSignInOf(input: NewS3Source | NewCloudWatchLogsSource, who: string) {
  const auth = input.auth ?? defaultAwsAuth(input.type)
  const accessKeyId = auth === 'keys' ? (input.accessKeyId?.trim() ?? '') : ''
  if (auth === 'keys' && !accessKeyId) throw new CoreError('ACCESS_KEY_REQUIRED', `${who} needs an access key`)
  return { auth, accessKeyId, profile: auth === 'profile' ? (input.profile?.trim() ?? '') : '' }
}

/** A CloudWatch Logs Source's settings, checked and trimmed. */
function cloudWatchTargetOf(input: NewCloudWatchLogsSource): CloudWatchSettings {
  const region = input.region?.trim() ?? ''
  if (!region) throw new CoreError('REGION_REQUIRED', 'A CloudWatch Logs Source needs a region')
  return {
    type: 'cloudwatchLogs',
    region,
    // A log group's name may start with '/', and the prefix is only the start of a name, so it's kept as typed.
    prefix: input.prefix?.trim() ?? '',
    ...awsSignInOf(input, 'A CloudWatch Logs Source'),
    endpoint: normaliseUrl(input.endpoint ?? '', 'https', 'INVALID_HOST'),
    caBundlePath: input.caBundlePath?.trim() ?? '',
    proxyUrl: normaliseUrl(input.proxyUrl ?? '', 'http', 'INVALID_PROXY')
  }
}

/** A key prefix as a Source is rooted at it: no leading or trailing '/', blank for everything. */
const normalisePrefix = (prefix: string | undefined) => (prefix ?? '').trim().replace(/^\/+|\/+$/g, '')

/** An Azure Blob Storage Source's settings, checked and trimmed. */
function azureBlobTargetOf(input: NewAzureBlobSource): AzureBlobSettings {
  const account = input.account?.trim() ?? ''
  if (!account) throw new CoreError('ACCOUNT_REQUIRED', 'An Azure Blob Storage Source needs a storage account')
  const container = input.container?.trim() ?? ''
  if (!container) throw new CoreError('CONTAINER_REQUIRED', 'An Azure Blob Storage Source needs a container')
  const auth = input.auth ?? 'connectionString'
  const endpoint = normaliseUrl(input.endpoint ?? '', 'https', 'INVALID_HOST').replace(/\/+$/, '')
  const caBundlePath = input.caBundlePath?.trim() ?? ''
  const proxyUrl = normaliseUrl(input.proxyUrl ?? '', 'http', 'INVALID_PROXY')
  return { type: 'azureBlob', account, container, prefix: normalisePrefix(input.prefix), endpoint, auth, caBundlePath, proxyUrl }
}

/**
 * What an Azure Blob Storage File Source needs to reach its container: the settings, with the connection string or SAS
 * (when signing in with one) checked and filled in.
 */
function azureBlobTargetWith(settings: AzureBlobSettings, secret: string | undefined): AzureBlobTarget {
  const { account, container, prefix, endpoint, proxyUrl } = settings
  const target = (signIn: AzureBlobTarget['signIn']) => ({ account, container, prefix, endpoint, proxyUrl, signIn })
  if (settings.auth === 'azureCli') return target({ azureCli: true })
  if (settings.auth === 'sas') {
    if (secret === undefined) throw new CoreError('SAS_REQUIRED', 'An Azure Blob Storage Source signing in with a SAS needs one')
    checkSas(secret, account, container)
    return target({ sas: secret })
  }
  if (secret === undefined) throw new CoreError('CONNECTION_STRING_REQUIRED', 'An Azure Blob Storage Source needs a connection string')
  checkConnectionString(secret, account)
  return target({ connectionString: secret })
}

/** A Source's CA bundle, read in, as its target holds it: nothing when it names none. */
const caBundleOf = async ({ caBundlePath }: { caBundlePath: string }) => (caBundlePath ? { caBundle: await readCaBundle(caBundlePath) } : {})

/** What an Azure Blob Storage File Source needs to reach its container: azureBlobTargetWith's, with the CA bundle read in. */
async function azureBlobTargetReadIn(settings: AzureBlobSettings, secret: string | undefined): Promise<AzureBlobTarget> {
  return { ...azureBlobTargetWith(settings, secret), ...(await caBundleOf(settings)) }
}

/** What a Source on AWS signs in with: its profile, or its keys, with the secret key filled in. */
function awsCredentialsOf(settings: S3Settings | CloudWatchSettings, secretKey?: string): AwsCredentials {
  if (settings.auth === 'profile') return { profile: settings.profile }
  if (secretKey === undefined) throw new CoreError('SECRET_KEY_REQUIRED', 'No secret key is stored for this Source')
  return { accessKeyId: settings.accessKeyId, secretAccessKey: secretKey }
}

/**
 * What a CloudWatch Logs Log Source needs to reach the region: the settings, with the secret key (when signing in with
 * keys) and CA bundle read in. CloudWatch is always reached over verified TLS, as AWS is.
 */
async function cloudWatchTargetReadIn(settings: CloudWatchSettings, secretKey?: string): Promise<CloudWatchTarget> {
  const { region, prefix, endpoint, proxyUrl } = settings
  const credentials = awsCredentialsOf(settings, secretKey)
  return { region, prefix, endpoint, credentials, verifyTls: true, proxyUrl, ...(await caBundleOf(settings)) }
}

/** What an S3 File Source needs to reach its store: the settings, with the secret key (when signing in with keys) and CA bundle read in. */
async function s3TargetOf(settings: S3Settings, secretKey?: string): Promise<S3Target> {
  const { host, bucket, prefix, region, pathStyle, verifyTls, proxyUrl } = settings
  const credentials = awsCredentialsOf(settings, secretKey)
  return { host, bucket, prefix, region, pathStyle, credentials, verifyTls, proxyUrl, ...(await caBundleOf(settings)) }
}

/** A Log Source's node, and those folded into it, without the status or restarts its Source Type doesn't offer. */
function offered(node: LogNode, capabilities: LogCapabilities): LogNode {
  const shown = { ...node }
  if (!capabilities.status) delete shown.status
  if (shown.kind === 'logStream' && !capabilities.restarts) delete shown.restarts
  if (shown.kind === 'group' && shown.folded) shown.folded = offered(shown.folded, capabilities)
  return shown
}

/**
 * What a host saving copies of files reads them with, saving each where the user chose in a dialog of its own. Left
 * out of the core API the renderer reaches, so the renderer can't have the core write anywhere it likes.
 */
export interface CoreSaves {
  /**
   * Starts saving a copy of a Connected File Source's file, its bytes as stored, to `target`, an absolute path on this
   * computer; how it goes comes as SaveCopyEvents with the returned `saveId`, until cancelSaveCopy or it's done.
   * A file that isn't there fails at once, as does a Local file to be saved over itself (SAVE_OVER_SOURCE).
   * Disconnecting its Source fails it.
   */
  saveCopy(sourceId: string, path: SourcePath, target: string): Promise<SaveCopyStarted>
}

/** What a Connected Source reads from: files, or Log Streams. */
type Backend = { kind: 'files'; fileSource: FileSource } | { kind: 'logs'; logSource: LogSource }

export interface CoreOptions {
  /** Where the registry is saved between launches; without it, nothing outlives the core. */
  dataDir?: string
  /** Where Sources' secrets are kept; defaults to memory only. */
  secrets?: SecretStore
  /** Where Large Files are cached; defaults to a folder in `dataDir`, or else in the OS temp folder. */
  cacheDir?: string
  /** ssh2's pagent.exe, for signing in through Pageant on Windows; only Windows' OpenSSH agent is tried without it. */
  pageantHelper?: string
  /** Opens a Kubernetes Logs Source's Log Source in place of the cluster's, as tests do to stand in a fake one. */
  openLogSource?: (target: Pick<KubernetesLogsSourceInfo, 'context' | 'namespace'>) => Promise<LogSource>
}

/**
 * A file's content, decompressed if it's compressed, if that's no more than `limit` bytes; otherwise at least its
 * first `head` bytes (if it has them), reading and decompressing no more of it than that takes.
 */
async function readUpTo(
  fileSource: FileSource,
  { path, name, size, compression }: { path: SourcePath; name: string; size: number; compression?: Compression },
  limit: number,
  head: number
) {
  if (!compression) {
    const whole = size <= limit
    return { bytes: await fileSource.read(path, { offset: 0, length: whole ? size : Math.min(size, head) }), whole }
  }
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of inflate(chunksOf((range) => fileSource.read(path, range), size), compression, name)) {
    parts.push(chunk)
    length += chunk.length
    if (length > limit) return { bytes: new Uint8Array(Buffer.concat(parts)), whole: false }
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), whole: true }
}

/** Whether two paths on this computer are the same file, through any links; not if either isn't there. */
const sameFile = async (a: string, b: string) => {
  const [realA, realB] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)])
  return realA !== null && realA === realB
}

const inMemory = { encrypt: (plain: string) => Buffer.from(plain), decrypt: (encrypted: Buffer) => encrypted.toString() }

/**
 * What a host showing files in an editor of its own reads them with: an Extension Copy's file provider, for VS
 * Code's editor. Left out of the core API the renderer reaches, as the renderer has an editor of its own.
 */
export interface CoreFiles {
  /** A file or folder of a Connected File Source; a file's size is as stored, before any decompression. */
  statPath(sourceId: string, path: SourcePath): Promise<FileStat>
  /** A file's content, decompressed if it's compressed: OVER_OPEN_ANYWAY_LIMIT if that's over the "open anyway" limit. */
  readFile(sourceId: string, path: SourcePath): Promise<Uint8Array>
  /** Whether a file's content, decompressed if it's compressed, is over the Large File threshold. */
  isLargeFile(sourceId: string, path: SourcePath): Promise<boolean>
  /** Whether a file's content, decompressed if it's compressed, is over the "open anyway" limit, so readFile refuses it. */
  isOverOpenAnywayLimit(sourceId: string, path: SourcePath): Promise<boolean>
}

export type Core = CoreApi & CoreEvents & CoreFiles & CoreSaves

export function createCore(options: CoreOptions = {}): Core {
  const store = options.dataDir ? createRegistryStore(options.dataDir) : null
  const environmentStore = options.dataDir ? createEnvironmentStore(options.dataDir) : null
  const settingsStore = options.dataDir ? createSettingsStore(options.dataDir) : null
  const secrets = options.secrets ?? createSecretStore({ cipher: inMemory })
  const hostKeys = createHostKeyStore(options.dataDir ? { dataDir: options.dataDir } : {})
  // Sources are kept in each group's order; groups interleave freely and are sorted by groupOrder when listed.
  const { sources, groupOrder } = emptyRegistry()
  const environments = defaultEnvironments()
  const loaded =
    store &&
    environmentStore &&
    Promise.all([store.load(), environmentStore.load()]).then(([saved, savedEnvironments]) => {
      environments.splice(0, environments.length, ...savedEnvironments)
      sources.push(...saved.sources.map(withDefaults))
      groupOrder.splice(0, groupOrder.length, ...saved.groupOrder)
    })
  // A failed load is reported to whoever awaits it, not as an unhandled rejection when nobody has yet.
  loaded?.catch(() => undefined)
  let settings: Settings = { ...defaultSettings }
  // Settings that can't be read at all leave the defaults in place rather than keep the app from starting.
  const settingsLoaded = settingsStore?.load().then(
    (saved) => (settings = saved),
    () => undefined
  )
  const settingsListeners = new Set<(settings: Settings) => void>()
  // Updates run one at a time, so each validates against the settings the previous one saved.
  let settingsUpdate: Promise<unknown> = Promise.resolve()

  /**
   * Applies a change and saves what it `touches`; if saving fails, the whole change is undone.
   * Changes replace Sources and Environments rather than alter them, so shallow copies can undo them.
   */
  const commit = async <T>(change: () => T, touches = { registry: true, environments: false }): Promise<T> => {
    const before = { sources: [...sources], groupOrder: [...groupOrder], environments: [...environments] }
    const result = change()
    try {
      // Environments are saved first: a label left pointing at a deleted one is dropped on the next load.
      if (touches.environments) await environmentStore?.save(environments)
      if (touches.registry) await store?.save({ sources, groupOrder })
    } catch (error) {
      sources.splice(0, sources.length, ...before.sources)
      groupOrder.splice(0, groupOrder.length, ...before.groupOrder)
      environments.splice(0, environments.length, ...before.environments)
      throw error
    }
    return result
  }
  // Only Sources that aren't Disconnected have an entry. Each connect attempt puts in a new entry,
  // so an attempt can tell when a disconnect (or a newer attempt) has replaced it.
  type Connected = {
    state: 'connected'
    backend: Backend
    /** Set once what the backend held open dropped (an SSH connection): the next call connects again. */
    dropped?: boolean
    /** Connecting again after the drop, for every call that comes meanwhile to wait on. */
    reconnecting?: Promise<Backend>
  }
  type Connection = Exclude<ConnectionState, { state: 'connected' | 'disconnected' }> | Connected
  const connections = new Map<string, Connection>()
  const connectionListeners = new Set<(event: ConnectionEvent) => void>()
  const announceConnection = (event: ConnectionEvent) => {
    for (const listener of connectionListeners) listener(event)
  }

  const sourceFor = (sourceId: string) => {
    const source = sources.find((s) => s.id === sourceId)
    if (!source) throw new CoreError('SOURCE_NOT_FOUND', `No Source with id ${sourceId}`)
    return source
  }

  const environmentFor = (environmentId: string) => {
    const environment = environments.find((e) => e.id === environmentId)
    if (!environment) throw new CoreError('ENVIRONMENT_NOT_FOUND', `No Environment with id ${environmentId}`)
    return environment
  }

  /** Checks a new or edited Environment and returns it normalised; `editing` is the one it replaces, if any. */
  const validateEnvironment = (input: NewEnvironment, editing?: Environment): Omit<Environment, 'id'> => {
    if (!isRecord(input)) throw new CoreError('INVALID_ENVIRONMENT', `An Environment must be an object, not ${String(input)}`)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new CoreError('ENVIRONMENT_NAME_REQUIRED', 'An Environment needs a name')
    if (!isColor(input.color)) throw new CoreError('INVALID_COLOR', `Not a #rrggbb colour: ${String(input.color)}`)
    const isProtected = input.protected ?? false
    if (typeof isProtected !== 'boolean') throw new CoreError('INVALID_ENVIRONMENT', 'Protected must be true or false')
    const taken = environments.some((e) => e !== editing && byName.compare(e.name, name) === 0)
    if (taken) throw new CoreError('ENVIRONMENT_NAME_TAKEN', `There is already an Environment named ${name}`)
    return { name, color: input.color.toLowerCase(), protected: isProtected }
  }

  /**
   * A copy of a Source to hand out. A label whose Environment is gone (say, its file was unreadable)
   * is left out, but kept in the registry, so putting the Environment back restores it.
   */
  const handOut = async (saved: SavedSource): Promise<SourceInfo> => {
    const source =
      saved.environmentId === undefined || environments.some((e) => e.id === saved.environmentId) ? { ...saved } : unlabelled(saved)
    // Only whether there is a secret: the secret itself stays in the core.
    if (isAwsSource(source)) return { ...source, secretKeySet: (await secrets.get(source.id, 'secretKey')) !== undefined }
    const stored = async (name: string) => secretNameOf(source) === name && (await secrets.get(source.id, name)) !== undefined
    if (source.type === 'azureBlob') return { ...source, connectionStringSet: await stored('connectionString'), sasSet: await stored('sas') }
    if (signsInOverSsh(source)) {
      return { ...source, passphraseSet: await stored('passphrase'), passwordSet: await stored('password') }
    }
    return source
  }

  /** A Connected Source's backend, connected again first if its connection dropped; if that fails, the Source is in Error. */
  const backendFor = async (sourceId: string) => {
    const source = sourceFor(sourceId)
    const connection = connections.get(source.id)
    if (connection?.state !== 'connected') {
      throw new CoreError('SOURCE_DISCONNECTED', `${source.name} is not connected`)
    }
    if (!connection.dropped) return connection.backend
    return (connection.reconnecting ??= reconnect(source, connection))
  }

  /** A Source's backend as long as it's Connected and hasn't dropped: what a Follow starting now goes on using. */
  const liveBackendOf = (sourceId: string) => {
    const connection = connections.get(sourceId)
    return connection?.state === 'connected' && !connection.dropped ? connection.backend : undefined
  }

  /** Whether `error` came of the connection to `backend` dropping, which is since marked dropped or connected again. */
  const droppedUnder = (sourceId: string, backend: Backend, error: unknown) => {
    const connection = connections.get(sourceId)
    return asCoreError(error).code === 'UNREACHABLE' && connection?.state === 'connected' && (connection.dropped || connection.backend !== backend)
  }

  /**
   * Runs `run` with a Connected Source's backend, and once more, connected again, if the connection dropped under it:
   * a call made as it drops goes over it before the drop is noticed. Calls over a connection only read, so are safe to
   * run again.
   */
  const withBackend = async <T>(sourceId: string, run: (backend: Backend) => Promise<T>) => {
    const backend = await backendFor(sourceId)
    try {
      return await run(backend)
    } catch (error) {
      if (!droppedUnder(sourceId, backend, error)) throw error
      return run(await backendFor(sourceId))
    }
  }

  /** `run` with a Connected Source's File Source, as withBackend runs it. */
  const withFileSource = <T>(sourceId: string, path: SourcePath, run: (fileSource: FileSource) => Promise<T>) =>
    withBackend(sourceId, (backend) => {
      if (backend.kind !== 'files') throw new CoreError('NOT_A_FILE', `A Log Source has no files: ${path}`)
      return run(backend.fileSource)
    })

  /** `run` with a Connected Source's Log Source, as withBackend runs it. */
  const withLogSource = <T>(sourceId: string, path: SourcePath, run: (logSource: LogSource) => Promise<T>) =>
    withBackend(sourceId, (backend) => {
      if (backend.kind !== 'logs') throw new CoreError('NOT_A_LOG_STREAM', `A File Source has no Log Streams: ${path}`)
      return run(backend.logSource)
    })

  /**
   * The last lines of a log, as openLog gives them, along with where a Follow carries on from: the
   * timestamp of the last line, and how many lines have it. Those are only known `forFollowing`, which
   * reads the lines with their timestamps whether or not they're shown.
   */
  const readSnapshot = async (logSource: LogSource, sourceId: string, path: SourcePath, options: OpenLogOptions, forFollowing = false) => {
    const asked = options.lastNLines === undefined ? undefined : checkLastNLines(options.lastNLines)
    const timestamps = options.timestamps === true
    const previous = options.previous === true
    const offersPreviousLog = logSource.capabilities.previousLog
    const offersSince = logSource.capabilities.since
    // A Source Type without Previous Logs is never asked for one.
    if (previous && !offersPreviousLog) throw new CoreError('LOG_UNAVAILABLE', `Its Log Streams have no Previous Log: ${path}`)
    const sinceTime = options.since === undefined ? undefined : checkSince(options.since)
    // Nor is one without Since asked to read from a time.
    if (sinceTime !== undefined && !offersSince) throw new CoreError('LOG_UNAVAILABLE', `Its Log Streams can’t be read from a time: ${path}`)
    const { name, hasPreviousLog, unreadable } = await logSource.logStreamAt(path)
    // Not a log still to come: following it would wait for good.
    if (unreadable) throw new CoreError('LOG_UNAVAILABLE', unreadable)
    await settingsLoaded
    const lastNLines = asked ?? sourceFor(sourceId).lastNLines ?? settings.defaultLastNLines
    const read = { timestamps: timestamps || forFollowing, previous, ...(sinceTime !== undefined && { sinceTime }) }
    const snapshot = (lines: string[], earlier?: string): LogSnapshot => ({
      view: 'log',
      of: 'logStream',
      path,
      name,
      offersPreviousLog,
      offersSince,
      previous,
      restarted: offersPreviousLog && hasPreviousLog === true,
      lastNLines,
      timestamps,
      content: lines.join('\n'),
      ...(earlier !== undefined && { earlier })
    })
    let text: string
    let earlier: string | undefined
    try {
      // From a Source Type that can read further back, the read also tells where the lines before these end, back as
      // far as the Since if there is one.
      if (lastNLines !== 'all' && logSource.readLogBack && !previous) ({ text, before: earlier } = await logSource.readLogBack(path, { ...read, tailLines: lastNLines }))
      else if (lastNLines !== 'all') text = await logSource.readLog(path, { ...read, tailLines: lastNLines })
      else if (options.allowLarge) text = await logSource.readLog(path, read)
      else text = await readUpToLarge(logSource, path, read)
    } catch (error) {
      // A container with no log yet, say one waiting to start, can still be followed: its log will come.
      if (!forFollowing || asCoreError(error).code !== 'LOG_UNAVAILABLE') throw error
      return { snapshot: snapshot([]), sinceTime }
    }
    const lines = text ? text.replace(/\n$/, '').split('\n') : []
    const kept = lastNLines === 'all' ? lines : lines.slice(-lastNLines)
    const stamps = read.timestamps ? kept.map(timestampOf) : []
    const lastTimestamp = stamps.at(-1)
    const shown = read.timestamps && !timestamps ? kept.map((line, i) => line.slice(stamps[i]!.length + 1)) : kept
    return {
      snapshot: snapshot(shown, earlier),
      sinceTime,
      ...(lastTimestamp !== undefined && { lastTimestamp, lastTimestampCount: stamps.filter((stamp) => stamp === lastTimestamp).length })
    }
  }

  /** All of a log, failing with LOG_TOO_LARGE if it's over the Large File threshold. */
  const readUpToLarge = async (logSource: LogSource, path: SourcePath, read: LogReadOptions) => {
    // Reading one byte past the threshold is enough to tell, without fetching all of a huge log.
    const threshold = settings.largeFileThreshold
    const text = await logSource.readLog(path, { ...read, limitBytes: threshold + 1 })
    if (Buffer.byteLength(text) > threshold) {
      throw new CoreError('LOG_TOO_LARGE', `The whole log is over the Large File threshold of ${threshold} bytes`)
    }
    return text
  }

  /**
   * A file's last lines, as openFileLog gives them, along with where following them goes on from, the bytes just
   * before there, and the file's identity then. When `forFollowing`, a last line not yet ended is left for the Follow to add once it is.
   */
  const readFileLog = async (fileSource: FileSource, sourceId: string, path: SourcePath, options: FileLogOptions, forFollowing = false) => {
    const asked = options.lastNLines === undefined ? undefined : checkLastNLines(options.lastNLines)
    const info = await fileSource.stat(path)
    if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
    await settingsLoaded
    const lastNLines = asked ?? sourceFor(sourceId).lastNLines ?? settings.defaultLastNLines
    const threshold = settings.largeFileThreshold
    const whole = lastNLines === 'all'
    if (whole && info.size > threshold && !options.allowLarge) {
      throw new CoreError('LOG_TOO_LARGE', `The whole file is over the Large File threshold of ${threshold} bytes`)
    }
    // Lines long enough to take more than the threshold to find are more than a log view should hold anyway.
    const maxBytes = whole ? Infinity : threshold
    const { lines, partial, end, before } = await readLastLines(fileSource, path, { size: info.size, lastNLines, maxBytes })
    const shown = forFollowing || !partial ? lines : [...lines, partial].slice(whole ? 0 : -lastNLines)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const fileLog: FileLog = { view: 'log', of: 'file', path, name, previous: false, lastNLines, timestamps: false, content: shown.join('\n') }
    return { fileLog, end, before, identity: info.identity }
  }

  /** A file of a File Source as readUpTo reads it, once the settings it's read by are loaded. */
  const fileToRead = async (fileSource: FileSource, path: SourcePath) => {
    const info = await fileSource.stat(path)
    if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const { compression } = compressionOf(name)
    await settingsLoaded
    return { path, name, size: info.size, ...(compression && { compression }) }
  }

  /** Whether a file's content is over one of the size settings, telling without reading more than that much of it. */
  const isOver = async (sourceId: string, path: SourcePath, limit: 'largeFileThreshold' | 'openAnywayLimit') => {
    await loaded
    return withFileSource(sourceId, path, async (fileSource) => {
      const file = await fileToRead(fileSource, path)
      const bytes = settings[limit]
      // A compressed file's size says nothing of its content's, so that is decompressed up to the limit to tell.
      if (!file.compression) return file.size > bytes
      return !(await readUpTo(fileSource, file, bytes, 0)).whole
    })
  }

  /** A file of a File Source opened as openFile opens it: in the editor, the Large File Viewer, as binary or as hex. */
  const openWith = async (
    fileSource: FileSource,
    sourceId: string,
    path: SourcePath,
    options: OpenOptions,
    askedEncoding: TextEncoding | undefined
  ): Promise<OpenedFile> => {
    const info = await fileSource.stat(path)
    if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
    const name = path.slice(path.lastIndexOf('/') + 1)
    await settingsLoaded
    const { innerName, compression } = compressionOf(name)
    const common = { path, name, size: info.size, modifiedTime: info.modifiedTime, ...(compression && { compression }) }
    const head = options.hex ? hexDumpLimit : binarySniffLength
    const inEditor = Boolean(options.inEditor) && !options.hex
    // Settings keep the "open anyway" limit no lower than the threshold.
    const limit = inEditor ? settings.openAnywayLimit : settings.largeFileThreshold
    const { bytes, whole } = await readUpTo(fileSource, common, limit, head)
    if (!whole && inEditor) {
      throw new CoreError('OVER_OPEN_ANYWAY_LIMIT', `The file's content is over the "open anyway" limit of ${limit} bytes`)
    }
    if (!whole) return openLarge(sourceFor(sourceId), fileSource, info, common, bytes, options, askedEncoding)
    const encoding = askedEncoding ?? (options.hex ? null : detectEncoding(bytes))
    if (encoding) return { view: 'editor', ...common, content: decode(bytes, encoding), encoding, language: languageFor(innerName) }
    if (!options.hex) return { view: 'binary', ...common, contentLength: bytes.length }
    const shown = bytes.subarray(0, hexDumpLimit)
    return { view: 'hex', ...common, content: hexDump(shown), contentLength: bytes.length, shownLength: shown.length }
  }

  // Follows under way, by id, each with the Source it reads from.
  const follows = new Map<string, { sourceId: string; follow: Follow }>()
  const followListeners = new Set<(event: FollowEvent) => void>()
  const announceFollow = (event: FollowEvent) => {
    for (const listener of followListeners) listener(event)
  }

  /** Starts a Follow of a Source, telling its updates to listeners under a new id, which it returns. */
  const track = (sourceId: string, start: (emit: (update: FollowUpdate) => void) => Follow) => {
    const followId = randomUUID()
    const follow = start((update) => {
      if (update.kind === 'ended') follows.delete(followId)
      announceFollow({ ...update, followId })
    })
    follows.set(followId, { sourceId, follow })
    return followId
  }

  /** Stops every Follow of a Source, telling its listeners why: the connection it used is gone. */
  const stopFollows = (sourceId: string, reason: Extract<FollowEndReason, 'disconnected' | 'connectionLost'>) => {
    for (const [followId, entry] of follows) {
      if (entry.sourceId !== sourceId) continue
      entry.follow.stop()
      follows.delete(followId)
      announceFollow({ followId, kind: 'ended', reason })
    }
  }

  const cache = createLargeFileCache(
    options.cacheDir ?? (options.dataDir ? join(options.dataDir, 'large-file-cache') : join(tmpdir(), 'polyscope-large-file-cache')),
    () => settings.cacheSizeCap
  )
  // Large Files open in viewers, by id, each with the Source it's from.
  const largeFiles = new Map<string, { sourceId: string; large: OpenLargeFile }>()
  const largeFileListeners = new Set<(event: LargeFileEvent) => void>()

  // Searches of Large Files under way, by id, each with the Large File it's of.
  const searches = new Map<string, { largeFileId: string; search: LargeFileSearch }>()
  const searchListeners = new Set<(event: LargeFileSearchEvent) => void>()

  // Copies of files being saved, by id, each with the Source it's of.
  const saves = new Map<string, { sourceId: string; saving: SavingCopy }>()
  const saveListeners = new Set<(event: SaveCopyEvent) => void>()

  const largeFileFor = (largeFileId: string) => {
    const open = largeFiles.get(largeFileId)
    if (!open) throw new CoreError('LARGE_FILE_NOT_OPEN', `No Large File open with id ${largeFileId}`)
    return open.large
  }

  /**
   * Stops what's going on against a Source's connection, as it's gone (disconnected, replaced, or `lost` when it
   * dropped): its Follows, Large Files still caching, and copies of files being saved.
   */
  const stopActivity = (sourceId: string, { lost = false } = {}) => {
    stopFollows(sourceId, lost ? 'connectionLost' : 'disconnected')
    for (const open of largeFiles.values()) {
      if (open.sourceId !== sourceId) continue
      if (lost) open.large.abort('UNREACHABLE', 'The connection to the server dropped while the file was being cached')
      else open.large.abort('SOURCE_DISCONNECTED', 'The Source was disconnected while the file was being cached')
    }
    for (const save of saves.values()) {
      if (save.sourceId !== sourceId) continue
      if (lost) save.saving.abort('UNREACHABLE', 'The connection to the server dropped while the copy was being saved')
      else save.saving.abort('SOURCE_DISCONNECTED', 'The Source was disconnected while the copy was being saved')
    }
  }

  /** What a backend holds open, like an SSH connection, if anything: to close, or to hear it drop. */
  const heldOpen = (backend: Backend) => (backend.kind === 'files' ? backend.fileSource : backend.logSource)

  /** Lets go of what a backend holds open, like an SSH connection. */
  const closeBackend = (backend: Backend) => heldOpen(backend).close?.()

  /** Forgets a Source's connection, stopping its Follows and caching, and closing what it held open. */
  const dropConnection = (sourceId: string) => {
    stopActivity(sourceId)
    const connection = connections.get(sourceId)
    if (connection?.state === 'connected') closeBackend(connection.backend)
    connections.delete(sourceId)
  }

  /** A Source's connection to `backend`, marked dropped, its Follows and caching stopped, if what it holds open drops. */
  const connectedTo = (sourceId: string, backend: Backend): Connected => {
    const connection: Connected = { state: 'connected', backend }
    heldOpen(backend).onDropped?.(() => {
      if (connections.get(sourceId) !== connection) return
      connection.dropped = true
      stopActivity(sourceId, { lost: true })
    })
    return connection
  }

  /** A Source's connection in Error, failing with `failure`. */
  const failedWith = (failure: CoreError): Extract<Connection, { state: 'error' }> => ({
    state: 'error',
    code: failure.code,
    message: failure.message,
    ...(failure.hostKey && { hostKey: failure.hostKey })
  })

  /** The secret a Source signs in with, if it has one: an S3 secret key, or an SSH key file's passphrase or password. */
  const storedSecretOf = async (source: SavedSource) => {
    const secretName = secretNameOf(source)
    return secretName === undefined ? undefined : secrets.get(source.id, secretName)
  }

  /**
   * Connects a Source again once, after its connection dropped: Connected afresh if that works, in Error if not. A
   * disconnect, or a connect, meanwhile wins.
   */
  const reconnect = async (source: SavedSource, dropped: Connected) => {
    closeBackend(dropped.backend)
    const replaced = () => new CoreError('SOURCE_DISCONNECTED', `${source.name} was disconnected or reconnected while connecting again`)
    let opened: Awaited<ReturnType<typeof open>>
    try {
      opened = await open(source, await storedSecretOf(source))
    } catch (error) {
      if (connections.get(source.id) !== dropped) throw replaced()
      const failure = asCoreError(error)
      const failed = failedWith(failure)
      connections.set(source.id, failed)
      announceConnection({ ...failed, sourceId: source.id })
      throw failure
    }
    if (connections.get(source.id) !== dropped) {
      closeBackend(opened.backend)
      throw replaced()
    }
    connections.set(source.id, connectedTo(source.id, opened.backend))
    return opened.backend
  }

  /** Where a file's content, as it is now, is cached: the same file of a Source pointing the same place, unchanged since. */
  const cacheKeyOf = (source: SavedSource, path: SourcePath, info: Extract<FileStat, { kind: 'file' }>) =>
    createHash('sha256')
      .update(JSON.stringify([target({ ...source, id: '' }), path, info.size, info.modifiedTime, info.identity ?? null]))
      .digest('hex')

  /**
   * Opens a file whose content is over the Large File threshold, of which `head` is the start: in the Large File
   * Viewer, straight away at its end (unless it's compressed), caching it in the background. One that looks
   * binary is shown as binary, and as hex only its start.
   */
  const openLarge = async (
    source: SavedSource,
    fileSource: FileSource,
    info: Extract<FileStat, { kind: 'file' }>,
    common: Omit<LargeFile, 'view' | 'largeFileId' | 'encoding' | 'lastLines'>,
    head: Uint8Array,
    options: OpenOptions,
    askedEncoding?: TextEncoding
  ): Promise<OpenedFile> => {
    const { path, compression } = common
    const contentLength = compression ? {} : { contentLength: info.size }
    if (options.hex && !askedEncoding) {
      const shown = head.subarray(0, hexDumpLimit)
      return { view: 'hex', ...common, content: hexDump(shown), ...contentLength, shownLength: shown.length }
    }
    if (askedEncoding && askedEncoding !== 'utf-8' && askedEncoding !== 'latin1') {
      throw new CoreError('INVALID_ENCODING', `A Large File can only be shown as UTF-8 or Latin-1, not ${askedEncoding}`)
    }
    const last = compression ? new Uint8Array(0) : await readLastLinesBytes(fileSource, path, info.size)
    const encoding = askedEncoding ?? detectLargeFileEncoding(head.subarray(0, binarySniffLength), last)
    if (!encoding) return { view: 'binary', ...common, ...contentLength }
    const largeFileId = randomUUID()
    const large = openLargeFile({
      fileSource,
      path,
      size: info.size,
      ...(compression && { compression }),
      encoding,
      inPlace: source.type === 'local' && !compression,
      cache,
      cacheKey: cacheKeyOf(source, path, info),
      onStatus: (status) => {
        const event = { ...status, largeFileId }
        for (const listener of largeFileListeners) listener(event)
      }
    })
    largeFiles.set(largeFileId, { sourceId: source.id, large })
    return { view: 'large', ...common, largeFileId, encoding, lastLines: lastLinesOf(last, encoding) }
  }

  /**
   * A page of a folder's children, folders first, then files, each by name; a more node ends it if there are more.
   * A folder with a child folded into it lists that child's children, after a folded node for it; an error node
   * for the folder says why when they can't be listed.
   */
  const listNodes = async (fileSource: FileSource, path: SourcePath, cursor?: string): Promise<TreeNode[]> => {
    const folded = await fileSource.foldedChild?.(path)
    if (!folded) return listEntries(fileSource, path, path, cursor)
    const at = joinPath(path, folded.name)
    const foldedNode: FoldedNode = { kind: 'folded', name: folded.name, path: at, ...(folded.kubernetes && { kubernetes: folded.kubernetes }) }
    try {
      return [foldedNode, ...(await listEntries(fileSource, at, path, cursor))]
    } catch (error) {
      const { code, message } = asCoreError(error)
      return [foldedNode, { kind: 'error', path, code, message }]
    }
  }

  /** A page of the children of `path`, shown as the children of `shownAt` (a folder it's folded into, or itself). */
  const listEntries = async (fileSource: FileSource, path: SourcePath, shownAt: SourcePath, cursor?: string): Promise<TreeNode[]> => {
    const page = await fileSource.listChildren(path, cursor)
    const nodes = page.entries
      .map(
        (e): EntryNode => ({
          kind: e.kind,
          name: e.name,
          path: joinPath(path, e.name),
          icon: e.kind === 'folder' ? folderIcon(e.name) : fileIcon(e.name),
          // A folder's size says nothing useful about what's in it, so only files show one.
          ...(e.kind === 'file' && e.size !== undefined && { size: e.size }),
          ...(e.modifiedTime !== undefined && { modifiedTime: e.modifiedTime }),
          ...(e.problem && { problem: e.problem }),
          ...(e.kubernetes && { kubernetes: e.kubernetes })
        })
      )
      .sort((a, b) => (a.kind === b.kind ? byName.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    return page.cursor === undefined ? nodes : [...nodes, { kind: 'more', path: shownAt, cursor: page.cursor }]
  }

  /**
   * A Log Source node's children, showing only what its Source Type offers: Log Streams alone in the Source's order
   * (a pod's containers), Kubernetes' groups of Workloads in the order of their kind, the rest by name.
   */
  const listLogNodes = async (logSource: LogSource, path: SourcePath, cursor?: string): Promise<TreeNode[]> => {
    const page = logSource.listPage ? await logSource.listPage(path, cursor) : { nodes: await logSource.listChildren(path) }
    const more: TreeNode[] = page.cursor === undefined ? [] : [{ kind: 'more', path, cursor: page.cursor }]
    const nodes = page.nodes.map((node) => offered(node, logSource.capabilities))
    if (nodes.every((node) => node.kind === 'logStream')) return [...nodes, ...more]
    // Kubernetes' groups of Workloads in their kinds' order; Docker's Standalone group after the Compose projects.
    const rank = (node: LogNode) =>
      node.kubernetes?.kind === 'workloads' ? workloadKinds.indexOf(node.kubernetes.workloadKind)
      : node.docker?.kind === 'standalone' ? 1
      : 0
    return [...nodes.toSorted((a, b) => rank(a) - rank(b) || byName.compare(a.name, b.name)), ...more]
  }

  /** Lists a node's children in whichever kind of Source it is. */
  const listBackend = (backend: Backend, path: SourcePath, cursor?: string) =>
    backend.kind === 'files' ? listNodes(backend.fileSource, path, cursor) : listLogNodes(backend.logSource, path, cursor)

  /** Opens a Local File Source at its root folder, once it's clear the folder is there. */
  const reachLocal = async ({ rootPath, showHidden }: Extract<Target, { type: 'local' }>) => {
    const fileSource = createLocalFileSource(rootPath, { showHidden })
    const root = await fileSource.stat('').catch((error: unknown) => {
      // Anything else, like a share that can't be reached or isn't allowed, is reported as itself.
      if (error instanceof CoreError && (error.code === 'NOT_FOUND' || error.code === 'NOT_A_FOLDER')) return null
      throw error
    })
    if (!root) throw new CoreError('ROOT_NOT_FOUND', `Root path does not exist: ${rootPath}`)
    if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `Root path is not a folder: ${rootPath}`)
    return fileSource
  }

  /**
   * How an SSH Files Source signs in to each server on its route, its own and any bastions alike: through the one
   * agent, with the one password, or with each server's key file. `secret` is the key file's passphrase, or the password.
   */
  const sshSignInsOf = async (auth: SshAuth, keyFiles: string[], secret?: string): Promise<SshSignIn[]> => {
    if (auth === 'agent') {
      const agent = await findSshAgent(options.pageantHelper ? { pageantHelper: options.pageantHelper } : {})
      return keyFiles.map(() => ({ agent }))
    }
    if (auth === 'password') {
      if (secret === undefined) throw new CoreError('PASSWORD_REQUIRED', 'Enter the password to sign in with')
      return keyFiles.map(() => ({ password: secret }))
    }
    return Promise.all(
      keyFiles.map(async (keyFile) => {
        const privateKey = await readFile(keyFile).catch((error: Error) => {
          throw new CoreError('KEY_FILE_UNREADABLE', `Couldn't read the key file ${keyFile}: ${error.message}`)
        })
        return { privateKey, ...(secret !== undefined && { passphrase: secret }) }
      })
    )
  }

  /**
   * Connects to a server over SSH, through any bastions ~/.ssh/config routes it through, each one's host key checked,
   * and signs in (with `secret`, the key file's passphrase or the password, if there is one). `who` is what's connecting.
   */
  const signInOverSsh = async (target: SshServerSettings, secret: string | undefined, who?: string) => {
    const route = await sshRouteOf(target, who)
    const signIns = await sshSignInsOf(target.auth, route.map((endpoint) => endpoint.keyFile), secret)
    // Every server's host key is checked, bastions' too.
    const hops = await Promise.all(
      route.map(async ({ host, port, user }, index) => ({
        target: { host, port, user, ...signIns[index]! },
        options: { checkHostKey: (key: PresentedHostKey) => hostKeys.check(host, port, key), preferredHostKeyTypes: await hostKeys.knownTypes(host, port) }
      }))
    )
    const server = hops.pop()!
    return connectSsh(server.target, server.options, hops)
  }

  /** Signs in to an SSH Files Source's server, and opens its folder, once it's clear the folder is there. */
  const reachSsh = async (target: Extract<Target, { type: 'sshFiles' }>, secret?: string) => {
    const { host, path } = target
    const connection = await signInOverSsh(target, secret)
    const fileSource = createSshFileSource(connection, path)
    try {
      const root = await fileSource.stat('').catch((error: unknown) => {
        if (error instanceof CoreError && error.code === 'NOT_FOUND') throw new CoreError('ROOT_NOT_FOUND', `${path} doesn't exist on ${host}`)
        throw error
      })
      if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `${path} on ${host} is not a folder`)
    } catch (error) {
      fileSource.close()
      throw error
    }
    return fileSource
  }

  /** Opens a Kubernetes Files Source's Workload, once it's clear the context, namespace and Workload are there. */
  const reachKubernetesFiles = async ({ context, type: _, ...target }: Extract<Target, { type: 'kubernetesFiles' }>) => {
    const fileSource = createKubernetesFileSource(kubeConfigFor(context), target)
    await fileSource.check()
    return fileSource
  }

  /** Opens a Kubernetes Logs Source's namespace, once it's clear the context and namespace are there. */
  const reachKubernetes = async ({ context, namespace }: Extract<Target, { type: 'kubernetesLogs' }>) => {
    if (options.openLogSource) return options.openLogSource({ context, namespace })
    const logSource = createKubernetesLogSource(kubeConfigFor(context), namespace)
    await logSource.checkNamespace()
    return logSource
  }

  /**
   * Opens a Docker Logs Source's engine, once it has answered: its Log Source, and what the engine says it is. An
   * `ssh://` context's is reached over an SSH connection to its host, signed in as an SSH Files Source signs in (with
   * `secret`, if it has one), which the Log Source holds open.
   */
  const reachDocker = async ({ context, auth, keyFile }: Extract<Target, { type: 'dockerLogs' }>, secret?: string) => {
    const endpoint = await dockerEndpointOf(context)
    if (!('ssh' in endpoint)) return connectDockerEngine(endpoint)
    const { host, user = '', port } = endpoint.ssh
    const connection = await signInOverSsh({ host, user, ...(port && { port }), auth, keyFile }, secret, `The ssh:// Docker context ${context}`)
    try {
      const { logSource, version } = await connectDockerEngine(endpoint, dialerOver(connection, host))
      const held: LogSource = { ...logSource, close: () => connection.close(), onDropped: (listener) => connection.onDrop(listener) }
      return { logSource: held, version }
    } catch (error) {
      connection.close()
      throw error
    }
  }

  /**
   * Opens a systemd Journal Source's journal: this machine's, or a host's over SSH, signed in as an SSH Files Source signs
   * in (with `secret`, if it has one), its commands run over the one connection the Log Source holds open.
   */
  const reachJournal = async (target: Extract<Target, { type: 'systemdJournal' }>, secret?: string): Promise<LogSource> => {
    if (target.target === 'thisMachine') return createJournalLogSource(thisMachine)
    const connection = await signInOverSsh(target, secret, sshWho.systemdJournal)
    const logSource = createJournalLogSource(journalHostOver(connection, target.host))
    return { ...logSource, close: () => connection.close(), onDropped: (listener) => connection.onDrop(listener) }
  }

  /**
   * Opens a Source's File or Log Source and lists its root: what connecting, or testing a connection, has to get through.
   * An S3 Source signing in with keys needs its `secret` key, and an Azure Blob Storage Source its connection string or SAS, as
   * an SSH Files Source with an encrypted key file needs its passphrase; S3 and Azure Blob Storage Sources prove they can
   * sign in by listing.
   */
  const open = async (target: Target, secret?: string) => {
    let backend: Backend
    let serverVersion: string | undefined
    if (target.type === 'local') backend = { kind: 'files', fileSource: await reachLocal(target) }
    else if (target.type === 'sshFiles') backend = { kind: 'files', fileSource: await reachSsh(target, secret) }
    else if (target.type === 's3') backend = { kind: 'files', fileSource: createS3FileSource(await s3TargetOf(target, secret)) }
    else if (target.type === 'azureBlob') backend = { kind: 'files', fileSource: createAzureBlobFileSource(await azureBlobTargetReadIn(target, secret)) }
    else if (target.type === 'kubernetesFiles') backend = { kind: 'files', fileSource: await reachKubernetesFiles(target) }
    else if (target.type === 'dockerLogs') {
      const engine = await reachDocker(target, secret)
      backend = { kind: 'logs', logSource: engine.logSource }
      serverVersion = engine.version
    } else if (target.type === 'cloudwatchLogs') backend = { kind: 'logs', logSource: createCloudWatchLogSource(await cloudWatchTargetReadIn(target, secret)) }
    else if (target.type === 'systemdJournal') backend = { kind: 'logs', logSource: await reachJournal(target, secret) }
    else backend = { kind: 'logs', logSource: await reachKubernetes(target) }
    try {
      return { backend, nodes: await listBackend(backend, ''), ...(serverVersion !== undefined && { serverVersion }) }
    } catch (error) {
      closeBackend(backend)
      throw error
    }
  }

  /**
   * The secret typed in `input`, if its settings have a use for one, or else the one stored for `sourceId`; undefined
   * if there's neither.
   */
  const secretFor = async (input: NewSource, sourceId?: string) => {
    const name = secretNameOf(input)
    if (name === undefined) return undefined
    const typed =
      isAwsSource(input)
        ? input.secretAccessKey
        : input.type === 'azureBlob'
          ? name === 'sas'
            ? input.sas
            : input.connectionString
          : signsInOverSsh(input)
          ? name === 'password'
            ? input.password
            : input.passphrase
          : undefined
    if (!isBlank(typed)) return typed
    return sourceId === undefined ? undefined : secrets.get(sourceId, name)
  }

  /**
   * Checks new or edited settings and returns them normalised, without an id, along with a secret typed in
   * them. `editing` is the id of the Source they replace, whose stored secret can stay.
   */
  const validate = async (input: NewSource, editing?: string): Promise<{ saved: Omit<SavedSource, 'id'>; secret?: string }> => {
    const name = input.name.trim()
    if (!name) throw new CoreError('NAME_REQUIRED', 'A Source needs a name')
    const { environmentId } = input
    if (environmentId !== undefined) environmentFor(environmentId)
    const label = environmentId !== undefined && { environmentId }
    const target = targetOf(input)
    if (target.type === 'local') {
      await reachLocal(target)
      return { saved: { ...target, name, ...label } }
    }
    // Nor is a cluster or an engine: it may be away, or its context not in the kubeconfig yet. This machine's journal holds no secret.
    if (target.type === 'kubernetesLogs' || target.type === 'kubernetesFiles' || (target.type === 'systemdJournal' && target.target === 'thisMachine')) {
      return { saved: { ...target, name, ...label } }
    }
    // A Source on AWS, an SSH Files, a Docker Logs or a systemd Journal Source isn't reached until it's connected: it may be
    // saved while its server, its engine's ssh:// host, or its host, is away.
    const typed = await secretFor(input)
    if (isAwsSource(target) && target.auth === 'keys' && typed === undefined && (await secretFor(input, editing)) === undefined) {
      throw new CoreError('SECRET_KEY_REQUIRED', `${target.type === 's3' ? 'An S3' : 'A CloudWatch Logs'} Source needs a secret key`)
    }
    if (target.type === 'azureBlob' && target.auth !== 'azureCli') {
      // Without connecting: one for another account (or a SAS URL for another container) is refused, whether typed now
      // or stored and the account changed.
      azureBlobTargetWith(target, typed ?? (await secretFor(input, editing)))
    }
    const overSsh = sshSettingsOf(target)
    if (overSsh) {
      await sshRouteOf(overSsh.server, overSsh.who).catch((error: unknown) => {
        // A host needing what Polyscope doesn't support may not by the time it's connected: the config may change.
        if (!(error instanceof CoreError && error.code === 'UNSUPPORTED_SSH_OPTION')) throw error
      })
    }
    if (overSsh?.server.auth === 'password' && typed === undefined && (await secretFor(input, editing)) === undefined) {
      throw new CoreError('PASSWORD_REQUIRED', `${overSsh.who} signing in with a password needs one`)
    }
    return { saved: { ...target, name, ...label }, ...(typed !== undefined && { secret: typed }) }
  }

  /**
   * The server a Source reaches over SSH, if it does, where ~/.ssh/config puts it: an alias and the host name it stands
   * for are one server. An SSH Files Source's, a systemd Journal Source's on a host, or the host of a Docker Logs Source's
   * `ssh://` context; none for one whose context the Docker CLI no longer has.
   */
  const sshServerOf = async (source: SavedSource, config: Awaited<ReturnType<typeof readSshConfig>>) => {
    let named: { host: string; port?: number }
    const overSsh = sshSettingsOf(source)
    if (overSsh) named = overSsh.server
    else if (source.type === 'dockerLogs') {
      const endpoint = await dockerEndpointOf(source.context).catch(() => undefined)
      if (!endpoint || !('ssh' in endpoint)) return undefined
      named = endpoint.ssh
    } else return undefined
    const resolved = config.resolve(named.host)
    return { host: resolved.hostName, port: named.port ?? resolved.port ?? 22 }
  }

  /** Every setting but the name, label and remembered view choices, in a form that compares equal whatever order the keys were saved in. */
  const target = ({ name: _, environmentId: __, lastNLines: ___, ...settings }: SavedSource) =>
    JSON.stringify(Object.entries(settings).sort())
  const sameTarget = (a: SavedSource, b: SavedSource) => target(a) === target(b)

  const copyName = (name: string) => {
    const taken = new Set(sources.map((s) => s.name))
    let candidate = `${name} copy`
    for (let n = 2; taken.has(candidate); n++) candidate = `${name} copy ${n}`
    return candidate
  }

  const checkIndex = (index: number, length: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new CoreError('INVALID_ORDER', `Position ${index} is outside 0–${length - 1}`)
    }
  }

  const joinPath = (parent: SourcePath, name: string) => (parent ? `${parent}/${name}` : name)

  return {
    async listSources() {
      await loaded
      const rank = (s: SavedSource) => groupOrder.indexOf(s.type)
      return Promise.all(sources.toSorted((a, b) => rank(a) - rank(b)).map(handOut))
    },

    async addSource(input) {
      await loaded
      const { saved, secret } = await validate(input)
      const source = { id: randomUUID(), ...saved } as SavedSource
      const secretName = secretNameOf(source)
      if (secret !== undefined && secretName !== undefined) await secrets.set(source.id, secretName, secret)
      try {
        await commit(() => sources.push(source))
      } catch (error) {
        await secrets.remove(source.id)
        throw error
      }
      return handOut(source)
    },

    async editSource(sourceId, input) {
      await loaded
      sourceFor(sourceId) // an unknown Source is reported before any invalid settings
      const { saved, secret } = await validate(input, sourceId)
      const before = sourceFor(sourceId)
      // What the user picked in its log views isn't among the settings edited, so it stays.
      const remembered = before.lastNLines !== undefined && { lastNLines: before.lastNLines }
      const source = { id: sourceId, ...saved, ...remembered } as SavedSource
      const secretName = secretNameOf(source)
      const written = secret !== undefined ? secretName : undefined
      const previous = written === undefined ? undefined : await secrets.get(sourceId, written)
      if (written !== undefined) await secrets.set(sourceId, written, secret!)
      try {
        await commit(() => (sources[sources.indexOf(before)] = source))
      } catch (error) {
        // A Source has one secret at most, so forgetting its secrets forgets just the one written here.
        if (written !== undefined && previous !== undefined) await secrets.set(sourceId, written, previous)
        else if (written !== undefined) await secrets.remove(sourceId)
        throw error
      }
      // A Source with no use for the secret it had (say, signing in another way now) forgets it; one just typed stays.
      if (secretName !== secretNameOf(before)) {
        await secrets.remove(sourceId)
        if (written !== undefined) await secrets.set(sourceId, written, secret!)
      }
      // A new name keeps the connection; anything else, a new secret included, needs connecting afresh.
      if (!sameTarget(before, source) || written !== undefined) dropConnection(sourceId)
      return handOut(source)
    },

    async duplicateSource(sourceId) {
      await loaded
      const id = randomUUID()
      await secrets.copy(sourceFor(sourceId).id, id)
      try {
        // Looked up again: the registry may have changed while the secrets were copied.
        const original = sourceFor(sourceId)
        const copy: SavedSource = { ...original, id, name: copyName(original.name) }
        await commit(() => sources.splice(sources.indexOf(original) + 1, 0, copy))
        return handOut(copy)
      } catch (error) {
        await secrets.remove(id)
        throw error
      }
    },

    async deleteSource(sourceId) {
      await loaded
      const source = sourceFor(sourceId)
      // Secrets go first: if that fails the Source is still there to delete again.
      await secrets.remove(sourceId)
      // As do the host keys trusted in Polyscope for its server, unless another Source reaches the same server: at worst,
      // a Source that fails to delete has its server's key offered to trust again.
      const config = await readSshConfig()
      const server = await sshServerOf(source, config)
      if (server) {
        const others = await Promise.all(sources.filter((s) => s !== source).map((s) => sshServerOf(s, config)))
        const onSameServer = (other: { host: string; port: number } | undefined) =>
          other?.host.toLowerCase() === server.host.toLowerCase() && other.port === server.port
        if (!others.some(onSameServer)) await hostKeys.forget(server.host, server.port)
      }
      await commit(() => sources.splice(sources.indexOf(sourceFor(sourceId)), 1))
      dropConnection(sourceId)
    },

    async moveSource(sourceId, index) {
      await loaded
      const source = sourceFor(sourceId)
      const siblings = sources.filter((s) => s.type === source.type && s !== source)
      checkIndex(index, siblings.length + 1)
      await commit(() => {
        sources.splice(sources.indexOf(source), 1)
        const anchor = siblings[index] ?? siblings.at(-1)
        const at = !anchor ? sources.length : sources.indexOf(anchor) + (index === siblings.length ? 1 : 0)
        sources.splice(at, 0, source)
      })
    },

    async moveSourceGroup(type, index) {
      await loaded
      const shown = groupOrder.filter((t) => sources.some((s) => s.type === t))
      if (!shown.includes(type)) throw new CoreError('INVALID_ORDER', `No Sources of type ${type} to move`)
      checkIndex(index, shown.length)
      const reordered: SourceTypeId[] = shown.filter((t) => t !== type)
      reordered.splice(index, 0, type)
      // Groups without Sources aren't shown, so they simply follow the ones that are.
      const hidden = groupOrder.filter((t) => !shown.includes(t))
      await commit(() => groupOrder.splice(0, groupOrder.length, ...reordered, ...hidden))
    },

    async listEnvironments() {
      await loaded
      return environments.map((e) => ({ ...e }))
    },

    async addEnvironment(input) {
      await loaded
      const environment: Environment = { id: randomUUID(), ...validateEnvironment(input) }
      await commit(() => environments.push(environment), { registry: false, environments: true })
      return { ...environment }
    },

    async editEnvironment(environmentId, input) {
      await loaded
      const before = environmentFor(environmentId)
      const environment: Environment = { id: environmentId, ...validateEnvironment(input, before) }
      await commit(() => (environments[environments.indexOf(before)] = environment), { registry: false, environments: true })
      return { ...environment }
    },

    async deleteEnvironment(environmentId) {
      await loaded
      const environment = environmentFor(environmentId)
      const hasLabelledSources = sources.some((s) => s.environmentId === environmentId)
      await commit(
        () => {
          environments.splice(environments.indexOf(environment), 1)
          sources.forEach((s, i) => s.environmentId === environmentId && (sources[i] = unlabelled(s)))
        },
        { registry: hasLabelledSources, environments: true }
      )
    },

    async connectionState(sourceId) {
      await loaded
      sourceFor(sourceId)
      const connection = connections.get(sourceId) ?? { state: 'disconnected' }
      return connection.state === 'error' ? { ...connection } : { state: connection.state }
    },

    async connect(sourceId) {
      await loaded
      const source = sourceFor(sourceId)
      const attempt: Connection = { state: 'connecting' }
      // Connecting again replaces the connection the Source's Follows and caching were using.
      dropConnection(sourceId)
      connections.set(sourceId, attempt)
      const settle = (outcome: Connection) => {
        if (connections.get(sourceId) !== attempt) {
          throw new CoreError('SOURCE_DISCONNECTED', `${source.name} was disconnected or reconnected while connecting`)
        }
        connections.set(sourceId, outcome)
      }
      let opened: Awaited<ReturnType<typeof open>>
      try {
        opened = await open(source, await storedSecretOf(source))
      } catch (error) {
        const failure = asCoreError(error)
        settle(failedWith(failure))
        throw failure
      }
      try {
        settle(connectedTo(sourceId, opened.backend))
      } catch (error) {
        // Disconnected while connecting: nothing will use what was opened.
        closeBackend(opened.backend)
        throw error
      }
      return opened.nodes
    },

    async testConnection(input, sourceId) {
      await loaded
      const { backend, serverVersion } = await open(targetOf(input), await secretFor(input, sourceId))
      closeBackend(backend)
      return serverVersion === undefined ? {} : { serverVersion }
    },

    async disconnect(sourceId) {
      await loaded
      sourceFor(sourceId)
      dropConnection(sourceId)
    },

    trustHostKey: (hostKey) => hostKeys.trust(hostKey),

    async expand(sourceId, path, cursor) {
      await loaded
      return withBackend(sourceId, async (backend) => {
        try {
          return await listBackend(backend, path, cursor)
        } catch (error) {
          if (droppedUnder(sourceId, backend, error)) throw error
          const { code, message } = asCoreError(error)
          return [{ kind: 'error', path, code, message }]
        }
      })
    },

    async openFile(sourceId, path, options = {}) {
      await loaded
      const askedEncoding = options.encoding === undefined ? undefined : checkEncoding(options.encoding)
      return withFileSource(sourceId, path, (fileSource) => openWith(fileSource, sourceId, path, options, askedEncoding))
    },

    async statPath(sourceId, path) {
      await loaded
      return withFileSource(sourceId, path, (fileSource) => fileSource.stat(path))
    },

    async readFile(sourceId, path) {
      await loaded
      return withFileSource(sourceId, path, async (fileSource) => {
        const file = await fileToRead(fileSource, path)
        const limit = settings.openAnywayLimit
        const { bytes, whole } = await readUpTo(fileSource, file, limit, 0)
        if (!whole) throw new CoreError('OVER_OPEN_ANYWAY_LIMIT', `The file's content is over the "open anyway" limit of ${limit} bytes`)
        return bytes
      })
    },

    isLargeFile: (sourceId, path) => isOver(sourceId, path, 'largeFileThreshold'),

    isOverOpenAnywayLimit: (sourceId, path) => isOver(sourceId, path, 'openAnywayLimit'),

    async largeFileStatus(largeFileId) {
      return { ...largeFileFor(largeFileId).status() }
    },

    async readLargeFileLines(largeFileId, firstLine, count) {
      return largeFileFor(largeFileId).readLines(firstLine, count)
    },

    async searchLargeFile(largeFileId, query) {
      const large = largeFileFor(largeFileId)
      const regex = isRecord(query) && typeof query.pattern === 'string' ? searchRegExp({ pattern: query.pattern, matchCase: query.matchCase === true }) : { problem: 'Not a search' }
      if (!(regex instanceof RegExp)) throw new CoreError('INVALID_PATTERN', regex.problem)
      const searchId = randomUUID()
      const search = searchLargeFile(large.content(), regex, (update) => {
        if (update.kind !== 'progress') searches.delete(searchId)
        const event = { ...update, searchId }
        for (const listener of searchListeners) listener(event)
      })
      searches.set(searchId, { largeFileId, search })
      return { searchId }
    },

    async cancelLargeFileSearch(searchId) {
      searches.get(searchId)?.search.cancel()
      searches.delete(searchId)
    },

    async closeLargeFile(largeFileId) {
      largeFiles.get(largeFileId)?.large.close()
      largeFiles.delete(largeFileId)
      for (const [searchId, entry] of searches) {
        if (entry.largeFileId !== largeFileId) continue
        entry.search.cancel()
        searches.delete(searchId)
      }
    },

    async saveCopy(sourceId, path, target) {
      await loaded
      if (typeof target !== 'string' || !isAbsolute(target)) throw new CoreError('INVALID_PATH', `Not an absolute path to save to: ${String(target)}`)
      const source = sourceFor(sourceId)
      return withFileSource(sourceId, path, async (fileSource) => {
        await fileToRead(fileSource, path)
        if (source.type === 'local' && (await sameFile(join(source.rootPath, path), target))) {
          throw new CoreError('SAVE_OVER_SOURCE', `A copy can’t be saved over the file itself: ${target}`)
        }
        const saveId = randomUUID()
        const saving = startSaveCopy({
          fileSource,
          path,
          target,
          onStatus: (status) => {
            if (status.state !== 'saving') saves.delete(saveId)
            const event = { ...status, saveId }
            for (const listener of saveListeners) listener(event)
          }
        })
        saves.set(saveId, { sourceId, saving })
        return { saveId, target }
      })
    },

    async cancelSaveCopy(saveId) {
      saves.get(saveId)?.saving.cancel()
    },

    async openLog(sourceId, path, options = {}) {
      await loaded
      return withLogSource(sourceId, path, async (logSource) => (await readSnapshot(logSource, sourceId, path, options)).snapshot)
    },

    async readEarlierLog(sourceId, path, { earlier, lines, timestamps = false }) {
      await loaded
      const tailLines = checkLastNLines(lines)
      if (tailLines === 'all') throw new CoreError('INVALID_LINE_COUNT', 'Lines read further back come a number at a time, not all at once')
      const { text, before } = await withLogSource(sourceId, path, (logSource) => {
        if (!logSource.readLogBack) throw new CoreError('LOG_UNAVAILABLE', `Its Source Type can’t read further back: ${path}`)
        return logSource.readLogBack(path, { tailLines, before: earlier, timestamps })
      })
      return { content: text.replace(/\n$/, ''), ...(before !== undefined && { earlier: before }) }
    },

    async followLog(sourceId, path, options = {}) {
      await loaded
      const { logSource, restarts, read } = await withLogSource(sourceId, path, async (logSource) => {
        if (options.previous) throw new CoreError('NOT_FOLLOWABLE', `A Previous Log has ended: ${path}`)
        // The snapshot has to be of the run the Follow starts from: one read while the Log Stream restarted is read again.
        const currentRun = currentRunOf(logSource)
        const restartsNow = async () => (currentRun ? (await currentRun(path)).restarts : 0)
        let restarts = await restartsNow()
        let read: Awaited<ReturnType<typeof readSnapshot>>
        for (let tries = 1; ; tries++) {
          read = await readSnapshot(logSource, sourceId, path, options, true)
          const after = await restartsNow()
          if (after === restarts || tries === 3) break
          restarts = after
        }
        return { logSource, restarts, read }
      })
      const { snapshot, lastTimestamp, lastTimestampCount, sinceTime } = read
      // With no lines since its Since yet, it goes on from the Since, none of whose lines were shown.
      const after = lastTimestamp !== undefined ? { after: lastTimestamp, afterCount: lastTimestampCount } : sinceTime !== undefined ? { after: sinceTime, afterCount: 0 } : {}
      // Disconnected or reconnected while reading: this Follow would outlive the connection it was for.
      const live = liveBackendOf(sourceId)
      if (live?.kind !== 'logs' || live.logSource !== logSource) throw new CoreError('SOURCE_DISCONNECTED', `${sourceFor(sourceId).name} was reconnected`)
      const followId = track(sourceId, (emit) =>
        startFollow(logSource, path, {
          ...after,
          restarts,
          timestamps: snapshot.timestamps,
          cap: snapshot.lastNLines,
          emit
        })
      )
      return { ...snapshot, restarted: snapshot.restarted || (snapshot.offersPreviousLog && restarts > 0), followId }
    },

    async openFileLog(sourceId, path, options = {}) {
      await loaded
      return withFileSource(sourceId, path, async (fileSource) => (await readFileLog(fileSource, sourceId, path, options)).fileLog)
    },

    async followFile(sourceId, path, options = {}) {
      await loaded
      if (!followableSourceTypes.includes(sourceFor(sourceId).type)) {
        throw new CoreError('NOT_FOLLOWABLE', `Only Local, Kubernetes Files and SSH Files Sources’ files grow, so only they can be followed: ${path}`)
      }
      const { fileSource, fileLog, end, before, identity } = await withFileSource(sourceId, path, async (fileSource) => ({
        fileSource,
        ...(await readFileLog(fileSource, sourceId, path, options, true))
      }))
      // Disconnected, reconnected or dropped while reading: this Follow would outlive the connection it was for.
      const live = liveBackendOf(sourceId)
      if (live?.kind !== 'files' || live.fileSource !== fileSource) {
        throw new CoreError('SOURCE_DISCONNECTED', `${sourceFor(sourceId).name} was disconnected or reconnected, or its connection dropped, while the file was read`)
      }
      const followId = track(sourceId, (emit) =>
        startFileFollow(fileSource, path, { from: end, before, ...(identity !== undefined && { identity }), cap: fileLog.lastNLines, emit })
      )
      return { ...fileLog, followId }
    },

    async pauseFollow(followId) {
      follows.get(followId)?.follow.pause()
    },

    async resumeFollow(followId) {
      follows.get(followId)?.follow.resume()
    },

    async stopFollow(followId) {
      follows.get(followId)?.follow.stop()
      follows.delete(followId)
    },

    async rememberLastNLines(sourceId, lastNLines) {
      await loaded
      const checked = lastNLines === null ? null : checkLastNLines(lastNLines)
      const source = sourceFor(sourceId)
      const changed = checked === null ? withoutLastNLines(source) : { ...source, lastNLines: checked }
      await commit(() => (sources[sources.indexOf(source)] = changed))
    },

    listAwsProfiles,
    awsProfileRegion,
    async listSshHosts() {
      const config = await readSshConfig()
      return config.hosts().map((alias) => {
        const { hostName, user, port } = config.resolve(alias)
        return { alias, hostName, ...(user && { user }), ...(port && { port }) }
      })
    },
    listKubeContexts,

    async listKubeNamespaces(context) {
      return listNamespaces(kubeConfigFor(contextOf(context)))
    },

    async listKubeWorkloads(context, namespace) {
      const cluster = clusterOf({ context, namespace })
      return listWorkloads(kubeConfigFor(cluster.context), cluster.namespace)
    },

    listDockerContexts: () => listDockerContexts(),

    platform: async () => process.platform,

    async getSettings() {
      await settingsLoaded
      return { ...settings }
    },

    updateSettings(changes) {
      const update = settingsUpdate.then(async () => {
        await settingsLoaded
        if (!isRecord(changes)) throw new CoreError('INVALID_SETTINGS', `Settings changes must be an object, not ${String(changes)}`)
        const next = { ...settings, ...pickSettings(changes) }
        const problems = Object.entries(settingProblems(next))
        if (problems.length) {
          const described = problems.map(([key, problem]) => `${key} (${problem})`).join(', ')
          throw new CoreError('INVALID_SETTINGS', `Invalid settings: ${described}`)
        }
        await settingsStore?.save(next)
        settings = next
        for (const listener of settingsListeners) listener({ ...next })
        return { ...next }
      })
      settingsUpdate = update.catch(() => undefined)
      return update
    },

    onSettingsChanged(listener) {
      // Wrapped, so the same function subscribed twice is told twice and unsubscribes independently.
      const subscription = (next: Settings) => listener(next)
      settingsListeners.add(subscription)
      return () => settingsListeners.delete(subscription)
    },

    onFollowEvent(listener) {
      const subscription = (event: FollowEvent) => listener(event)
      followListeners.add(subscription)
      return () => followListeners.delete(subscription)
    },

    onConnectionEvent(listener) {
      const subscription = (event: ConnectionEvent) => listener(event)
      connectionListeners.add(subscription)
      return () => connectionListeners.delete(subscription)
    },

    onLargeFileEvent(listener) {
      const subscription = (event: LargeFileEvent) => listener(event)
      largeFileListeners.add(subscription)
      return () => largeFileListeners.delete(subscription)
    },

    onLargeFileSearchEvent(listener) {
      const subscription = (event: LargeFileSearchEvent) => listener(event)
      searchListeners.add(subscription)
      return () => searchListeners.delete(subscription)
    },

    onSaveCopyEvent(listener) {
      const subscription = (event: SaveCopyEvent) => listener(event)
      saveListeners.add(subscription)
      return () => saveListeners.delete(subscription)
    }
  }
}
