import type { SecretStorage } from 'vscode'
import type { SecretStore } from '../main/core/secret-store'

/** Secret name → value, for one Source. */
type SourceSecrets = Record<string, string>

/**
 * An Extension Copy's secret store: Sources' secrets in VS Code's `SecretStorage`, which the OS keychain encrypts.
 * It can't list what it holds, so each Source's secrets are kept together under one key, to copy and forget at once.
 */
export function createVsCodeSecretStore(storage: Pick<SecretStorage, 'get' | 'store' | 'delete'>): SecretStore {
  const keyOf = (sourceId: string) => `source:${sourceId}`
  const read = async (sourceId: string): Promise<SourceSecrets | undefined> => {
    const saved = await storage.get(keyOf(sourceId))
    return saved === undefined ? undefined : (JSON.parse(saved) as SourceSecrets)
  }

  // One change at a time, so two changes to a Source's secrets can't both start from what was there before either.
  let changes: Promise<unknown> = Promise.resolve()
  const change = <T>(run: () => Promise<T>): Promise<T> => {
    const next = changes.then(run)
    changes = next.catch(() => undefined)
    return next
  }

  return {
    get: async (sourceId, name) => (await read(sourceId))?.[name],

    set: (sourceId, name, value) =>
      change(async () => storage.store(keyOf(sourceId), JSON.stringify({ ...(await read(sourceId)), [name]: value }))),

    copy: (fromSourceId, toSourceId) =>
      change(async () => {
        const saved = await storage.get(keyOf(fromSourceId))
        if (saved !== undefined) await storage.store(keyOf(toSourceId), saved)
      }),

    remove: (sourceId) => change(async () => storage.delete(keyOf(sourceId)))
  }
}
