import { join } from 'node:path'
import { defaultSettings, isRecord, pickSettings, settingProblems, sizeSettings, type Settings } from '@shared/settings'
import { jsonFileWriter, readJsonFile } from './json-file'

export interface SettingsStore {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

type SavedSettings = Record<string, unknown> & { version?: number }

/** Puts each named setting back to its default. */
const reset = (settings: Settings, keys: readonly (keyof Settings)[]): Settings => ({
  ...settings,
  ...Object.fromEntries(keys.map((key) => [key, defaultSettings[key]]))
})

/** Keeps the settings as JSON in `dataDir`. */
export function createSettingsStore(dataDir: string): SettingsStore {
  const file = join(dataDir, 'settings.json')
  const write = jsonFileWriter(file)
  // Settings this version doesn't know (e.g. saved by a newer version) are written back untouched.
  let foreign: SavedSettings = {}

  return {
    async load() {
      const saved = await readJsonFile(file)
      const { version: _, ...record }: SavedSettings = isRecord(saved) ? saved : {}
      const known = pickSettings(record)
      foreign = Object.fromEntries(Object.entries(record).filter(([key]) => !(key in known)))
      // Each saved value that is invalid goes back to its default, so one bad value doesn't cost the rest.
      let settings: Settings = { ...defaultSettings, ...known }
      settings = reset(settings, Object.keys(settingProblems(settings)) as (keyof Settings)[])
      // A kept limit can still disagree with a defaulted one (e.g. a threshold above the default
      // "open anyway" limit); then the limits start over together, and everything else is kept.
      return Object.keys(settingProblems(settings)).length ? reset(settings, sizeSettings) : settings
    },

    save: (settings) => write({ ...foreign, version: 1, ...settings } satisfies SavedSettings)
  }
}
