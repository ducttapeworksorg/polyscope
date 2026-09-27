import { randomUUID } from 'node:crypto'
import type {
  ConnectionState,
  CoreApi,
  CoreEvents,
  EntryNode,
  Environment,
  LocalSourceInfo,
  NewEnvironment,
  NewS3Source,
  NewSource,
  S3SourceInfo,
  SourceInfo,
  SourcePath,
  SourceTypeId,
  TreeNode
} from '@shared/core-api'
import { defaultSettings, isRecord, pickSettings, settingProblems, type Settings } from '@shared/settings'
import { CoreError } from './core-error'
import { createEnvironmentStore, defaultEnvironments, isColor } from './environment-store'
import { checkEncoding, decode, decompress, detectEncoding, hexDump, hexDumpLimit } from './file-content'
import { fileIcon, folderIcon } from './file-icons'
import type { FileSource } from './file-source'
import { languageFor } from './languages'
import { createLocalFileSource } from './local-file-source'
import { createRegistryStore, emptyRegistry, type SavedSource } from './registry-store'
import { createS3FileSource } from './s3-file-source'
import { createSecretStore, type SecretStore } from './secret-store'
import { createSettingsStore } from './settings-store'

const asCoreError = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Fills in settings added since a Source was saved with their defaults. */
const withDefaults = (source: SavedSource): SavedSource =>
  source.type === 'local' ? { ...source, showHidden: source.showHidden ?? true } : source

/** A Source without its Environment label. */
const unlabelled = <S extends SavedSource>({ environmentId: _, ...source }: S) => source as S

/** Where a Source points and how it gets there: its settings, less its id, name and label. */
type Target =
  | Pick<LocalSourceInfo, 'type' | 'rootPath' | 'showHidden'>
  | Pick<S3SourceInfo, 'type' | 'host' | 'bucket' | 'prefix' | 'region' | 'pathStyle' | 'accessKeyId'>

/** The name an S3 Source's secret key is stored under. */
const secretKeyName = 'secretKey'

const isBlank = (value: string | undefined) => !value?.trim()

/** An S3 host as a URL with a scheme (https unless given), or blank for AWS itself. */
function normaliseHost(input: string) {
  const host = input.trim()
  if (!host) return ''
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (!parsed?.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new CoreError('INVALID_HOST', `Not an http(s) address: ${input}`)
  }
  return url.replace(/\/+$/, '')
}

/** Checks the settings specific to a Source's Source Type and returns them normalised. */
function targetOf(input: NewSource): Target {
  if (input.type === 'local') return { type: 'local', rootPath: input.rootPath.trim(), showHidden: input.showHidden ?? true }
  const s3: NewS3Source = input
  const host = normaliseHost(s3.host ?? '')
  const bucket = s3.bucket?.trim() ?? ''
  if (!bucket) throw new CoreError('BUCKET_REQUIRED', 'An S3 Source needs a bucket')
  const accessKeyId = s3.accessKeyId?.trim() ?? ''
  if (!accessKeyId) throw new CoreError('ACCESS_KEY_REQUIRED', 'An S3 Source needs an access key')
  const prefix = (s3.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  const region = s3.region?.trim() || 'us-east-1'
  return { type: 's3', host, bucket, prefix, region, pathStyle: s3.pathStyle ?? false, accessKeyId }
}

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
  type Connection = Exclude<ConnectionState, { state: 'connected' | 'disconnected' }> | { state: 'connected'; fileSource: FileSource }
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
    if (source.type === 'local') return source
    // Only whether there is a secret: the secret itself stays in the core.
    return { ...source, secretKeySet: (await secrets.get(source.id, secretKeyName)) !== undefined }
  }

  const fileSourceFor = (sourceId: string) => {
    const source = sourceFor(sourceId)
    const connection = connections.get(source.id)
    if (connection?.state !== 'connected') {
      throw new CoreError('SOURCE_DISCONNECTED', `${source.name} is not connected`)
    }
    return connection.fileSource
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
          ...(e.problem && { problem: e.problem })
        })
      )
      .sort((a, b) => (a.kind === b.kind ? byName.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    return page.cursor === undefined ? nodes : [...nodes, { kind: 'more', path, cursor: page.cursor }]
  }

  /** Opens a Local File Source at its root folder, once it's clear the folder is there. */
  const reachLocal = async ({ rootPath, showHidden }: Extract<Target, { type: 'local' }>) => {
    const fileSource = createLocalFileSource(rootPath, { showHidden })
    const root = await fileSource.stat('').catch(() => null)
    if (!root) throw new CoreError('ROOT_NOT_FOUND', `Root path does not exist: ${rootPath}`)
    if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `Root path is not a folder: ${rootPath}`)
    return fileSource
  }

  /**
   * Opens a Source's File Source and lists its root: what connecting, or testing a connection, has to get through.
   * An S3 Source needs its `secretKey`; it proves it can sign in by listing.
   */
  const open = async (target: Target, secretKey?: string) => {
    let fileSource: FileSource
    if (target.type === 'local') fileSource = await reachLocal(target)
    else if (secretKey === undefined) throw new CoreError('SECRET_KEY_REQUIRED', 'No secret key is stored for this Source')
    else fileSource = createS3FileSource({ ...target, secretAccessKey: secretKey })
    return { fileSource, nodes: await listNodes(fileSource, '') }
  }

  /** The secret key typed in `input`, or else the one stored for `sourceId`; undefined if there's neither. */
  const secretKeyFor = async (input: NewSource, sourceId?: string) => {
    if (input.type !== 's3') return undefined
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
    // An S3 Source isn't reached until it's connected: it may be saved while its store is away.
    const typed = await secretKeyFor(input)
    if (typed === undefined && (await secretKeyFor(input, editing)) === undefined) {
      throw new CoreError('SECRET_KEY_REQUIRED', 'An S3 Source needs a secret key')
    }
    return { saved: { ...target, name, ...label }, ...(typed !== undefined && { secretKey: typed }) }
  }

  /** Every setting but the name and label, in a form that compares equal whatever order the keys were saved in. */
  const target = ({ name: _, environmentId: __, ...settings }: SavedSource) => JSON.stringify(Object.entries(settings).sort())
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
      const source = { id: sourceId, ...saved } as SavedSource
      const before = sourceFor(sourceId)
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
      if (source.type !== 's3') await secrets.remove(sourceId)
      // A new name keeps the connection; anything else, a new secret included, needs connecting afresh.
      if (!sameTarget(before, source) || secretKey !== undefined) connections.delete(sourceId)
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
      connections.delete(sourceId)
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
      settle({ state: 'connected', fileSource: opened.fileSource })
      return opened.nodes
    },

    async testConnection(input, sourceId) {
      await loaded
      await open(targetOf(input), await secretKeyFor(input, sourceId))
    },

    async disconnect(sourceId) {
      await loaded
      sourceFor(sourceId)
      connections.delete(sourceId)
    },

    async expand(sourceId, path, cursor) {
      await loaded
      const fileSource = fileSourceFor(sourceId)
      try {
        return await listNodes(fileSource, path, cursor)
      } catch (error) {
        const { code, message } = asCoreError(error)
        return [{ kind: 'error', path, code, message }]
      }
    },

    async openFile(sourceId, path, options = {}) {
      await loaded
      const askedEncoding = options.encoding === undefined ? undefined : checkEncoding(options.encoding)
      const fileSource = fileSourceFor(sourceId)
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
    }
  }
}
