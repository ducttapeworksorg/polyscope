import { describe, expect, it } from 'vitest'
import { ansiStripper, stripAnsi } from './ansi'

const esc = '\x1b'

// Each escape sequence and the text it leaves, the same whether stripped from a string or from bytes.
const cases: [string, string, string][] = [
  ['SGR colours', `${esc}[1;31mERROR${esc}[0m disk full`, 'ERROR disk full'],
  ['an SGR reset with no parameters', `a${esc}[mb`, 'ab'],
  ['erasing a line', `${esc}[2Kdone`, 'done'],
  ['moving the cursor', `up${esc}[3Adown`, 'updown'],
  ['private CSI parameters', `${esc}[?25lhidden`, 'hidden'],
  ['an OSC ended by BEL', `${esc}]0;title\x07text`, 'text'],
  ['an OSC ended by ESC \\', `${esc}]0;title${esc}\\text`, 'text'],
  ['an OSC 8 hyperlink, keeping its text', `see ${esc}]8;;https://example.com${esc}\\the docs${esc}]8;;${esc}\\ now`, 'see the docs now'],
  ['two-character sequences', `a${esc}7b${esc}8c${esc}Md`, 'abcd'],
  ['a character set choice', `${esc}(Bplain`, 'plain'],
  ['a sequence at the end', `cut${esc}[3`, 'cut'],
  ['a carriage return, left as it is', 'progress 10%\rprogress 20%', 'progress 10%\rprogress 20%'],
  ['text without escapes, left as it is', 'plain [32m text', 'plain [32m text']
]

describe('stripAnsi', () => {
  it.each(cases)('removes %s', (_what, text, stripped) => {
    expect(stripAnsi(text)).toBe(stripped)
  })

  it('never runs a sequence on past the end of a line', () => {
    expect(stripAnsi(`a${esc}]0;unended\nnext ${esc}[31\nlast`)).toBe('a\nnext \nlast')
  })

  it('keeps text in any script', () => {
    expect(stripAnsi(`${esc}[32mготово ✓${esc}[0m`)).toBe('готово ✓')
  })
})

describe('an ANSI stripper of bytes', () => {
  /** What a stripper keeps of `text`'s UTF-8 bytes, given in two pieces split at `at`. */
  const strippedInTwo = (text: string, at: number) => {
    const bytes = Buffer.from(text)
    const stripper = ansiStripper()
    const kept = [stripper.strip(bytes.subarray(0, at)), stripper.strip(bytes.subarray(at))]
    return Buffer.concat(kept).toString()
  }

  it.each(cases)('removes %s, however its bytes come', (_what, text, stripped) => {
    for (let at = 0; at <= Buffer.byteLength(text); at++) expect(strippedInTwo(text, at)).toBe(stripped)
  })

  it('keeps text in any script, however its bytes come', () => {
    const text = '\x1b[32mготово ✓\x1b[0m'
    for (let at = 0; at <= Buffer.byteLength(text); at++) expect(strippedInTwo(text, at)).toBe('готово ✓')
  })

  it('starts each line afresh once reset', () => {
    const stripper = ansiStripper()
    stripper.strip(Buffer.from('cut\x1b[3'))
    stripper.reset()
    expect(Buffer.from(stripper.strip(Buffer.from('1mnext'))).toString()).toBe('1mnext')
  })

  it('gives bytes without escapes back as they are', () => {
    const bytes = Buffer.from('plain')
    expect(ansiStripper().strip(bytes)).toBe(bytes)
  })
})
