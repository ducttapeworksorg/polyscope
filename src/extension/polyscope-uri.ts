import { Uri } from 'vscode'
import type { SourcePath } from '@shared/core-api'

/** The URI scheme of files opened from Polyscope in VS Code's editor. */
export const polyscopeScheme = 'polyscope'

/** A file of a Source as VS Code's editor sees it: `polyscope://<Source id>/<path in the Source>`. */
export const polyscopeUri = (sourceId: string, path: SourcePath) => Uri.from({ scheme: polyscopeScheme, authority: sourceId, path: `/${path}` })

/** The Source and path a `polyscope` URI names. */
export const locationOf = (uri: Uri) => ({ sourceId: uri.authority, path: uri.path.replace(/^\/+/, '') })
