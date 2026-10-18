/**
 * A log view's Since: how far back its lines go. A while before now, worked out afresh each time the log is read, or
 * a time typed in. Any time when there's none.
 */
export type SinceChoice = { minutesAgo: number } | { time: string }

/** The whiles ago a log view offers, in minutes: 15 min, 1 h, 6 h and 24 h. */
export const sinceChoices = [15, 60, 6 * 60, 24 * 60] as const

/** The time a Since stands for, as an RFC 3339 time in UTC, a while ago counted back from `now`. */
export const sinceTimeOf = (since: SinceChoice, now = new Date()) =>
  'time' in since ? since.time : new Date(now.getTime() - since.minutesAgo * 60_000).toISOString()

// `2026-10-18 09:00`, a `T` in place of the space, seconds optional; or the time alone, for today.
const dateTime = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i

/**
 * A Since typed in as a date and time, or a time alone for today, in local time or, `utc`, in UTC: as an RFC 3339 time
 * in UTC, or undefined if it can't be read.
 */
export function readSince(typed: string, utc: boolean, now = new Date()): string | undefined {
  const match = dateTime.exec(typed.trim())
  if (!match) return undefined
  const today = utc ? [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()] : [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  const [year, month, day] = match[1] ? [Number(match[1]), Number(match[2]), Number(match[3])] : today
  const [hours, minutes, seconds] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)]
  // A day the month doesn't have would roll over into the next.
  const date = new Date(Date.UTC(year!, month! - 1, day))
  if (date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return undefined
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined
  const time = utc ? new Date(Date.UTC(year!, month! - 1, day, hours, minutes, seconds)) : new Date(year!, month! - 1, day, hours, minutes, seconds)
  return time.toISOString()
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A Since's time as it's typed in, in local time or UTC: `2026-10-18 09:00`, with seconds only if it has some. */
export function shownSince(time: string, utc: boolean): string {
  const at = new Date(time)
  const [year, month, day, hours, minutes, seconds] = utc
    ? [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    : [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]
  return `${year}-${pad(month + 1)}-${pad(day)} ${pad(hours)}:${pad(minutes)}${seconds ? `:${pad(seconds)}` : ''}`
}
