import { logLevelOf, logLevels, type LogLevel } from './log-level'
import { isMarker } from './log-lines'

/** How many Log Entries a log has of each Log Level. */
export type LevelCounts = Record<LogLevel, number>

/**
 * A log view's lines, grouped into Log Entries: a line with a Log Level and the lines after it with none, up to the
 * next with one, or a mark. A Level Filter hides whole Log Entries.
 */
export class LogEntries {
  private lines: string[] = []
  // Each line's Log Entry's Log Level; none for a line in no Log Entry.
  private levels: (LogLevel | undefined)[] = []
  // Whether each line is a Log Entry's first.
  private starts: boolean[] = []
  // Where in the lines each shown one is.
  private shownAt: number[] = []
  // How many Log Entries of each Log Level there are, kept as lines come and go rather than counted each time.
  private tally = Object.fromEntries(logLevels.map((level) => [level, 0])) as LevelCounts
  private hidden: ReadonlySet<LogLevel>

  constructor(lines: readonly string[], hidden: readonly LogLevel[] = []) {
    this.hidden = new Set(hidden)
    this.append(lines)
  }

  /** Shows only the Log Entries of the Log Levels not `hidden`, and the lines in none. */
  filter(hidden: readonly LogLevel[]) {
    this.hidden = new Set(hidden)
    this.shownAt = this.lines.flatMap((_, i) => (this.isHidden(i) ? [] : [i]))
  }

  /** How many lines there are, shown or hidden. */
  get length(): number {
    return this.lines.length
  }

  /** How many lines the Level Filter shows. */
  get shownCount(): number {
    return this.shownAt.length
  }

  /** The lines the Level Filter shows. */
  get shown(): string[] {
    return this.shownAt.map((i) => this.lines[i]!)
  }

  /** The number in the whole log of the shown line numbered `line`, both counting from 1. */
  numberOf(line: number): number {
    return (this.shownAt[line - 1] ?? line - 1) + 1
  }

  /**
   * The shown line, counting from 1, at the line numbered `number` in the whole log, or the first shown after it, or
   * the last shown; none if none is.
   */
  lineAt(number: number): number | undefined {
    if (this.shownAt.length === 0) return undefined
    const after = this.shownAt.findIndex((i) => i >= number - 1)
    return (after === -1 ? this.shownAt.length - 1 : after) + 1
  }

  /** How many Log Entries of each Log Level there are, shown or hidden. */
  get counts(): LevelCounts {
    return { ...this.tally }
  }

  /** Adds lines at the end, going on with the last Log Entry; those of them the Level Filter shows. */
  append(lines: readonly string[]): string[] {
    const shown: string[] = []
    let level = this.levels.at(-1)
    for (const line of lines) {
      // A mark ends a Log Entry: what comes after it, like a restarted container's first lines, isn't part of it.
      const mark = isMarker(line)
      const own = mark ? undefined : logLevelOf(line)?.level
      level = mark ? undefined : (own ?? level)
      const i = this.lines.push(line) - 1
      this.levels.push(level)
      this.starts.push(own !== undefined)
      if (own) this.tally[own]++
      if (this.isHidden(i)) continue
      this.shownAt.push(i)
      shown.push(line)
    }
    return shown
  }

  /**
   * Adds lines read further back at the start, their last Log Entry going on into the first lines, which were in none.
   * How the lines shown change at the start: the first `removed` of them go, as the Log Entry they're now in is hidden,
   * and `added` go before what's left.
   */
  prepend(lines: readonly string[]): { added: string[]; removed: number } {
    const earlier = new LogEntries(lines, [...this.hidden])
    const level = earlier.levels.at(-1)
    let removed = 0
    if (level !== undefined) {
      for (let i = 0; i < this.lines.length && this.levels[i] === undefined && !isMarker(this.lines[i]!); i++) {
        this.levels[i] = level
        if (this.hidden.has(level)) removed++
      }
    }
    const count = earlier.lines.length
    this.lines = [...earlier.lines, ...this.lines]
    this.levels = [...earlier.levels, ...this.levels]
    this.starts = [...earlier.starts, ...this.starts]
    this.shownAt = [...earlier.shownAt, ...this.shownAt.slice(removed).map((i) => i + count)]
    for (const level of logLevels) this.tally[level] += earlier.tally[level]
    return { added: earlier.shown, removed }
  }

  /**
   * Drops the first `count` lines, what's left of a Log Entry staying in it, and counted still, starting with its first
   * line left; how many of them were shown.
   */
  dropFirst(count: number): number {
    this.lines.splice(0, count)
    const levels = this.levels.splice(0, count)
    this.starts.splice(0, count).forEach((start, i) => start && this.tally[levels[i]!]--)
    const first = this.levels[0]
    if (first !== undefined && !this.starts[0]) {
      this.starts[0] = true
      this.tally[first]++
    }
    const dropped = this.shownAt.findIndex((i) => i >= count)
    const shownDropped = dropped === -1 ? this.shownAt.length : dropped
    this.shownAt = this.shownAt.slice(shownDropped).map((i) => i - count)
    return shownDropped
  }

  private isHidden(i: number) {
    const level = this.levels[i]
    return level !== undefined && this.hidden.has(level)
  }
}
