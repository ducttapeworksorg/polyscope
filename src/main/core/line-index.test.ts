import { describe, expect, it } from 'vitest'
import { createLineIndex } from './line-index'

const bytes = (text: string) => new TextEncoder().encode(text)

/** Indexes `text` fed in pieces of `piece` bytes, checkpointing every `every` lines. */
function indexOf(text: string, { every = 2, piece = Infinity } = {}) {
  const index = createLineIndex(every)
  const all = bytes(text)
  for (let at = 0; at < all.length; at += Math.min(piece, all.length)) index.add(all.subarray(at, at + piece))
  index.finish()
  return { index, all }
}

/** The line starting where `locate` says, found the way a reader would: from the checkpoint, skipping lines. */
function lineAt(all: Uint8Array, { offset, skip }: { offset: number; skip: number }) {
  const text = new TextDecoder().decode(all.subarray(offset))
  return text.split('\n')[skip]
}

describe('a line-offset index', () => {
  it('counts lines, a final line break not starting another', () => {
    expect(indexOf('').index.lineCount).toBe(0)
    expect(indexOf('one').index.lineCount).toBe(1)
    expect(indexOf('one\n').index.lineCount).toBe(1)
    expect(indexOf('one\ntwo').index.lineCount).toBe(2)
    expect(indexOf('\n\n\n').index.lineCount).toBe(3)
  })

  it('finds every line, however the bytes were split as they came', () => {
    const text = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`).join('\n')
    for (const piece of [1, 2, 3, 7, 64]) {
      for (const every of [1, 2, 5, 100]) {
        const { index, all } = indexOf(text, { every, piece })
        expect(index.lineCount).toBe(23)
        for (let line = 0; line < 23; line++) expect(lineAt(all, index.locate(line))).toBe(`line ${line + 1}`)
      }
    }
  })

  it('keeps one offset per checkpoint, not one per line', () => {
    const { index } = indexOf('a\n'.repeat(1000), { every: 100 })

    expect(index.checkpoints).toBe(10)
    expect(index.locate(250)).toEqual({ offset: 400, skip: 50 })
  })

  it('knows how many bytes it has seen', () => {
    const { index } = indexOf('one\ntwo\n', { piece: 3 })

    expect(index.length).toBe(8)
  })

  it('refuses lines it doesn’t have', () => {
    const { index } = indexOf('one\ntwo')

    expect(() => index.locate(2)).toThrow(RangeError)
    expect(() => index.locate(-1)).toThrow(RangeError)
    expect(() => index.locate(0.5)).toThrow(RangeError)
  })
})
