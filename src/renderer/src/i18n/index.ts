import { en } from './en'

export type MessageKey = keyof typeof en

// English is the only locale in v1; new locales plug in here keyed by the same MessageKey set.
/** The locale numbers and dates are formatted for, matching the messages. */
export const locale = 'en'
const messages: Record<MessageKey, string> = en

/** Looks up a UI string and fills `{placeholders}` from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}
