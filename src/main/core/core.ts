import { randomUUID } from 'node:crypto'
import type {
  ConnectionState,
  CoreApi,
  CoreEvents,
  EntryNode,
  Environment,
  NewEnvironment,
  NewSource,
  SourceInfo,
  SourcePath,
  SourceTypeId
} from '@shared/core-api'
import { defaultSettings, isRecord, pickSettings, settingProblems, type Settings } from '@shared/settings'
import { CoreError } from './core-error'
import { createEnvironmentStore, defaultEnvironments, isColor } from './environment-store'
import { checkEncoding, decode, decompress, detectEncoding, hexDump, hexDumpLimit } from './file-content'
import { fileIcon, folderIcon } from './file-icons'
import type { FileSource } from './file-source'
import { languageFor } from './languages'
import { createLocalFileSource } from './local-file-source'
import { createRegistryStore, emptyRegistry } from './registry-store'
import { createSecretStore, type SecretStore } from './secret-store'
import { createSettingsStore } from './settings-store'

const asCoreError = (error: unknown) =>
  error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Fills in settings added since a Source was saved with their defaults. */
const withDefaults = (source: SourceInfo): SourceInfo => ({ ...source, showHidden: source.showHidden ?? true })

/** A Source without its Environment label. */
const unlabelled = ({ environmentId: _, ...source }: SourceInfo): SourceInfo => source

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
  const handOut = (source: SourceInfo) =>
    source.environmentId === undefined || environments.some((e) => e.id === source.environmentId) ? { ...source } : unlabelled(source)

  const fileSourceFor = (sourceId: string) => {
    const source = sourceFor(sourceId)
    const connection = connections.get(source.id)
    if (connection?.state !== 'connected') {
      throw new CoreError('SOURCE_DISCONNECTED', `${source.name} is not connected`)
    }
    return connection.fileSource
  }

  const listNodes = async (fileSource: FileSource, path: SourcePath) => {
    const entries = await fileSource.listChildren(path)
    return entries
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
  }

  /** Opens a File Source for a Source's settings, once it's clear it can be reached. */
  const reach = async ({ rootPath, showHidden = true }: Pick<NewSource, 'rootPath' | 'showHidden'>) => {
    const fileSource = createLocalFileSource(rootPath, { showHidden })
    const root = await fileSource.stat('').catch(() => null)
    if (!root) throw new CoreError('ROOT_NOT_FOUND', `Root path does not exist: ${rootPath}`)
    if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `Root path is not a folder: ${rootPath}`)
    return fileSource
  }

  /** Reaches a Source and lists its root: what connecting, or testing a connection, has to get through. */
  const open = async (settings: Pick<NewSource, 'rootPath' | 'showHidden'>) => {
    const fileSource = await reach(settings)
    return { fileSource, nodes: await listNodes(fileSource, '') }
  }

  /** Checks new or edited settings and returns them normalised, without an id. */
  const validate = async (input: NewSource): Promise<Omit<SourceInfo, 'id'>> => {
    const name = input.name.trim()
    if (!name) throw new CoreError('NAME_REQUIRED', 'A Source needs a name')
    const { environmentId } = input
    if (environmentId !== undefined) environmentFor(environmentId)
    const rootPath = input.rootPath.trim()
    const showHidden = input.showHidden ?? true
    await reach({ rootPath, showHidden })
    return { type: input.type, name, rootPath, showHidden, ...(environmentId !== undefined && { environmentId }) }
  }

  /** Every setting but the name and label, in a form that compares equal whatever order the keys were saved in. */
  const target = ({ name: _, environmentId: __, ...settings }: SourceInfo) => JSON.stringify(Object.entries(settings).sort())
  const sameTarget = (a: SourceInfo, b: SourceInfo) => target(a) === target(b)

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
      const rank = (s: SourceInfo) => groupOrder.indexOf(s.type)
      return sources.toSorted((a, b) => rank(a) - rank(b)).map(handOut)
    },

    async addSource(input) {
      await loaded
      const source: SourceInfo = { id: randomUUID(), ...(await validate(input)) }
      await commit(() => sources.push(source))
      return { ...source }
    },

    async editSource(sourceId, input) {
      await loaded
      sourceFor(sourceId) // an unknown Source is reported before any invalid settings
      const source: SourceInfo = { id: sourceId, ...(await validate(input)) }
      const before = sourceFor(sourceId)
      await commit(() => (sources[sources.indexOf(before)] = source))
      // A new name keeps the connection; anything else points somewhere new and needs connecting afresh.
      if (!sameTarget(before, source)) connections.delete(sourceId)
      return { ...source }
    },

    async duplicateSource(sourceId) {
      await loaded
      const id = randomUUID()
      await secrets.copy(sourceFor(sourceId).id, id)
      try {
        // Looked up again: the registry may have changed while the secrets were copied.
        const original = sourceFor(sourceId)
        const copy: SourceInfo = { ...original, id, name: copyName(original.name) }
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
        opened = await open(source)
      } catch (error) {
        const failure = asCoreError(error)
        settle({ state: 'error', code: failure.code, message: failure.message })
        throw failure
      }
      settle({ state: 'connected', fileSource: opened.fileSource })
      return opened.nodes
    },

    async testConnection(input) {
      await open({ rootPath: input.rootPath.trim(), showHidden: input.showHidden })
    },

    async disconnect(sourceId) {
      await loaded
      sourceFor(sourceId)
      connections.delete(sourceId)
    },

    async expand(sourceId, path) {
      await loaded
      const fileSource = fileSourceFor(sourceId)
      try {
        return await listNodes(fileSource, path)
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
