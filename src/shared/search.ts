// How a Large File search's pattern is read, the same in the core (which searches the file) and the
// renderer (which highlights the matches in the lines it shows).

import type { LargeFileSearchQuery } from './core-api'

/**
 * The regular expression a search looks for, or why it can't be one: a blank pattern, or one that isn't a
 * regular expression. `global` finds every match in a line, rather than just the first.
 */
export function searchRegExp({ pattern, matchCase = false }: LargeFileSearchQuery, global = false): RegExp | { problem: string } {
  if (!pattern) return { problem: 'The pattern is empty' }
  try {
    return new RegExp(pattern, `${matchCase ? '' : 'i'}${global ? 'g' : ''}`)
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}
