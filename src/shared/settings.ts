// App-wide settings, shared by the core (which keeps and enforces them) and the Settings screen
// (which checks them as the user types, with the same rules).

export type Theme = 'dark' | 'light'

export const themes: readonly Theme[] = ['dark', 'light']

export interface Settings {
  /** Files larger than this many bytes are Large Files, opened in the Large File Viewer. */
  largeFileThreshold: number
  /** Large Files up to this many bytes can still be opened anyway in the full editor. */
  openAnywayLimit: number
  /** Most bytes the local file cache may hold before it evicts least-recently-used files. */
  cacheSizeCap: number
  /** How many lines a log view fetches and keeps, unless its Source remembers another number. */
  defaultLastNLines: number
  theme: Theme
}

export type NumberSetting = Exclude<keyof Settings, 'theme'>

/** The limits measured in bytes, which have to agree with one another. */
export const sizeSettings = ['largeFileThreshold', 'openAnywayLimit', 'cacheSizeCap'] as const satisfies NumberSetting[]

export const numberSettings: readonly NumberSetting[] = [...sizeSettings, 'defaultLastNLines']

export const MB = 1024 * 1024

export const defaultSettings: Readonly<Settings> = {
  largeFileThreshold: 50 * MB,
  openAnywayLimit: 200 * MB,
  cacheSizeCap: 2048 * MB,
  defaultLastNLines: 10_000,
  theme: 'dark'
}

export type SettingProblem =
  | 'notPositiveWholeNumber'
  | 'notATheme'
  /** The "open anyway" limit is below the Large File threshold, so it could never apply. */
  | 'belowLargeFileThreshold'
  /** The cache is too small to hold a file of the "open anyway" limit. */
  | 'belowOpenAnywayLimit'

export type SettingProblems = Partial<Record<keyof Settings, SettingProblem>>

const isPositiveWholeNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The settings found among `record`'s keys, values unchecked; anything else in it is left out. */
export function pickSettings(record: Record<string, unknown>): Partial<Settings> {
  return Object.fromEntries(Object.keys(defaultSettings).filter((key) => key in record).map((key) => [key, record[key]]))
}

/** What's wrong with each setting, if anything; an empty object means the settings are valid. */
export function settingProblems(settings: Settings): SettingProblems {
  const problems: SettingProblems = {}
  for (const key of numberSettings) {
    if (!isPositiveWholeNumber(settings[key])) problems[key] = 'notPositiveWholeNumber'
  }
  if (!themes.includes(settings.theme)) problems.theme = 'notATheme'
  // Limits are only compared once each is a number at all.
  if (!problems.openAnywayLimit && !problems.largeFileThreshold && settings.openAnywayLimit < settings.largeFileThreshold) {
    problems.openAnywayLimit = 'belowLargeFileThreshold'
  }
  if (!problems.cacheSizeCap && !problems.openAnywayLimit && settings.cacheSizeCap < settings.openAnywayLimit) {
    problems.cacheSizeCap = 'belowOpenAnywayLimit'
  }
  return problems
}
