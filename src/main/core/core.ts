import { randomUUID } from 'node:crypto'
import type {
  ConnectionState,
  CoreApi,
  CoreEvents,
  EntryNode,
  Environment,
  FilesWorkloadKind,
  FollowEvent,
  KubernetesFilesSourceInfo,
  KubernetesLogsSourceInfo,
  LastNLines,
  LocalSourceInfo,
  LogNode,
  LogSnapshot,
  NewEnvironment,
  NewS3Source,
  NewSource,
  OpenLogOptions,
  S3SourceInfo,
  SourceInfo,
  SourcePath,
  SourceTypeId,
  TreeNode
} from '@shared/core-api'
import { filesWorkloadKinds, workloadKinds } from '@shared/core-api'
import { defaultSettings, isRecord, pickSettings, settingProblems, type Settings } from '@shared/settings'
import { listAwsProfiles } from './aws-profiles'
import { CoreError } from './core-error'
import { createEnvironmentStore, defaultEnvironments, isColor } from './environment-store'
import { checkEncoding, decode, decompress, detectEncoding, hexDump, hexDumpLimit } from './file-content'
import { fileIcon, folderIcon } from './file-icons'
import type { FileSource } from './file-source'
import { kubeConfigFor, listKubeContexts } from './kubeconfig'
import { listNamespaces } from './kubernetes-api'
import { createKubernetesFileSource, listWorkloads } from './kubernetes-file-source'
import { createKubernetesLogSource } from './kubernetes-log-source'
import { languageFor } from './languages'
import { createLocalFileSource } from './local-file-source'
import { startFollow, type Follow } from './log-follow'
import type { LogReadOptions, LogSource } from './log-source'
import { createRegistryStore, emptyRegistry, type SavedSource } from './registry-store'
import { createS3FileSource, readCaBundle, type S3Target } from './s3-file-source'
import { createSecretStore, type SecretStore } from './secret-store'
import { createSettingsStore } from './settings-store'

const asCoreError = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const isLastNLines = (value: unknown): value is LastNLines => value === 'all' || (Number.isSafeInteger(value) && (value as number) > 0)

function checkLastNLines(value: unknown): LastNLines {
  if (!isLastNLines(value)) throw new CoreError('INVALID_LINE_COUNT', `Not a whole number of lines greater than zero, or all: ${String(value)}`)
  return value
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
  | Omit<S3SourceInfo, 'id' | 'name' | 'environmentId' | 'lastNLines' | 'secretKeySet'>
  | Pick<KubernetesFilesSourceInfo, 'type' | 'context' | 'namespace' | 'workloadKind' | 'workloadName' | 'path'>
  | Pick<KubernetesLogsSourceInfo, 'type' | 'context' | 'namespace'>

type S3Settings = Extract<Target, { type: 's3' }>

/** The name an S3 Source's secret key is stored under. */
const secretKeyName = 'secretKey'

const isBlank = (value: string | undefined) => !value?.trim()

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

/** A folder's absolute path in a container, without repeated or trailing '/'; failing if it isn't absolute or climbs with '..'. */
function normaliseContainerPath(input: string) {
  const path = input.trim()
  const segments = path.split('/').filter(Boolean)
  if (!path.startsWith('/') || segments.some((s) => s === '..' || s === '.')) {
    throw new CoreError('INVALID_CONTAINER_PATH', `Not an absolute path: ${input}`)
  }
  return `/${segments.join('/')}`
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
  if (input.type === 'kubernetesFiles') {
    const cluster = clusterOf(input)
    const workloadKind = workloadKindOf(input.workloadKind)
    const workloadName = input.workloadName?.trim() ?? ''
    if (!workloadName) throw new CoreError('WORKLOAD_REQUIRED', 'A Kubernetes Files Source needs a Workload')
    return { type: 'kubernetesFiles', ...cluster, workloadKind, workloadName, path: normaliseContainerPath(input.path ?? '') }
  }
  const s3: NewS3Source = input
  // Blank for AWS itself; a store is most likely https, a proxy http.
  const host = normaliseUrl(s3.host ?? '', 'https', 'INVALID_HOST')
  const bucket = s3.bucket?.trim() ?? ''
  if (!bucket) throw new CoreError('BUCKET_REQUIRED', 'An S3 Source needs a bucket')
  const auth = s3.auth ?? 'keys'
  // Only what the chosen way of signing in uses is kept: an access key typed before switching to a profile goes.
  const accessKeyId = auth === 'keys' ? (s3.accessKeyId?.trim() ?? '') : ''
  if (auth === 'keys' && !accessKeyId) throw new CoreError('ACCESS_KEY_REQUIRED', 'An S3 Source needs an access key')
  return {
    type: 's3',
    host,
    bucket,
    prefix: (s3.prefix ?? '').trim().replace(/^\/+|\/+$/g, ''),
    region: s3.region?.trim() || 'us-east-1',
    pathStyle: s3.pathStyle ?? false,
    auth,
    accessKeyId,
    profile: auth === 'profile' ? (s3.profile?.trim() ?? '') : '',
    verifyTls: s3.verifyTls ?? true,
    caBundlePath: s3.caBundlePath?.trim() ?? '',
    proxyUrl: normaliseUrl(s3.proxyUrl ?? '', 'http', 'INVALID_PROXY')
  }
}

/** What an S3 File Source needs to reach its store: the settings, with the secret key (when signing in with keys) and CA bundle read in. */
async function s3TargetOf(settings: S3Settings, secretKey?: string): Promise<S3Target> {
  const { host, bucket, prefix, region, pathStyle, verifyTls, proxyUrl } = settings
  let credentials: S3Target['credentials']
  if (settings.auth === 'profile') credentials = { profile: settings.profile }
  else if (secretKey === undefined) throw new CoreError('SECRET_KEY_REQUIRED', 'No secret key is stored for this Source')
  else credentials = { accessKeyId: settings.accessKeyId, secretAccessKey: secretKey }
  const caBundle = settings.caBundlePath ? await readCaBundle(settings.caBundlePath) : undefined
  return { host, bucket, prefix, region, pathStyle, credentials, verifyTls, proxyUrl, ...(caBundle && { caBundle }) }
}

/** What a Connected Source reads from: files, or Log Streams. */
type Backend = { kind: 'files'; fileSource: FileSource } | { kind: 'logs'; logSource: LogSource }

export interface CoreOptions {
  /** Where the registry is saved between launches; without it, nothing outlives the core. */
  dataDir?: string
  /** Where Sources' secrets are kept; defaults to memory only. */
  secrets?: SecretStore
}

const inMemory = { encrypt: (plain: string) => Buffer.from(plain), decrypt: (encrypted: Buffer) => encrypted.toString() }

export type Core = CoreApi & CoreEvents

export function createCore(options: CoreOptions = {}): Core {
  const store = options.dataDir ? createRegistryStore(options.dataDir) : null
  const environmentStore = options.dataDir ? createEnvironmentStore(options.dataDir) : null
  const settingsStore = options.dataDir ? createSettingsStore(options.dataDir) : null
  const secrets = options.secrets ?? createSecretStore({ cipher: inMemory })
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
  type Connection = Exclude<ConnectionState, { state: 'connected' | 'disconnected' }> | { state: 'connected'; backend: Backend }
  const connections = new Map<string, Connection>()

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
    if (source.type !== 's3') return source
    // Only whether there is a secret: the secret itself stays in the core.
    return { ...source, secretKeySet: (await secrets.get(source.id, secretKeyName)) !== undefined }
  }

  const backendFor = (sourceId: string) => {
    const source = sourceFor(sourceId)
    const connection = connections.get(source.id)
    if (connection?.state !== 'connected') {
      throw new CoreError('SOURCE_DISCONNECTED', `${source.name} is not connected`)
    }
    return connection.backend
  }

  const fileSourceFor = (sourceId: string, path: SourcePath) => {
    const backend = backendFor(sourceId)
    if (backend.kind !== 'files') throw new CoreError('NOT_A_FILE', `A Log Source has no files: ${path}`)
    return backend.fileSource
  }

  const logSourceFor = (sourceId: string, path: SourcePath) => {
    const backend = backendFor(sourceId)
    if (backend.kind !== 'logs') throw new CoreError('NOT_A_LOG_STREAM', `A File Source has no Log Streams: ${path}`)
    return backend.logSource
  }

  /**
   * The last lines of a log, as openLog gives them, along with where a Follow carries on from: the
   * timestamp of the last line, and how many lines have it. Those are only known `forFollowing`, which
   * reads the lines with their timestamps whether or not they're shown.
   */
  const readSnapshot = async (logSource: LogSource, sourceId: string, path: SourcePath, options: OpenLogOptions, forFollowing = false) => {
    const asked = options.lastNLines === undefined ? undefined : checkLastNLines(options.lastNLines)
    const timestamps = options.timestamps === true
    const { pod, container, previous } = await logSource.logStreamAt(path)
    await settingsLoaded
    const lastNLines = asked ?? sourceFor(sourceId).lastNLines ?? settings.defaultLastNLines
    const read = { timestamps: timestamps || forFollowing }
    const snapshot = (lines: string[]): LogSnapshot => ({ view: 'log', path, name: container, pod, previous, lastNLines, timestamps, content: lines.join('\n') })
    let text: string
    try {
      if (lastNLines !== 'all') text = await logSource.readLog(path, { ...read, tailLines: lastNLines })
      else if (options.allowLarge) text = await logSource.readLog(path, read)
      else text = await readUpToLarge(logSource, path, read)
    } catch (error) {
      // A container with no log yet, say one waiting to start, can still be followed: its log will come.
      if (!forFollowing || asCoreError(error).code !== 'LOG_UNAVAILABLE') throw error
      return { snapshot: snapshot([]) }
    }
    const lines = text ? text.replace(/\n$/, '').split('\n') : []
    const kept = lastNLines === 'all' ? lines : lines.slice(-lastNLines)
    const stamps = read.timestamps ? kept.map(timestampOf) : []
    const lastTimestamp = stamps.at(-1)
    const shown = read.timestamps && !timestamps ? kept.map((line, i) => line.slice(stamps[i]!.length + 1)) : kept
    return {
      snapshot: snapshot(shown),
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

  // Follows under way, by id, each with the Source it reads from.
  const follows = new Map<string, { sourceId: string; follow: Follow }>()
  const followListeners = new Set<(event: FollowEvent) => void>()
  const announceFollow = (event: FollowEvent) => {
    for (const listener of followListeners) listener(event)
  }

  /** Stops every Follow of a Source, telling its listeners: the connection it used is gone. */
  const stopFollows = (sourceId: string) => {
    for (const [followId, entry] of follows) {
      if (entry.sourceId !== sourceId) continue
      entry.follow.stop()
      follows.delete(followId)
      announceFollow({ followId, kind: 'ended', reason: 'disconnected' })
    }
  }

  /** Forgets a Source's connection, stopping its Follows. */
  const dropConnection = (sourceId: string) => {
    stopFollows(sourceId)
    connections.delete(sourceId)
  }

  /** A page of a folder's children, folders first, then files, each by name; a more node ends it if there are more. */
  const listNodes = async (fileSource: FileSource, path: SourcePath, cursor?: string): Promise<TreeNode[]> => {
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
    return page.cursor === undefined ? nodes : [...nodes, { kind: 'more', path, cursor: page.cursor }]
  }

  /** A Log Source node's children: groups in the order of their kind, containers in their pod's, the rest by name. */
  const listLogNodes = async (logSource: LogSource, path: SourcePath): Promise<TreeNode[]> => {
    const nodes = await logSource.listChildren(path)
    if (nodes.every((node) => node.kind === 'container')) return nodes
    const rank = (node: LogNode) => (node.kind === 'group' ? workloadKinds.indexOf(node.workloadKind) : 0)
    return nodes.toSorted((a, b) => rank(a) - rank(b) || byName.compare(a.name, b.name))
  }

  /** Lists a node's children in whichever kind of Source it is. */
  const listBackend = (backend: Backend, path: SourcePath, cursor?: string) =>
    backend.kind === 'files' ? listNodes(backend.fileSource, path, cursor) : listLogNodes(backend.logSource, path)

  /** Opens a Local File Source at its root folder, once it's clear the folder is there. */
  const reachLocal = async ({ rootPath, showHidden }: Extract<Target, { type: 'local' }>) => {
    const fileSource = createLocalFileSource(rootPath, { showHidden })
    const root = await fileSource.stat('').catch(() => null)
    if (!root) throw new CoreError('ROOT_NOT_FOUND', `Root path does not exist: ${rootPath}`)
    if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `Root path is not a folder: ${rootPath}`)
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
    const logSource = createKubernetesLogSource(kubeConfigFor(context), namespace)
    await logSource.checkNamespace()
    return logSource
  }

  /**
   * Opens a Source's File or Log Source and lists its root: what connecting, or testing a connection, has to get through.
   * An S3 Source signing in with keys needs its `secretKey`; it proves it can sign in by listing.
   */
  const open = async (target: Target, secretKey?: string) => {
    let backend: Backend
    if (target.type === 'local') backend = { kind: 'files', fileSource: await reachLocal(target) }
    else if (target.type === 's3') backend = { kind: 'files', fileSource: createS3FileSource(await s3TargetOf(target, secretKey)) }
    else if (target.type === 'kubernetesFiles') backend = { kind: 'files', fileSource: await reachKubernetesFiles(target) }
    else backend = { kind: 'logs', logSource: await reachKubernetes(target) }
    return { backend, nodes: await listBackend(backend, '') }
  }

  /** The secret key typed in `input`, or else the one stored for `sourceId`; undefined if there's neither. */
  const secretKeyFor = async (input: NewSource, sourceId?: string) => {
    if (input.type !== 's3' || (input.auth ?? 'keys') !== 'keys') return undefined
    if (!isBlank(input.secretAccessKey)) return input.secretAccessKey
    return sourceId === undefined ? undefined : secrets.get(sourceId, secretKeyName)
  }

  /**
   * Checks new or edited settings and returns them normalised, without an id, along with a secret key
   * typed in them. `editing` is the id of the Source they replace, whose stored secret key can stay.
   */
  const validate = async (input: NewSource, editing?: string): Promise<{ saved: Omit<SavedSource, 'id'>; secretKey?: string }> => {
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
    // Nor is a cluster: it may be away, or its context not in the kubeconfig yet.
    if (target.type === 'kubernetesLogs' || target.type === 'kubernetesFiles') return { saved: { ...target, name, ...label } }
    // An S3 Source isn't reached until it's connected: it may be saved while its store is away.
    const typed = await secretKeyFor(input)
    if (target.auth === 'keys' && typed === undefined && (await secretKeyFor(input, editing)) === undefined) {
      throw new CoreError('SECRET_KEY_REQUIRED', 'An S3 Source needs a secret key')
    }
    return { saved: { ...target, name, ...label }, ...(typed !== undefined && { secretKey: typed }) }
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
      const { saved, secretKey } = await validate(input)
      const source = { id: randomUUID(), ...saved } as SavedSource
      if (secretKey !== undefined) await secrets.set(source.id, secretKeyName, secretKey)
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
      const { saved, secretKey } = await validate(input, sourceId)
      const before = sourceFor(sourceId)
      // What the user picked in its log views isn't among the settings edited, so it stays.
      const remembered = before.lastNLines !== undefined && { lastNLines: before.lastNLines }
      const source = { id: sourceId, ...saved, ...remembered } as SavedSource
      const previousKey = secretKey === undefined ? undefined : await secrets.get(sourceId, secretKeyName)
      if (secretKey !== undefined) await secrets.set(sourceId, secretKeyName, secretKey)
      try {
        await commit(() => (sources[sources.indexOf(before)] = source))
      } catch (error) {
        // The secret key is a Source's only secret, so forgetting its secrets forgets just the one written here.
        if (previousKey !== undefined) await secrets.set(sourceId, secretKeyName, previousKey)
        else if (secretKey !== undefined) await secrets.remove(sourceId)
        throw error
      }
      // A Source that no longer signs in with a secret key has no use for the one it had.
      if (source.type !== 's3' || source.auth !== 'keys') await secrets.remove(sourceId)
      // A new name keeps the connection; anything else, a new secret included, needs connecting afresh.
      if (!sameTarget(before, source) || secretKey !== undefined) dropConnection(sourceId)
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
      sourceFor(sourceId)
      // Secrets go first: if that fails the Source is still there to delete again.
      await secrets.remove(sourceId)
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
      // Connecting again replaces the connection the Source's Follows were using.
      stopFollows(sourceId)
      connections.set(sourceId, attempt)
      const settle = (outcome: Connection) => {
        if (connections.get(sourceId) !== attempt) {
          throw new CoreError('SOURCE_DISCONNECTED', `${source.name} was disconnected or reconnected while connecting`)
        }
        connections.set(sourceId, outcome)
      }
      let opened: Awaited<ReturnType<typeof open>>
      try {
        opened = await open(source, source.type === 's3' ? await secrets.get(sourceId, secretKeyName) : undefined)
      } catch (error) {
        const failure = asCoreError(error)
        settle({ state: 'error', code: failure.code, message: failure.message })
        throw failure
      }
      settle({ state: 'connected', backend: opened.backend })
      return opened.nodes
    },

    async testConnection(input, sourceId) {
      await loaded
      await open(targetOf(input), await secretKeyFor(input, sourceId))
    },

    async disconnect(sourceId) {
      await loaded
      sourceFor(sourceId)
      dropConnection(sourceId)
    },

    async expand(sourceId, path, cursor) {
      await loaded
      const backend = backendFor(sourceId)
      try {
        return await listBackend(backend, path, cursor)
      } catch (error) {
        const { code, message } = asCoreError(error)
        return [{ kind: 'error', path, code, message }]
      }
    },

    async openFile(sourceId, path, options = {}) {
      await loaded
      const askedEncoding = options.encoding === undefined ? undefined : checkEncoding(options.encoding)
      const fileSource = fileSourceFor(sourceId, path)
      const info = await fileSource.stat(path)
      if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
      const name = path.slice(path.lastIndexOf('/') + 1)
      const stored = await fileSource.read(path, { offset: 0, length: info.size })
      await settingsLoaded
      const { innerName, bytes, compression } = await decompress(name, stored, settings.openAnywayLimit)
      const common = { path, name, size: info.size, modifiedTime: info.modifiedTime, ...(compression && { compression }) }
      const encoding = askedEncoding ?? (options.hex ? null : detectEncoding(bytes))
      if (encoding) return { view: 'editor', ...common, content: decode(bytes, encoding), encoding, language: languageFor(innerName) }
      if (!options.hex) return { view: 'binary', ...common, contentLength: bytes.length }
      const shown = bytes.subarray(0, hexDumpLimit)
      return { view: 'hex', ...common, content: hexDump(shown), contentLength: bytes.length, shownLength: shown.length }
    },

    async openLog(sourceId, path, options = {}) {
      await loaded
      return (await readSnapshot(logSourceFor(sourceId, path), sourceId, path, options)).snapshot
    },

    async followLog(sourceId, path, options = {}) {
      await loaded
      const logSource = logSourceFor(sourceId, path)
      if ((await logSource.logStreamAt(path)).previous) throw new CoreError('NOT_FOLLOWABLE', `A Previous Log has ended: ${path}`)
      // The snapshot has to be of the run the Follow starts from: one read while the container restarted is read again.
      let restarts = (await logSource.containerInstance(path)).restarts
      let read: Awaited<ReturnType<typeof readSnapshot>>
      for (let tries = 1; ; tries++) {
        read = await readSnapshot(logSource, sourceId, path, options, true)
        const after = (await logSource.containerInstance(path)).restarts
        if (after === restarts || tries === 3) break
        restarts = after
      }
      const { snapshot, lastTimestamp, lastTimestampCount } = read
      // Disconnected or reconnected while reading: this Follow would outlive the connection it was for.
      if (logSourceFor(sourceId, path) !== logSource) throw new CoreError('SOURCE_DISCONNECTED', `${sourceFor(sourceId).name} was reconnected`)
      const followId = randomUUID()
      const follow = startFollow(logSource, path, {
        ...(lastTimestamp !== undefined && { after: lastTimestamp, afterCount: lastTimestampCount }),
        restarts,
        timestamps: snapshot.timestamps,
        cap: snapshot.lastNLines,
        emit: (update) => {
          if (update.kind === 'ended') follows.delete(followId)
          announceFollow({ ...update, followId })
        }
      })
      follows.set(followId, { sourceId, follow })
      return { ...snapshot, followId }
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
    listKubeContexts,

    async listKubeNamespaces(context) {
      return listNamespaces(kubeConfigFor(contextOf(context)))
    },

    async listKubeWorkloads(context, namespace, kind) {
      const cluster = clusterOf({ context, namespace })
      return listWorkloads(kubeConfigFor(cluster.context), cluster.namespace, workloadKindOf(kind))
    },

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
    }
  }
}
