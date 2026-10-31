/** How serious a log line is, its Log Level: one of four, each coloured its own way. */
export type LogLevel = 'error' | 'warning' | 'info' | 'debug'

/** A line's Log Level, and where in the line the word or value saying so is, unless nothing in it does. */
export interface FoundLogLevel {
  level: LogLevel
  span?: { start: number; end: number }
}

// Every wording of a level that loggers write, in lower case, and whether it's one in upper case anywhere (strong) or
// only where it's delimited (weak), as Microsoft.Extensions.Logging's console `fail:` and winston's `http:` are.
const forms = new Map<string, { level: LogLevel; strong: boolean }>(
  (
    [
      ['error', 'error err eror fatal ftl fatl critical crit severe panic exception', 'fail'],
      ['warning', 'warning warn wrn', ''],
      ['info', 'info inf information notice success config', 'http'],
      ['debug', 'debug dbg dbug trace trc verbose vrb verb fine finer finest silly', 'trce']
    ] as const
  ).flatMap(([level, strong, weak]) => [
    ...strong.split(' ').map((form) => [form, { level, strong: true }] as const),
    ...weak.split(' ').filter(Boolean).map((form) => [form, { level, strong: false }] as const)
  ])
)

// How far into a line's own text its level may start.
const reach = 100

// ANSI escape sequences: CSI ones, like colours, and OSC ones, like links.
const escapes = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** `line` without its escape sequences, and where in `line` each of its characters (and its end) is. */
function withoutEscapes(line: string): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  let from = 0
  const keep = (to: number) => {
    for (let i = from; i < to; i++) at.push(i)
    text += line.slice(from, to)
  }
  for (const escape of line.matchAll(escapes)) {
    keep(escape.index)
    from = escape.index + escape[0].length
  }
  keep(line.length)
  at.push(line.length)
  return { text, at }
}

// What a log view may show before a line's own text: its timestamp, as a Log Source gives it or as shown, and a
// `kubectl logs --prefix` style [pod/name/container], in either order.
const shownBefore = /^(?:\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[pod\/[^\]\s]+\])(?=\s))*\s*/

// klog's header, a level letter then the month and day and the time: `E1029 12:00:00.123456`.
const klog = /^([IWEF])(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2}(?:\.\d+)?\b/
const klogLevels: Record<string, LogLevel> = { I: 'info', W: 'warning', E: 'error', F: 'error' }

/** The Log Level `line` has, found as popular loggers write it. */
export function logLevelOf(line: string): FoundLogLevel | undefined {
  const { text, at } = withoutEscapes(line)
  const found = levelIn(text)
  return found && { level: found.level, ...(found.span && { span: { start: at[found.span.start]!, end: at[found.span.end - 1]! + 1 } }) }
}

// A level field, its key in any case, in JSON ("level":"warn") or logfmt (level=warn), its value quoted or not.
const keys = String.raw`level|lvl|severity|@l|loglevel|log\.level|levelname`
const fields = new RegExp(String.raw`"(${keys})"\s*:\s*(?:"([^"\\]*)"|(\d+)\b)|(?:^|[\s,{])(${keys})=(?:"([^"\\]*)"|([^\s",}]+))`, 'gi')
const quoted = /"(?:[^"\\]|\\.)*"/g

// Levels as numbers, on the pino and bunyan scale, said only by these keys.
const keysForNumbers = new Set(['level', 'lvl'])
const pinoLevels: Record<string, LogLevel> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warning', 50: 'error', 60: 'error' }

/**
 * What the first level field in `text` says, a key quoted in a message not being one: its level and where its value
 * is; null if its value is no level, the field still saying the line has none; undefined if there's no level field.
 */
function levelField(text: string): FoundLogLevel | null | undefined {
  const strings = [...text.matchAll(quoted)].map((string) => ({ start: string.index, end: string.index + string[0].length }))
  for (const field of text.matchAll(fields)) {
    const key = (field[1] ?? field[4])!
    const keyAt = field[1] ? field.index : field.index + field[0].indexOf(key)
    if (strings.some(({ start, end }) => start < keyAt && keyAt < end)) continue
    const value = field[2] ?? field[3] ?? field[5] ?? field[6] ?? ''
    const word = value.trim()
    const level = /^\d+$/.test(word) ? (keysForNumbers.has(key.toLowerCase()) ? pinoLevels[word] : undefined) : forms.get(word.toLowerCase())?.level
    if (!level) return null
    const start = field.index + field[0].lastIndexOf(value) + value.indexOf(word)
    return { level, span: { start, end: start + word.length } }
  }
  return undefined
}

// A Serilog CLEF event, its time and its message or message template, which says its level only when not info.
const clef = /"@t"\s*:/
const clefMessage = /"@m(?:t)?"\s*:/
const clefLevel = /"@l"\s*:/

/** The Log Level `text`, a line without escape sequences, has. */
function levelIn(text: string): FoundLogLevel | undefined {
  const field = levelField(text)
  if (field !== undefined) return field ?? undefined
  if (clef.test(text) && clefMessage.test(text) && !clefLevel.test(text)) return { level: 'info' }
  const ownStart = shownBefore.exec(text)![0].length
  const klogLevel = klog.exec(text.slice(ownStart))?.[1]
  if (klogLevel) return { level: klogLevels[klogLevel]!, span: { start: ownStart, end: ownStart + 1 } }
  const words = /[A-Za-z0-9_]+/g
  words.lastIndex = ownStart
  for (let word = words.exec(text); word && word.index < ownStart + reach; word = words.exec(text)) {
    const [form, start, end] = [forms.get(word[0].toLowerCase()), word.index, word.index + word[0].length]
    if (!form) continue
    const upper = word[0] === word[0].toUpperCase()
    const cased = upper || word[0] === word[0].toLowerCase() || word[0] === titleCase(word[0])
    if ((form.strong && upper) || (cased && delimited(text, start, end))) return { level: form.level, span: { start, end } }
  }
  return undefined
}

const titleCase = (word: string) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()

// What may come before a level in brackets: their opening one, padding, and a time, as in Serilog's `[12:00:00 inf]`.
const time = String.raw`(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?`
const bracketed: Record<string, RegExp> = {
  ']': new RegExp(String.raw`\[ *(?:${time} +)?$`),
  ')': new RegExp(String.raw`\( *(?:${time} +)?$`),
  '|': /\| *$/
}

/**
 * Whether the word from `start` to `end` in `text` is set apart as a level, not a word of a message: right before a
 * `:` and a space, or in [], () or ||, padding allowed, as in structlog's `[info     ]` or Serilog's `[12:00:00 inf]`.
 */
function delimited(text: string, start: number, end: number): boolean {
  const after = /^ *(.)(.?)/.exec(text.slice(end))
  if (!after) return false
  const [, next, then] = after
  if (next === ':') return then === '' || then === ' ' || then === '\t'
  return bracketed[next!]?.test(text.slice(0, start)) ?? false
}
