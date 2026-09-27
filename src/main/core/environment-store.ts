import { join } from 'node:path'
import type { Environment } from '@shared/core-api'
import { isRecord } from '@shared/settings'
import { jsonFileWriter, readJsonFile } from './json-file'

export interface EnvironmentStore {
  load(): Promise<Environment[]>
  save(environments: Environment[]): Promise<void>
}

interface SavedEnvironments {
  version?: number
  environments?: unknown[]
}

export const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

/** What a first launch starts with: the usual deployment stages, with prod protected. */
export const defaultEnvironments = (): Environment[] => [
  { id: 'prod', name: 'prod', color: '#e5484d', protected: true },
  { id: 'staging', name: 'staging', color: '#f76b15', protected: false },
  { id: 'qa', name: 'qa', color: '#ffc53d', protected: false },
  { id: 'dev', name: 'dev', color: '#30a46c', protected: false }
]

const isEnvironment = (value: unknown): value is Environment =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['name'] === 'string' &&
  isColor(value['color']) &&
  typeof value['protected'] === 'boolean'

/** Keeps the Environments as JSON in `dataDir`. */
export function createEnvironmentStore(dataDir: string): EnvironmentStore {
  const file = join(dataDir, 'environments.json')
  const write = jsonFileWriter(file)

  return {
    async load() {
      const saved = await readJsonFile(file)
      // Only a file that was never saved (or couldn't be read) gets the defaults; deleting them all sticks.
      if (!isRecord(saved)) return defaultEnvironments()
      const { environments = [] } = saved as SavedEnvironments
      return environments.filter(isEnvironment).map(({ id, name, color, protected: isProtected }) => ({
        id,
        name,
        color: color.toLowerCase(),
        protected: isProtected
      }))
    },

    save: (environments) => write({ version: 1, environments } satisfies SavedEnvironments)
  }
}
