import { locale } from '.'

const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const oneDecimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })

/** A byte count in the largest unit (of 1024 the one below) that keeps it at 1 or more, e.g. '5.3 MB'. */
export function formatSize(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // Small numbers keep a decimal so 1.5 KB and 1 KB stay apart; larger ones don't need it.
  return `${(value < 10 && unit > 0 ? oneDecimal : whole).format(value)} ${units[unit]}`
}

const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 30 / 7],
  ['month', 12],
  ['year', Infinity]
]

/** How long ago `time` was, e.g. '5 min. ago'; anything under a minute, or in the future, is 'now'. */
export function formatRelativeTime(time: number, now: number): string {
  let elapsed = Math.max(0, now - time) / 1000
  if (elapsed < 60) return relative.format(0, 'second')
  for (const [unit, size] of steps) {
    if (elapsed < size) return relative.format(-Math.floor(elapsed), unit)
    elapsed /= size
  }
  return relative.format(-Math.floor(elapsed), 'year')
}

const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' })

/** A moment in full, in the local time zone, e.g. 'Sep 26, 2026, 5:44:13 PM'. */
export const formatDateTime = (time: number): string => absolute.format(time)

/** A whole number with the locale's digit grouping, e.g. '1,048,576'. */
export const formatCount = (count: number): string => whole.format(count)
