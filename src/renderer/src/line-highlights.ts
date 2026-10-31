import { logLevelOf, type LogLevel } from './log-level'
import { markerPattern } from './log-lines'

/** What a piece of a log line is: its Log Level, by how serious, or a timestamp. */
export type Highlight = LogLevel | 'date'

// Timestamps, picked out anywhere in a line: dates, with or without a time, and times alone.
const timestamps = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g

/** A piece of a line, shown one way throughout. */
export interface Segment {
  text: string
  highlight?: Highlight
  /** Part of a search match. */
  match?: boolean
}

interface Span {
  start: number
  end: number
}

/** Where `regex` (global) matches in `text`, in order, leaving out empty matches, which there'd be nothing to show of. */
function spansOf(regex: RegExp, text: string): (Span & { match: RegExpExecArray })[] {
  const spans: (Span & { match: RegExpExecArray })[] = []
  regex.lastIndex = 0
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    if (match[0].length) spans.push({ start: match.index, end: match.index + match[0].length, match })
    else regex.lastIndex++
  }
  return spans
}

/**
 * Where a line's Log Level and its timestamps are, in order, the level winning where a timestamp would overlap it, as
 * the log view and the Large File Viewer alike pick them out.
 */
function highlightsOf(text: string): (Span & { highlight: Highlight })[] {
  const found = logLevelOf(text)
  const level = found?.span ? [{ ...found.span, highlight: found.level }] : []
  const dates = spansOf(timestamps, text)
    .filter(({ start, end }) => level.every((span) => end <= span.start || start >= span.end))
    .map(({ start, end }) => ({ start, end, highlight: 'date' as const }))
  return [...level, ...dates].toSorted((a, b) => a.start - b.start)
}

/** What the log view colours a piece of a log line as: a mark of Polyscope's, a level, a timestamp, a string or a number. */
export type LogToken = Highlight | 'marker' | 'string' | 'number'

const strings = /"(?:[^"\\]|\\.)*"/g
const numbers = /\b\d+(?:\.\d+)?\b/g

/**
 * A line as the log view's tokens, each from where it starts to where the next does: a mark whole, otherwise its Log
 * Level over its timestamps, over its strings, over its numbers.
 */
export function logTokens(line: string): { start: number; token?: LogToken }[] {
  if (!line) return []
  if (markerPattern.test(line)) return [{ start: 0, token: 'marker' }]
  const painted: (LogToken | undefined)[] = Array.from({ length: line.length })
  const paint = <S extends Span>(spans: S[], token: (span: S) => LogToken) => {
    for (const span of spans) painted.fill(token(span), span.start, span.end)
  }
  paint(spansOf(numbers, line), () => 'number')
  paint(spansOf(strings, line), () => 'string')
  paint(highlightsOf(line), (span) => span.highlight)
  return painted.flatMap((token, i) => (i === 0 || token !== painted[i - 1] ? [{ start: i, ...(token && { token }) }] : []))
}

/**
 * A line in pieces, as the Large File Viewer shows it: its Log Level and timestamps picked out, and where
 * `search` (a global regular expression) matches, marked over them.
 */
export function highlightLine(text: string, search?: RegExp | null): Segment[] {
  const rules = highlightsOf(text)
  const matches = search ? spansOf(search, text) : []
  const cuts = [...new Set([0, text.length, ...[...rules, ...matches].flatMap(({ start, end }) => [start, end])])].toSorted((a, b) => a - b)
  const segments: Segment[] = []
  let rule = 0
  let found = 0
  for (let i = 0; i < cuts.length - 1; i++) {
    const [start, end] = [cuts[i]!, cuts[i + 1]!]
    while (rules[rule] && rules[rule]!.end <= start) rule++
    while (matches[found] && matches[found]!.end <= start) found++
    const highlight = rules[rule] && rules[rule]!.start <= start ? rules[rule]!.highlight : undefined
    const match = Boolean(matches[found] && matches[found]!.start <= start)
    segments.push({ text: text.slice(start, end), ...(highlight && { highlight }), ...(match && { match }) })
  }
  return segments
}
