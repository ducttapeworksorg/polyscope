import type { Theme } from '@shared/settings'
import { logTokenRules, monaco } from './monaco'
import { editorColors, themeOfKind, type VsCodeThemeKind } from './vscode-colors'

/** Switches the app chrome (styles/app.css) and every editor to `theme` at once. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
  monaco.editor.setTheme(`polyscope-${theme}`)
}

const monacoBases: Record<VsCodeThemeKind, monaco.editor.BuiltinTheme> = {
  'vscode-light': 'vs',
  'vscode-dark': 'vs-dark',
  'vscode-high-contrast': 'hc-black',
  'vscode-high-contrast-light': 'hc-light'
}

/** The CSS variables VS Code sets on a webview's page, one for each of its theme's colours, fonts and sizes. */
function vsCodeVariables(): [string, string][] {
  const { style } = document.documentElement
  return [...style].map((name) => [name, style.getPropertyValue(name)])
}

/**
 * In an Extension Copy's webview: shows VS Code's theme, and again whenever it changes. The chrome takes VS Code's
 * colours (extension/webview.css) and the editors a theme of them, while the colours that carry meaning (status,
 * log levels, Environments) stay Polyscope's own, light or dark to go with it. Tells `listener` which of those it is.
 * Returns what stops following.
 */
export function followVsCodeTheme(listener: (theme: Theme) => void): () => void {
  const show = () => {
    const kind = document.body.dataset['vscodeThemeKind'] as VsCodeThemeKind | undefined
    const theme = themeOfKind(kind)
    document.documentElement.dataset['theme'] = theme
    monaco.editor.defineTheme('polyscope-vscode', {
      base: (kind && monacoBases[kind]) ?? 'vs-dark',
      inherit: true,
      rules: logTokenRules[theme],
      colors: editorColors(vsCodeVariables())
    })
    monaco.editor.setTheme('polyscope-vscode')
    listener(theme)
  }
  show()
  // VS Code names the new theme's kind on the body, and sets its colours on the page's root.
  const observer = new MutationObserver(show)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}
