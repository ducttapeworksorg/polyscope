import { join } from 'node:path'
import { sourceTypeIds, type SourceInfo, type SourceTypeId } from '@shared/core-api'
import { jsonFileWriter, readJsonFile } from './json-file'

/** Everything the user configured about their Sources, as saved between launches. */
export interface Registry {
  sources: SourceInfo[]
  groupOrder: SourceTypeId[]
}

export interface RegistryStore {
  load(): Promise<Registry>
  save(registry: Registry): Promise<void>
}

interface SavedRegistry {
  version?: number
  sources?: { type?: unknown }[]
  groupOrder?: unknown[]
}

const isSourceType = (value: unknown): value is SourceTypeId => sourceTypeIds.includes(value as SourceTypeId)

/** Source Types added since the registry was saved join the end of the group order. */
const completeGroupOrder = (saved: SourceTypeId[]) => [...saved, ...sourceTypeIds.filter((t) => !saved.includes(t))]

export const emptyRegistry = (): Registry => ({ sources: [], groupOrder: completeGroupOrder([]) })

/** Keeps the registry as JSON in `dataDir`. */
export function createRegistryStore(dataDir: string): RegistryStore {
  const file = join(dataDir, 'sources.json')
  const write = jsonFileWriter(file)
  // Sources and group positions of Source Types this version doesn't know (e.g. saved by a
  // newer version) aren't shown, but are written back untouched rather than lost.
  let foreign: Required<Omit<SavedRegistry, 'version'>> = { sources: [], groupOrder: [] }

  return {
    async load() {
      const saved = ((await readJsonFile(file)) ?? {}) as SavedRegistry
      const sources = saved.sources ?? []
      const groupOrder = saved.groupOrder ?? []
      foreign = {
        sources: sources.filter((s) => !isSourceType(s.type)),
        groupOrder: groupOrder.filter((t) => !isSourceType(t))
      }
      return {
        sources: sources.filter((s): s is SourceInfo => isSourceType(s.type)),
        groupOrder: completeGroupOrder(groupOrder.filter(isSourceType))
      }
    },

    save: ({ sources, groupOrder }) =>
      write({
        version: 1,
        sources: [...sources, ...foreign.sources],
        groupOrder: [...groupOrder, ...foreign.groupOrder]
      } satisfies SavedRegistry)
  }
}
