/** What a piece of a log line is: a log level, by how serious, or a timestamp. */
export type Highlight = 'error' | 'warning' | 'info' | 'debug' | 'date'

/** The log levels and timestamps picked out in log lines, in the log view and the Large File Viewer alike. */
export const logRules: readonly (readonly [RegExp, Highlight])[] = [
  [/\b(?:FATAL|CRITICAL|CRIT|SEVERE|PANIC|ERROR|ERR|EXCEPTION)\b/, 'error'],
  [/\b(?:WARNING|WARN)\b/, 'warning'],
  [/\b(?:INFO|NOTICE)\b/, 'info'],
  [/\b(?:DEBUG|TRACE|VERBOSE)\b/, 'debug'],
  [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/, 'date'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/, 'date']
]

// Every rule at once, each its own group, the first to match at a place winning, as in the log view. A rule's
// group is found by its place, so the rules themselves mustn't capture: (?:…) only.
const anyRule = new RegExp(logRules.map(([rule]) => `(${rule.source})`).join('|'), 'g')

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
 * A line in pieces, as the Large File Viewer shows it: its log levels and timestamps picked out, and where
 * `search` (a global regular expression) matches, marked over them.
 */
export function highlightLine(text: string, search?: RegExp | null): Segment[] {
  const rules = spansOf(anyRule, text).map(({ start, end, match }) => ({ start, end, highlight: logRules[match.findIndex((group, i) => i > 0 && group !== undefined) - 1]![1] }))
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
