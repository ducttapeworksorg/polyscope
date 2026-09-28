import type { FollowUpdate, LastNLines, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { asCoreError, followTiming, holdBack, type Follow } from './log-follow'

/** How a file Follow reads, in milliseconds and bytes. */
export const fileFollowTiming = {
  /** Between looks at the file for new content. */
  pollInterval: 1_000,
  /** The most read at once, while catching up with a file that grew a lot between looks. */
  maxRead: 4 * 1024 * 1024
}

/** The first read back from a file's end; each one after doubles, up to fileFollowTiming.maxRead. */
const firstChunk = 64 * 1024

const lineBreak = 0x0a
const decoder = new TextDecoder()

/** Text of whole lines as lines, without the carriage returns of Windows line ends. */
const splitLines = (bytes: Uint8Array) => decoder.decode(bytes).split('\n').map((line) => line.replace(/\r$/, ''))

const countBreaks = (bytes: Uint8Array) => bytes.reduce((count, byte) => (byte === lineBreak ? count + 1 : count), 0)

export interface LastLinesOptions {
  /** The file's size: where its end is taken to be. */
  size: number
  lastNLines: LastNLines
  /** Stops looking further back after reading this many bytes, keeping the whole lines found by then. */
  maxBytes: number
}

/** A file's last lines. */
export interface LastLines {
  /** Its last whole lines (each ended by a line break), without their line breaks. */
  lines: string[]
  /** What follows the last line break: a last line not yet ended. */
  partial: string
  /** Where `partial` starts: just after the last line break, where following goes on from. */
  end: number
}

/**
 * A file's last lines, read back from its end a growing chunk at a time until there are enough, so a
 * multi-gigabyte file's are as quick to read as a small one's. Lines are decoded as UTF-8; line breaks are
 * never inside a character, so splitting at them keeps every character whole.
 */
export async function readLastLines(fileSource: FileSource, path: SourcePath, { size, lastNLines, maxBytes }: LastLinesOptions): Promise<LastLines> {
  const wanted = lastNLines === 'all' ? Infinity : lastNLines
  let start = size
  let bytes = new Uint8Array(0)
  let breaks = 0
  let chunk = firstChunk
  // One break more than the lines wanted: the one ending the line before the first of them.
  while (start > 0 && size - start < maxBytes && breaks <= wanted) {
    const length = Math.min(chunk, start, maxBytes - (size - start))
    start -= length
    const read = await fileSource.read(path, { offset: start, length })
    bytes = Buffer.concat([read, bytes])
    breaks += countBreaks(read)
    chunk = Math.min(chunk * 2, fileFollowTiming.maxRead)
  }
  const last = bytes.lastIndexOf(lineBreak)
  // No line break at all: a single line not yet ended, unless it's longer than was read, when where it starts is unknown.
  if (last < 0) return start === 0 ? { lines: [], partial: decoder.decode(bytes), end: 0 } : { lines: [], partial: '', end: size }
  const lines = splitLines(bytes.subarray(0, last))
  // Read from partway through the file, the first line may have started before what was read.
  if (start > 0) lines.shift()
  return { lines: lines.slice(-wanted), partial: decoder.decode(bytes.subarray(last + 1)), end: start + last + 1 }
}

export interface FileFollowOptions {
  /** Where following starts: just after the last whole line already shown. */
  from: number
  /** The identity the file had when that was read, if its File Source tells one. */
  identity?: string
  /** How many lines a paused Follow holds back at most. */
  cap: LastNLines
  emit(update: FollowUpdate): void
}

/**
 * Follows a file in a File Source by looking at it every so often and sending the whole lines added
 * since. A file cut short is marked and followed from its start, and so is another file put in its place
 * (when the File Source tells files apart). A file that can't be read, say gone for now, is marked and
 * tried again with backoff; the Follow ends when the pod the file was in has gone.
 */
export function startFileFollow(fileSource: FileSource, path: SourcePath, options: FileFollowOptions): Follow {
  const hold = holdBack(options.cap, options.emit)
  const { emit } = hold
  let offset = options.from
  let identity = options.identity
  // What was read after the last line break, waiting for the rest of its line.
  let partial = new Uint8Array(0)
  let stopped = false
  let wake: (() => void) | undefined

  const receive = (bytes: Uint8Array) => {
    const text = Buffer.concat([partial, bytes])
    const last = text.lastIndexOf(lineBreak)
    partial = text.subarray(last + 1)
    if (last >= 0) emit({ kind: 'lines', lines: splitLines(text.subarray(0, last)) })
  }

  /** Sends a last line that has no line break, as what it was in is over. */
  const flush = () => {
    if (partial.length) emit({ kind: 'lines', lines: splitLines(partial) })
    partial = new Uint8Array(0)
  }

  /** Waits `ms`, or less if the Follow is stopped meanwhile. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  // Failures in a row; each doubles the wait before trying again.
  let failures = 0

  /** Reads what the file gained since it was last looked at, after marking it if it was cut short or replaced. */
  const catchUp = async () => {
    const info = await fileSource.stat(path)
    if (stopped) return
    if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
    if (failures) emit({ kind: 'recovered' })
    failures = 0
    const replaced = identity !== undefined && info.identity !== undefined && info.identity !== identity
    if (replaced || info.size < offset) {
      flush()
      emit({ kind: replaced ? 'rotated' : 'truncated' })
      offset = 0
    }
    identity = info.identity ?? identity
    while (offset < info.size) {
      const bytes = await fileSource.read(path, { offset, length: Math.min(info.size - offset, fileFollowTiming.maxRead) })
      if (stopped || !bytes.length) return
      offset += bytes.length
      receive(bytes)
    }
  }

  const run = async () => {
    while (!stopped) {
      try {
        await catchUp()
        if (stopped) return
        await sleep(fileFollowTiming.pollInterval)
      } catch (error) {
        if (stopped) return
        const { code, message } = asCoreError(error)
        if (code === 'POD_GONE') {
          flush()
          stopped = true
          return emit({ kind: 'ended', reason: 'gone' })
        }
        const retryIn = Math.min(followTiming.firstRetry * 2 ** failures, followTiming.maxRetry)
        failures++
        emit({ kind: 'failed', code, message, retryIn })
        await sleep(retryIn)
      }
    }
  }

  void run()

  return {
    pause: hold.pause,
    resume: hold.resume,
    stop() {
      stopped = true
      wake?.()
    }
  }
}
