// How an Extension Copy's webviews read VS Code's theme: VS Code sets a CSS variable for each of its theme's colours
// on the page, and names the kind of theme on its body.

import type { Theme } from '@shared/settings'

/** The kinds of theme VS Code tells its webviews about, in their body's `data-vscode-theme-kind`. */
export type VsCodeThemeKind = 'vscode-light' | 'vscode-dark' | 'vscode-high-contrast' | 'vscode-high-contrast-light'

const hexPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const rgbPattern = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i

const byte = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')

/**
 * A CSS colour as Monaco takes it, `#rrggbb` or `#rrggbbaa`, or null if it isn't one. VS Code gives its opaque colours
 * in hex and its translucent ones as `rgba()`.
 */
export function hexColor(css: string): string | null {
  const value = css.trim().toLowerCase()
  if (hexPattern.test(value)) return value.length > 5 ? value : `#${[...value.slice(1)].map((digit) => digit + digit).join('')}`
  const rgb = rgbPattern.exec(value)
  if (!rgb) return null
  const [, r, g, b, alpha] = rgb
  return `#${[r, g, b].map((channel) => byte(Number(channel))).join('')}${alpha === undefined ? '' : byte(Number(alpha) * 255)}`
}

const prefix = '--vscode-'

/**
 * VS Code's theme colours, as Monaco's theme takes them, from the CSS variables VS Code sets: `--vscode-editor-background`
 * is `editor.background`, the first `.` of a colour's name having become a `-`. Monaco's colours go by the same names.
 */
export function editorColors(variables: Iterable<[name: string, value: string]>): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const [name, value] of variables) {
    if (!name.startsWith(prefix)) continue
    const color = hexColor(value)
    if (color) colors[name.slice(prefix.length).replace('-', '.')] = color
  }
  return colors
}

/** Which of Polyscope's colours, light or dark, go with a kind of VS Code theme: its status colours, icons and log tokens. */
export const themeOfKind = (kind: string | undefined): Theme =>
  kind === 'vscode-light' || kind === 'vscode-high-contrast-light' ? 'light' : 'dark'
