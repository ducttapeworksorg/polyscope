import { EventEmitter, ThemeColor, type FileDecoration, type FileDecorationProvider, type Uri } from 'vscode'
import type { Core } from '../main/core/core'
import { environmentOf } from '../renderer/src/environments'
import { environmentColorId } from './environment-colors'
import { locationOf, polyscopeScheme } from './polyscope-uri'

/** Decorates `polyscope` files, and so their tabs, with their Source's Environment; told when Sources change. */
export interface TabDecorations extends FileDecorationProvider {
  /** A Source or an Environment changed: every `polyscope` file is decorated again. */
  refresh(): void
  dispose(): void
}

/**
 * Tints each `polyscope` file's tab, and its name wherever VS Code shows it, with its Source's Environment colour (or
 * the nearest VS Code can show, see environment-colors.ts), and names the Environment in its tooltip.
 */
export function createTabDecorations(core: Core): TabDecorations {
  const changed = new EventEmitter<undefined>()
  return {
    onDidChangeFileDecorations: changed.event,

    async provideFileDecoration(uri: Uri): Promise<FileDecoration | undefined> {
      if (uri.scheme !== polyscopeScheme) return undefined
      const { sourceId } = locationOf(uri)
      const [sources, environments] = await Promise.all([core.listSources(), core.listEnvironments()])
      const source = sources.find(({ id }) => id === sourceId)
      const environment = source && environmentOf(environments, source)
      if (!environment) return undefined
      return { color: new ThemeColor(environmentColorId(environment.color)), tooltip: environment.name }
    },

    refresh: () => changed.fire(undefined),
    dispose: () => changed.dispose()
  }
}
