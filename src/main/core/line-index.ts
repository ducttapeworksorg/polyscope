const lineBreak = 0x0a

/** Where to start reading to reach a line: a checkpoint's offset, and how many lines after it the line is. */
export interface LineLocation {
  offset: number
  skip: number
}

export interface LineIndex {
  /** Takes the file's next bytes, in order. */
  add(bytes: Uint8Array): void
  /** Says there are no more bytes; a last line without a line break counts from then on. */
  finish(): void
  /** Lines so far; a final line break doesn't start another, so an empty file has none. */
  readonly lineCount: number
  /** Bytes taken so far. */
  readonly length: number
  /** How many offsets it keeps: one per `every` lines. */
  readonly checkpoints: number
  /** Where line `line` (from 0) can be read from; a RangeError if there's no such line. */
  locate(line: number): LineLocation
}

/**
 * A sparse line-offset index of a file fed to it a chunk at a time: the offset of every `every`th line,
 * so a file of millions of lines takes kilobytes, and any line is reached by reading at most `every`
 * lines from the checkpoint before it.
 */
export function createLineIndex(every = 256): LineIndex {
  let offsets = new Float64Array(1024)
  // Line 0 starts the file; each later checkpoint is noted as the line break before it goes by.
  let noted = 1
  let breaks = 0
  let length = 0
  let afterLastBreak = 0
  let finished = false

  const note = (offset: number) => {
    if (noted === offsets.length) {
      const grown = new Float64Array(offsets.length * 2)
      grown.set(offsets)
      offsets = grown
    }
    offsets[noted++] = offset
  }

  // Bytes after the last line break make a line of their own only once the file is known to end there.
  const lineCount = () => breaks + (finished && length > afterLastBreak ? 1 : 0)

  return {
    add(bytes) {
      if (finished) throw new Error('The index is finished')
      for (let at = bytes.indexOf(lineBreak); at >= 0; at = bytes.indexOf(lineBreak, at + 1)) {
        breaks++
        afterLastBreak = length + at + 1
        if (breaks % every === 0) note(afterLastBreak)
      }
      length += bytes.length
    },
    finish() {
      finished = true
    },
    get lineCount() {
      return lineCount()
    },
    get length() {
      return length
    },
    get checkpoints() {
      return Math.ceil(lineCount() / every)
    },
    locate(line) {
      if (!Number.isInteger(line) || line < 0 || line >= lineCount()) throw new RangeError(`No line ${line}: there are ${lineCount()}`)
      const checkpoint = Math.floor(line / every)
      return { offset: offsets[checkpoint]!, skip: line - checkpoint * every }
    }
  }
}
