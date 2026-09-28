import { Readable } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { textEncodings, type Compression, type LargeFileEncoding, type TextEncoding } from '@shared/core-api'
import { MB } from '@shared/settings'
import { CoreError } from './core-error'

const decompressors: Record<Compression, () => NodeJS.ReadWriteStream> = {
  gzip: createGunzip,
  zstd: createZstdDecompress
}
const compressionByExtension: Record<string, Compression> = { '.gz': 'gzip', '.zst': 'zstd' }

/** How a file is compressed, going by its extension, and the name of what's inside (the name without that extension). */
export function compressionOf(name: string): { innerName: string; compression?: Compression } {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  const compression = compressionByExtension[extension]
  if (!compression || name.length === extension.length) return { innerName: name }
  return { innerName: name.slice(0, -extension.length), compression }
}

/**
 * Decompresses `chunks` as they come, so a file is never all in memory at once. Stopping early stops reading
 * `chunks`; data that isn't valid `compression` fails DECOMPRESSION_FAILED, naming the file `name`.
 */
export async function* inflate(chunks: AsyncIterable<Uint8Array>, compression: Compression, name: string): AsyncGenerator<Uint8Array> {
  const input = Readable.from(chunks, { objectMode: false })
  const output = decompressors[compression]()
  // A failed read ends decompression with the read's own error.
  input.once('error', (error) => (output as unknown as Readable).destroy(error))
  input.pipe(output)
  try {
    for await (const chunk of output as AsyncIterable<Buffer>) yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  } catch (error) {
    if (error instanceof CoreError) throw error
    throw new CoreError('DECOMPRESSION_FAILED', `${name} isn’t valid ${compression} data`)
  } finally {
    input.destroy()
    ;(output as unknown as Readable).destroy()
  }
}

const boms: [TextEncoding, number[]][] = [
  ['utf-8', [0xef, 0xbb, 0xbf]],
  ['utf-16le', [0xff, 0xfe]],
  ['utf-16be', [0xfe, 0xff]]
]
/** The encoding whose BOM the bytes start with. UTF-32 LE's BOM starts with UTF-16 LE's, so it's ruled out. */
const bomOf = (bytes: Uint8Array) => {
  const found = boms.find(([, bom]) => bom.every((byte, i) => bytes[i] === byte))
  const utf32 = found?.[0] === 'utf-16le' && bytes[2] === 0 && bytes[3] === 0
  return utf32 ? undefined : found
}

/** How far into a file to look for a NUL byte, the sign of a binary file (as git does). */
export const binarySniffLength = 8000

/** Text encoding by BOM, then UTF-8 if the bytes are valid UTF-8, then Latin-1; null for binary. */
export function detectEncoding(bytes: Uint8Array): TextEncoding | null {
  const bom = bomOf(bytes)
  if (bom) return bom[0]
  if (bytes.subarray(0, binarySniffLength).includes(0)) return null
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'latin1'
  }
}

/** Whether bytes could be UTF-8, a character cut short at their end aside. */
const couldBeUtf8 = (bytes: Uint8Array) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * A Large File's encoding, judged from its first bytes and its last lines, as it's never read whole to
 * open it: UTF-8 if both could be, else Latin-1. Null if it looks binary, or starts with a UTF-16 BOM,
 * as its line feeds can't then be found byte by byte.
 */
export function detectLargeFileEncoding(head: Uint8Array, lastLines: Uint8Array): LargeFileEncoding | null {
  const bom = bomOf(head)?.[0]
  if (bom === 'utf-8') return 'utf-8'
  if (bom || head.subarray(0, binarySniffLength).includes(0)) return null
  return couldBeUtf8(head) && couldBeUtf8(lastLines) ? 'utf-8' : 'latin1'
}

export function checkEncoding(encoding: unknown): TextEncoding {
  if (textEncodings.includes(encoding as TextEncoding)) return encoding as TextEncoding
  throw new CoreError('INVALID_ENCODING', `Unknown encoding: ${String(encoding)}`)
}

/** Decodes bytes as `encoding`, leaving out that encoding's BOM if they start with one. */
export function decode(bytes: Uint8Array, encoding: TextEncoding): string {
  const bom = boms.find(([name]) => name === encoding)?.[1]
  const body = bom && bomOf(bytes)?.[0] === encoding ? bytes.subarray(bom.length) : bytes
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  switch (encoding) {
    case 'utf-8':
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer)
    case 'utf-16le':
      return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(buffer)
    case 'utf-16be': {
      // Swapped into little-endian by hand; a trailing odd byte stays at the end, so it decodes as U+FFFD.
      const swapped = Buffer.from(buffer)
      swapped.subarray(0, swapped.length & ~1).swap16()
      return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(swapped)
    }
    case 'latin1':
      // Buffer's 'latin1' is ISO 8859-1 byte for byte; TextDecoder's would be windows-1252.
      return buffer.toString('latin1')
  }
}

const hex = (byte: number) => byte.toString(16).padStart(2, '0')
const printable = (byte: number) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')

/** The most bytes a hex dump shows, from the start of the file: about 4.4 MB of text. */
export const hexDumpLimit = MB

/** A hex dump, 16 bytes per line: offset, the bytes in two groups of 8, then those that are printable. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = [...bytes.subarray(offset, offset + 16)]
    const groups = [row.slice(0, 8), row.slice(8)].map((group) => group.map(hex).join(' ')).filter(Boolean)
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${groups.join('  ').padEnd(48)}  |${row.map(printable).join('')}|`)
  }
  return lines.join('\n')
}
