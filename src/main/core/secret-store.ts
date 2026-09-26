import { join } from 'node:path'
import { jsonFileWriter, readJsonFile } from './json-file'

/** Encrypts secrets at rest; in the app this is Electron's `safeStorage`, backed by the OS keychain. */
export interface SecretCipher {
  encrypt(plain: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * Secrets belonging to Sources (e.g. S3 secret keys), by Source id and secret name.
 * They stay in the main process: the core API never hands them to the renderer.
 */
export interface SecretStore {
  get(sourceId: string, name: string): Promise<string | undefined>
  set(sourceId: string, name: string, value: string): Promise<void>
  /** Gives `toSourceId` a copy of every secret of `fromSourceId`. */
  copy(fromSourceId: string, toSourceId: string): Promise<void>
  /** Forgets every secret of a Source. */
  remove(sourceId: string): Promise<void>
}

export interface SecretStoreOptions {
  /** Where encrypted secrets are saved between launches; without it they live only in memory. */
  dataDir?: string
  cipher: SecretCipher
}

// Source id → secret name → base64 of the encrypted value.
type Saved = Record<string, Record<string, string>>

export function createSecretStore({ dataDir, cipher }: SecretStoreOptions): SecretStore {
  const file = dataDir && join(dataDir, 'secrets.json')
  const write = file ? jsonFileWriter(file) : null
  const saved = file ? readJsonFile(file).then((value) => (value ?? {}) as Saved) : Promise.resolve<Saved>({})
  const save = async () => write?.(await saved)

  return {
    async get(sourceId, name) {
      const encrypted = (await saved)[sourceId]?.[name]
      return encrypted === undefined ? undefined : cipher.decrypt(Buffer.from(encrypted, 'base64'))
    },

    async set(sourceId, name, value) {
      const secrets = await saved
      secrets[sourceId] = { ...secrets[sourceId], [name]: cipher.encrypt(value).toString('base64') }
      await save()
    },

    async copy(fromSourceId, toSourceId) {
      const secrets = await saved
      const from = secrets[fromSourceId]
      if (!from) return
      secrets[toSourceId] = { ...from }
      await save()
    },

    async remove(sourceId) {
      const secrets = await saved
      if (!(sourceId in secrets)) return
      delete secrets[sourceId]
      await save()
    }
  }
}
