import { largeFileSearchLimit, type LargeFileEncoding, type LargeFileMatch, type LargeFileSearchUpdate } from '@shared/core-api'
import { CoreError } from './core-error'
import { chunksOf, decodeShortLine, largeFileReading, lineBuilder, type LargeFileContent } from './large-file'

const lineBreak = 0x0a

/** How much of a matching line a search reports. */
const largeFileSearching = {
  /** Characters shown before the first match, so it's seen in context. */
  previewBefore: 40,
  /** The most characters of a line a match shows. */
  previewLength: 240
}

/** A piece of a matching line, `text`, around its first match, `match`. */
function matchOf(line: number, text: string, match: RegExpExecArray): LargeFileMatch {
  const at = match.index
  const from = Math.max(0, at - largeFileSearching.previewBefore)
  const to = Math.min(text.length, from + largeFileSearching.previewLength)
  return { line, preview: text.slice(from, to), start: at - from, end: Math.min(at + match[0].length, to) - from }
}

interface SearchLinesOptions {
  /** Checked before each chunk: once true, nothing more is read or reported. */
  stopped(): boolean
  /** Told the matching lines found in each chunk, in order, and how many bytes have been read after it. */
  found(matches: LargeFileMatch[], scannedBytes: number): void
}

/**
 * Searches a file, given as chunks of its bytes, for lines `regex` matches: each line as the Large File
 * Viewer shows it, without its line break and cut short if it's too long. Matching lines past
 * largeFileSearchLimit are counted, not reported. Null if it was stopped first.
 */
async function searchLines(chunks: AsyncIterable<Uint8Array>, encoding: LargeFileEncoding, regex: RegExp, options: SearchLinesOptions) {
  // A line that runs on from one chunk into the next.
  const line = lineBuilder(encoding)
  let lineNumber = 0
  let matchedLines = 0
  let scannedBytes = 0
  let found: LargeFileMatch[] = []

  const test = (text: string) => {
    const match = regex.exec(text)
    if (match) {
      if (matchedLines < largeFileSearchLimit) found.push(matchOf(lineNumber, text, match))
      matchedLines++
    }
    lineNumber++
  }

  for await (const bytes of chunks) {
    if (options.stopped()) return null
    let start = 0
    for (let at = bytes.indexOf(lineBreak); at >= 0; at = bytes.indexOf(lineBreak, start)) {
      // Most lines are short and in one chunk, so are decoded where they are rather than copied first.
      if (line.empty && at - start <= largeFileReading.maxLineBytes) test(decodeShortLine(bytes.subarray(start, at), encoding))
      else {
        line.add(bytes.subarray(start, at))
        test(line.take())
      }
      start = at + 1
    }
    if (start < bytes.length) line.add(bytes.subarray(start))
    scannedBytes += bytes.length
    options.found(found, scannedBytes)
    found = []
  }
  if (options.stopped()) return null
  // The file's last line, which has no line break to end it.
  if (!line.empty) {
    test(line.take())
    options.found(found, scannedBytes)
  }
  return { matchedLines, limited: matchedLines > largeFileSearchLimit, scannedBytes }
}

/** A search under way. */
export interface LargeFileSearch {
  /** Stops it; nothing more is reported. */
  cancel(): void
}

/**
 * Searches a ready Large File's content in the background, from its start, telling `onUpdate` its matches
 * and progress (at most every largeFileReading.progressInterval), then that it's done, or failed.
 */
export function searchLargeFile(content: LargeFileContent, regex: RegExp, onUpdate: (update: LargeFileSearchUpdate) => void): LargeFileSearch {
  const totalBytes = content.length
  let stopped = false
  let pending: LargeFileMatch[] = []
  let lastUpdate = 0

  const report = (scannedBytes: number) => {
    lastUpdate = Date.now()
    onUpdate({ kind: 'progress', scannedBytes, totalBytes, matches: pending })
    pending = []
  }

  const run = async () => {
    try {
      const result = await searchLines(chunksOf(content.read, totalBytes), content.encoding, regex, {
        stopped: () => stopped,
        found: (matches, scannedBytes) => {
          pending.push(...matches)
          if (Date.now() - lastUpdate >= largeFileReading.progressInterval) report(scannedBytes)
        }
      })
      if (!result || stopped) return
      report(result.scannedBytes)
      onUpdate({ kind: 'done', matchedLines: result.matchedLines, limited: result.limited })
    } catch (error) {
      if (stopped) return
      const failure = error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
      onUpdate({ kind: 'failed', code: failure.code, message: failure.message })
    }
  }

  void run()

  return {
    cancel() {
      stopped = true
    }
  }
}
