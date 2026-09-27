import { promisify } from 'node:util'
import { gunzip, zstdDecompress } from 'node:zlib'
import { textEncodings, type Compression, type TextEncoding } from '@shared/core-api'
import { MB } from '@shared/settings'
import { CoreError } from './core-error'

const decompressors: Record<Compression, (bytes: Uint8Array, options: { maxOutputLength: number }) => Promise<Buffer>> = {
  gzip: promisify(gunzip),
  zstd: promisify(zstdDecompress)
}
const compressionByExtension: Record<string, Compression> = { '.gz': 'gzip', '.zst': 'zstd' }

/**
 * Undoes a file's compression, going by its extension. Returns the name of what's inside (the
 * name without that extension) and its bytes; a file that isn't compressed comes back as it was.
 */
export async function decompress(name: string, bytes: Uint8Array, maxLength: number) {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  const compression = compressionByExtension[extension]
  if (!compression || name.length === extension.length) return { innerName: name, bytes }
  try {
    const inner = await decompressors[compression](bytes, { maxOutputLength: maxLength })
    return { innerName: name.slice(0, -extension.length), bytes: new Uint8Array(inner), compression }
  } catch (error) {
    const tooLarge = error instanceof RangeError
    const message = tooLarge ? `${name} decompresses to more than ${Math.floor(maxLength / MB)} MB` : `${name} isn’t valid ${compression} data`
    throw new CoreError('DECOMPRESSION_FAILED', message)
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
const binarySniffLength = 8000

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
