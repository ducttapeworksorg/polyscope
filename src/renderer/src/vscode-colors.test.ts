import { describe, expect, it } from 'vitest'
import { editorColors, hexColor, themeOfKind } from './vscode-colors'

describe('hexColor', () => {
  it('keeps hex colours, lowercased and in full', () => {
    expect(hexColor('#1F1F1F')).toBe('#1f1f1f')
    expect(hexColor('#264f7840')).toBe('#264f7840')
    expect(hexColor('#fff')).toBe('#ffffff')
    expect(hexColor(' #abcd ')).toBe('#aabbccdd')
  })

  it('turns rgb() and rgba() colours, as VS Code gives translucent ones, into hex', () => {
    expect(hexColor('rgb(30, 30, 30)')).toBe('#1e1e1e')
    expect(hexColor('rgba(38, 79, 120, 0.25)')).toBe('#264f7840')
    expect(hexColor('rgba(255, 255, 255, 1)')).toBe('#ffffffff')
  })

  it('refuses anything else', () => {
    expect(hexColor('transparent')).toBeNull()
    expect(hexColor('Consolas, monospace')).toBeNull()
    expect(hexColor('14px')).toBeNull()
    expect(hexColor('#12345')).toBeNull()
  })
})

describe('editorColors', () => {
  it('names each of VS Code’s colour variables by the colour it sets, as Monaco knows them too', () => {
    expect(
      editorColors([
        ['--vscode-editor-background', '#1f1f1f'],
        ['--vscode-editorLineNumber-activeForeground', '#cccccc'],
        ['--vscode-editor-selectionBackground', 'rgba(38, 79, 120, 0.25)'],
        ['--vscode-focusBorder', '#0078d4']
      ])
    ).toEqual({
      'editor.background': '#1f1f1f',
      'editorLineNumber.activeForeground': '#cccccc',
      'editor.selectionBackground': '#264f7840',
      focusBorder: '#0078d4'
    })
  })

  it('leaves out what isn’t a colour, or isn’t VS Code’s', () => {
    expect(
      editorColors([
        ['--vscode-editor-font-family', 'Consolas, monospace'],
        ['--vscode-font-size', '13px'],
        ['--slate-900', '#171d29'],
        ['color', '#ffffff']
      ])
    ).toEqual({})
  })
})

describe('themeOfKind', () => {
  it('picks the light or dark Polyscope colours a VS Code theme kind needs', () => {
    expect(themeOfKind('vscode-light')).toBe('light')
    expect(themeOfKind('vscode-high-contrast-light')).toBe('light')
    expect(themeOfKind('vscode-dark')).toBe('dark')
    expect(themeOfKind('vscode-high-contrast')).toBe('dark')
    expect(themeOfKind(undefined)).toBe('dark')
  })
})
