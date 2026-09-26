import type { Theme } from '@shared/settings'
import { monaco } from './monaco'

/** Switches the app chrome (styles/app.css) and every editor to `theme` at once. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
  monaco.editor.setTheme(`polyscope-${theme}`)
}
