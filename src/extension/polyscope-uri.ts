import { Uri } from 'vscode'
import type { SourcePath } from '@shared/core-api'

/** The URI scheme of files opened from Polyscope in VS Code's editor. */
export const polyscopeScheme = 'polyscope'

/** The query marking a URI as a Log Stream's (or Previous Log's) snapshot rather than a file. */
const logQuery = 'log'

/** A file of a Source as VS Code's editor sees it: `polyscope://<Source id>/<path in the Source>`. */
export const polyscopeUri = (sourceId: string, path: SourcePath) => Uri.from({ scheme: polyscopeScheme, authority: sourceId, path: `/${path}` })

/** A snapshot of a Log Stream or Previous Log as VS Code's editor sees it: `polyscope://<Source id>/<path in the Source>?log`. */
export const polyscopeLogUri = (sourceId: string, path: SourcePath) => polyscopeUri(sourceId, path).with({ query: logQuery })

/** The Source and path a `polyscope` URI names, and whether it's a log's snapshot. */
export const locationOf = (uri: Uri) => ({ sourceId: uri.authority, path: uri.path.replace(/^\/+/, ''), log: uri.query === logQuery })
