// ANSI escape sequences, as loggers that colour their console output write them into logs: removed from everything
// Polyscope shows as a log, not shown as colours. Read a character (or byte) at a time, so strings and bytes are read
// alike: what's removed is all ASCII, and a byte of a character in another script is never mistaken for any of it.

/** The byte, and character code, every escape sequence starts with. */
const ESC = 0x1b
const BEL = 0x07
const lineBreak = 0x0a

/** Where in an escape sequence the reading is: outside one, just after its ESC, or in a CSI, nF, OSC or OSC's ESC. */
type EscapeState = 'text' | 'escape' | 'csi' | 'nf' | 'osc' | 'oscEscape'

/** The state after `code`, and whether `code` is text to keep. A line break always is, ending any sequence. */
function step(state: EscapeState, code: number): { next: EscapeState; keep: boolean } {
  if (code === lineBreak) return { next: 'text', keep: true }
  switch (state) {
    case 'text':
      return code === ESC ? { next: 'escape', keep: false } : { next: 'text', keep: true }
    case 'escape':
      if (code === 0x5b) return { next: 'csi', keep: false } // [
      if (code === 0x5d) return { next: 'osc', keep: false } // ]
      if (code === ESC) return { next: 'escape', keep: false }
      if (code >= 0x20 && code <= 0x2f) return { next: 'nf', keep: false } // an intermediate, as in ESC ( B
      if (code >= 0x30 && code <= 0x7e) return { next: 'text', keep: false } // ESC and one character, as ESC 7
      return { next: 'text', keep: true }
    case 'csi':
      // Parameters and intermediates, then a final byte; anything else isn't one, and is kept.
      if (code >= 0x20 && code <= 0x3f) return { next: 'csi', keep: false }
      return { next: 'text', keep: !(code >= 0x40 && code <= 0x7e) }
    case 'nf':
      if (code >= 0x20 && code <= 0x2f) return { next: 'nf', keep: false }
      return { next: 'text', keep: !(code >= 0x30 && code <= 0x7e) }
    case 'osc':
      return code === BEL ? { next: 'text', keep: false } : code === ESC ? { next: 'oscEscape', keep: false } : { next: 'osc', keep: false }
    case 'oscEscape':
      // ESC \ ends it; ESC and anything else starts another sequence.
      return code === 0x5c ? { next: 'text', keep: false } : step('escape', code)
  }
}

/** `text` without its ANSI escape sequences: CSI ones like colours and cursor moves, OSC ones like links, and ESC x. */
export function stripAnsi(text: string): string {
  if (!text.includes('\x1b')) return text
  let state: EscapeState = 'text'
  let kept = ''
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const { next, keep } = step(state, text.charCodeAt(i))
    if (!keep) {
      kept += text.slice(from, i)
      from = i + 1
    }
    state = next
  }
  return kept + text.slice(from)
}

/**
 * Strips ANSI escape sequences from bytes that come in pieces, as one line's do in a Large File, a sequence split
 * between pieces included; reset between lines. Bytes outside any sequence and without an ESC come back as they are.
 */
export function ansiStripper() {
  let state: EscapeState = 'text'
  return {
    strip(bytes: Uint8Array): Uint8Array {
      if (state === 'text' && !bytes.includes(ESC)) return bytes
      const kept = new Uint8Array(bytes.length)
      let length = 0
      for (const byte of bytes) {
        const { next, keep } = step(state, byte)
        if (keep) kept[length++] = byte
        state = next
      }
      return kept.subarray(0, length)
    },
    reset() {
      state = 'text'
    }
  }
}

/** Where the first ESC in `bytes` from `from` on is, an escape sequence perhaps starting there; Infinity if there's none. */
export function escapeAt(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(ESC, from)
  return at < 0 ? Infinity : at
}
