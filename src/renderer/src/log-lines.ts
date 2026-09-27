import type { FollowUpdate, LogSnapshot } from '@shared/core-api'
import { describeFailure } from './core-client'
import { t } from './i18n'

/** How a log view shows its lines: with the timestamps its log came with, in local time or UTC. */
export interface LogFormat {
  timestamps: boolean
  utc: boolean
}

// An RFC 3339 UTC timestamp at the start of a line, as a Log Source gives it, then a space (unless the line is empty).
const leadingTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?= |$)/

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** A time as `2026-09-27 06:00:00.123`, in local time, or in UTC and ending in Z. */
function formatTime(time: Date, utc: boolean): string {
  const [year, month, day, hours, minutes, seconds] = utc
    ? [time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds()]
    : [time.getFullYear(), time.getMonth(), time.getDate(), time.getHours(), time.getMinutes(), time.getSeconds()]
  const millis = pad(time.getUTCMilliseconds(), 3)
  return `${year}-${pad(month + 1)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${millis}${utc ? 'Z' : ''}`
}

/** A line with its leading timestamp shown in local time or UTC; a line without one as it is. */
const showTimestamp = (line: string, utc: boolean) =>
  line.replace(leadingTimestamp, (_match, timestamp: string) => formatTime(new Date(timestamp), utc))

/** What a log view shows for its snapshot: its content, with any timestamps in local time or UTC. */
export const shownContent = ({ content, timestamps }: Pick<LogSnapshot, 'content' | 'timestamps'>, utc: boolean) =>
  timestamps ? content.split('\n').map((line) => showTimestamp(line, utc)).join('\n') : content

// Marks are Polyscope's own lines in a log: framed so they stand out, and can be highlighted.
const markOpen = '── '
const markClose = ' ──'
const mark = (text: string) => `${markOpen}${text}${markClose}`

/** Whether a log line is one of Polyscope's marks, like the one for a restart. */
export const isMarker = (line: string) => line.startsWith(markOpen) && line.endsWith(markClose)

/** A regular expression matching a mark line, for highlighting. */
export const markerPattern = /^── .* ──$/

/** The lines a Follow's update adds to its log view: its new lines, or a mark saying what happened. */
export function followLines(update: FollowUpdate, { timestamps, utc }: LogFormat): string[] {
  switch (update.kind) {
    case 'lines':
      return timestamps ? update.lines.map((line) => showTimestamp(line, utc)) : update.lines
    case 'restarted':
      return [mark(t('logView.mark.restarted'))]
    case 'failed':
      return [mark(t('logView.mark.failed', { reason: describeFailure(update), seconds: Math.round(update.retryIn / 1000) }))]
    case 'recovered':
      return [mark(t('logView.mark.recovered'))]
    case 'ended':
      return [mark(t(`logView.mark.ended.${update.reason}`))]
  }
}
