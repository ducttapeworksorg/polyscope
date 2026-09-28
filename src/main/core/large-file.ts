import { open } from 'node:fs/promises'
import type { Compression, LargeFileEncoding, LargeFileLines, LargeFileStatus, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import { inflate } from './file-content'
import type { ByteRange, FileSource } from './file-source'
import type { CacheEntry, LargeFileCache, CacheWriter } from './large-file-cache'
import { createLineIndex } from './line-index'

const lineBreak = 0x0a
const carriageReturn = 0x0d

/** Sizes, in bytes and lines, that a Large File is read in. */
export const largeFileReading = {
  /** Read back from the end to open it: enough lines to fill a screen many times over, quickly. */
  lastLinesBytes: 256 * 1024,
  /** The most of its last lines it opens with. */
  lastLinesCount: 1_000,
  /** Each read while caching. */
  cacheChunk: 4 * 1024 * 1024,
  /** Each read while reading lines. */
  lineChunk: 64 * 1024,
  /** A line longer than this is cut short: it's more than can be read on screen, and would slow the view. */
  maxLineBytes: 16 * 1024,
  /** The most lines one readLargeFileLines gives. */
  maxLinesPerRead: 10_000,
  /** The least time between progress updates, in milliseconds. */
  progressInterval: 100
}

const decoders: Record<LargeFileEncoding, TextDecoder> = { 'utf-8': new TextDecoder('utf-8'), latin1: new TextDecoder('latin1') }

/** Buffer's 'latin1' is ISO 8859-1 byte for byte; TextDecoder's would be windows-1252. */
const decodeLine = (bytes: Uint8Array, encoding: LargeFileEncoding) =>
  encoding === 'latin1' ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1') : decoders[encoding].decode(bytes)

/** A whole line's bytes, no longer than is shown, decoded without a Windows line end's carriage return. */
export const decodeShortLine = (bytes: Uint8Array, encoding: LargeFileEncoding) =>
  decodeLine(bytes.at(-1) === carriageReturn ? bytes.subarray(0, -1) : bytes, encoding)

/** Collects a line's bytes as they come, keeping only as many as are shown. */
export function lineBuilder(encoding: LargeFileEncoding) {
  let pieces: Uint8Array[] = []
  let length = 0
  let cut = false
  return {
    get empty() {
      return length === 0 && !cut
    },
    add(bytes: Uint8Array) {
      const room = largeFileReading.maxLineBytes - length
      if (bytes.length > room) cut = true
      const kept = bytes.subarray(0, Math.max(0, room))
      if (kept.length) {
        pieces.push(kept)
        length += kept.length
      }
    },
    /** The line so far, decoded without a Windows line end's carriage return; then starts the next. */
    take() {
      const bytes = Buffer.concat(pieces)
      const line = cut ? `${decodeLine(bytes, encoding)}…` : decodeShortLine(bytes, encoding)
      pieces = []
      length = 0
      cut = false
      return line
    }
  }
}

/** Whole lines as lines; a last line break doesn't start another. */
export function splitLines(bytes: Uint8Array, encoding: LargeFileEncoding): string[] {
  const line = lineBuilder(encoding)
  const lines: string[] = []
  let start = 0
  for (let at = bytes.indexOf(lineBreak); at >= 0; at = bytes.indexOf(lineBreak, start)) {
    line.add(bytes.subarray(start, at))
    lines.push(line.take())
    start = at + 1
  }
  if (start < bytes.length) {
    line.add(bytes.subarray(start))
    lines.push(line.take())
  }
  return lines
}

/**
 * The bytes of a file's last lines, read back from its end, starting just after a line break so the first
 * of them is whole. When the last line alone is longer than is read, its end stands for it.
 */
export async function readLastLinesBytes(fileSource: FileSource, path: SourcePath, size: number) {
  const start = Math.max(0, size - largeFileReading.lastLinesBytes)
  const bytes = await fileSource.read(path, { offset: start, length: size - start })
  if (start === 0) return bytes
  const firstBreak = bytes.indexOf(lineBreak)
  return firstBreak < 0 || firstBreak === bytes.length - 1 ? bytes : bytes.subarray(firstBreak + 1)
}

/** A file's last lines, as a Large File opens with: no more of them than largeFileReading.lastLinesCount. */
export const lastLinesOf = (bytes: Uint8Array, encoding: LargeFileEncoding) => splitLines(bytes, encoding).slice(-largeFileReading.lastLinesCount)

/** Reads a range of a file on this computer. */
async function readLocal(path: string, { offset, length }: ByteRange) {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, offset)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  } finally {
    await file.close()
  }
}

/** A file's first `size` bytes, a chunk at a time, noting how far each read got. */
export async function* chunksOf(read: (range: ByteRange) => Promise<Uint8Array>, size: number, progress = (_loaded: number) => {}) {
  for (let offset = 0; offset < size; ) {
    const bytes = await read({ offset, length: Math.min(largeFileReading.cacheChunk, size - offset) })
    // Cut short since it was opened: what's left of it will do.
    if (!bytes.length) return
    offset += bytes.length
    progress(offset)
    yield bytes
  }
}

export interface LargeFileOptions {
  fileSource: FileSource
  path: SourcePath
  /** Its size as stored, when it was opened. */
  size: number
  compression?: Compression
  encoding: LargeFileEncoding
  /** Read where it is rather than cached, as a Local file is on this computer already. Never for a compressed file. */
  inPlace: boolean
  cache: LargeFileCache
  /** Names the file's content, as it is now, in the cache. */
  cacheKey: string
  /** Told each change of status, progress at most every largeFileReading.progressInterval. */
  onStatus(status: LargeFileStatus): void
}

/** A ready Large File's content: `length` bytes (once decompressed), decoded as `encoding`. */
export interface LargeFileContent {
  read(range: ByteRange): Promise<Uint8Array>
  length: number
  encoding: LargeFileEncoding
}

/** A Large File open in a viewer, being cached and indexed, or ready to read. */
export interface OpenLargeFile {
  status(): LargeFileStatus
  readLines(firstLine: number, count: number): Promise<LargeFileLines>
  /** Its content, to read through, once it's ready: LARGE_FILE_NOT_READY before then. */
  content(): LargeFileContent
  /** Stops caching it, if it's still being cached, as failed with `code`. */
  abort(code: CoreError['code'], message: string): void
  /** Stops caching it, and lets its cached copy go. */
  close(): void
}

/**
 * Starts caching a Large File in the background, indexing its lines as they come; once done, its lines
 * are read from the cache (or, in place, from the file itself). Caching fails (leaving what the viewer
 * showed) if the file can't be read, or won't fit in the cache.
 */
export function openLargeFile(options: LargeFileOptions): OpenLargeFile {
  const { fileSource, path, size, compression, encoding, cache, onStatus } = options
  const index = createLineIndex()
  let status: LargeFileStatus = { state: 'caching', loadedBytes: 0, totalBytes: size }
  let stopped = false
  let entry: CacheEntry | undefined
  let read: ((range: ByteRange) => Promise<Uint8Array>) | undefined
  let lastProgress = 0

  const settle = (next: LargeFileStatus) => {
    status = next
    onStatus(next)
  }

  const progress = (loadedBytes: number, totalBytes: number) => {
    status = { state: 'caching', loadedBytes, totalBytes }
    const now = Date.now()
    if (now - lastProgress < largeFileReading.progressInterval) return
    lastProgress = now
    onStatus(status)
  }

  const run = async () => {
    let writer: CacheWriter | undefined
    try {
      let chunks: AsyncIterable<Uint8Array>
      let from: (range: ByteRange) => Promise<Uint8Array>
      const fromSource = (range: ByteRange) => fileSource.read(path, range)
      const hit = options.inPlace ? null : await cache.open(options.cacheKey)
      if (stopped) return hit?.release()
      if (options.inPlace) {
        from = fromSource
        chunks = chunksOf(fromSource, size, (loaded) => progress(loaded, size))
      } else if (hit) {
        entry = hit
        from = (range) => readLocal(hit.path, range)
        chunks = chunksOf(from, hit.size, (loaded) => progress(loaded, hit.size))
      } else {
        writer = await cache.create(options.cacheKey, compression ? undefined : size)
        const stored = chunksOf(fromSource, size, (loaded) => progress(loaded, size))
        chunks = compression ? inflate(stored, compression, path) : stored
        from = fromSource // until it's cached
      }
      for await (const chunk of chunks) {
        if (stopped) break
        await writer?.write(chunk)
        index.add(chunk)
      }
      if (stopped) return await writer?.abort()
      index.finish()
      if (writer) {
        entry = await writer.commit()
        writer = undefined
        const cached = entry
        from = (range) => readLocal(cached.path, range)
        if (stopped) return entry.release()
      }
      read = from
      settle({ state: 'ready', lineCount: index.lineCount, contentLength: index.length, fromCache: Boolean(hit) })
    } catch (error) {
      await writer?.abort()
      if (stopped) return
      const failure = error instanceof CoreError ? error : new CoreError('UNKNOWN', error instanceof Error ? error.message : String(error))
      stopped = true
      settle({ state: 'failed', code: failure.code, message: failure.message })
    }
  }

  void run()

  const readReady = () => {
    if (status.state !== 'ready' || !read) throw new CoreError('LARGE_FILE_NOT_READY', `${path} is still being cached`)
    return read
  }

  return {
    status: () => status,

    content: () => ({ read: readReady(), length: index.length, encoding }),

    async readLines(firstLine, count) {
      if (!Number.isSafeInteger(firstLine) || firstLine < 0 || !Number.isSafeInteger(count) || count < 1) {
        throw new CoreError('INVALID_RANGE', `Not a line and a number of lines: ${firstLine}, ${count}`)
      }
      const read = readReady()
      const { lineCount } = index
      if (firstLine >= lineCount) return { firstLine: lineCount, lines: [] }
      const wanted = Math.min(count, largeFileReading.maxLinesPerRead, lineCount - firstLine)
      let { offset, skip } = index.locate(firstLine)
      const end = index.length
      const line = lineBuilder(encoding)
      const lines: string[] = []
      while (lines.length < wanted && offset < end) {
        const bytes = await read({ offset, length: Math.min(largeFileReading.lineChunk, end - offset) })
        if (!bytes.length) break
        offset += bytes.length
        let start = 0
        for (let at = bytes.indexOf(lineBreak); lines.length < wanted; at = bytes.indexOf(lineBreak, start)) {
          const piece = bytes.subarray(start, at < 0 ? bytes.length : at)
          if (!skip) line.add(piece)
          if (at < 0) break
          if (skip) skip--
          else lines.push(line.take())
          start = at + 1
        }
      }
      // The file's last line, which has no line break to end it.
      if (lines.length < wanted && !line.empty) lines.push(line.take())
      return { firstLine, lines }
    },

    abort(code, message) {
      if (stopped || status.state !== 'caching') return
      stopped = true
      settle({ state: 'failed', code, message })
    },

    close() {
      stopped = true
      entry?.release()
    }
  }
}
