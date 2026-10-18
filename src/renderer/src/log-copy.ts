import type { SourceInfo } from '@shared/core-api'
import type { OpenTab } from './workspace'

/** What can't be in a file's name on some system or other, nor anything that isn't printed. */
const unnamable = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

const twoDigits = (n: number) => String(n).padStart(2, '0')

/** When, in local time, as a file's name can have it: `2026-10-18-090507`. */
const stampOf = (at: Date) =>
  `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}-${twoDigits(at.getHours())}${twoDigits(at.getMinutes())}${twoDigits(at.getSeconds())}`

/**
 * What a log is of, for its copy's name: the file's name less any `.log`, or the Log Stream's, with its pod's for a
 * container in Kubernetes, whose containers' names repeat from pod to pod.
 */
function whatOf(source: Pick<SourceInfo, 'type'>, file: { of: string; path: string; name: string }) {
  if (file.of === 'file') return file.name.replace(/\.log$/i, '') || file.name
  if (source.type !== 'kubernetesLogs') return file.name
  const pod = file.path.split('/').at(-2)
  return pod ? `${pod}-${file.name}` : file.name
}

/**
 * The name "Save a copy…" suggests for a log tab's lines: what they're of, marked if they're a Previous Log, and
 * when they're saved, say `web-7d9f-nginx-previous-2026-10-18-090507.log`.
 */
export function logCopyName({ source, file }: { source: Pick<SourceInfo, 'type'>; file: Pick<Extract<OpenTab['file'], { view: 'log' }>, 'of' | 'path' | 'name' | 'previous'> }, at: Date): string {
  const what = whatOf(source, file).replace(unnamable, '_')
  return `${what}${file.previous ? '-previous' : ''}-${stampOf(at)}.log`
}

/** The text a copy of a log view's lines is saved as: one per line, each ending in a line break; none if it has none. */
export function logCopyText(lines: readonly string[]): string {
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return ''
  return `${lines.join('\n')}\n`
}
