import { Uri } from 'vscode'
import type { SourcePath } from '@shared/core-api'

/** The URI scheme of files opened from Polyscope in VS Code's editor. */
export const polyscopeScheme = 'polyscope'

/**
 * What a `polyscope` URI's query says, as JSON: the Source's name, for the manifest's label formatter to describe
 * its tabs by (`${query.source}`), and whether it's a Log Stream's (or Previous Log's) snapshot rather than a file.
 */
interface Query {
  source?: string
  log?: true
}

const queryOf = (uri: Uri): Query => {
  try {
    const query: unknown = JSON.parse(uri.query)
    return typeof query === 'object' && query !== null ? (query as Query) : {}
  } catch {
    return {}
  }
}

const withQuery = (uri: Uri, query: Query) => {
  const json = JSON.stringify(query)
  return json === '{}' ? uri : uri.with({ query: json })
}

const uriOf = (sourceId: string, path: SourcePath) => Uri.from({ scheme: polyscopeScheme, authority: sourceId, path: `/${path}` })

/**
 * A file of a Source as VS Code's editor sees it: `polyscope://<Source id>/<path in the Source>`, with the Source's
 * name in its query to label its tab by. A URI without the name still names the file.
 */
export const polyscopeUri = (sourceId: string, path: SourcePath, sourceName?: string) =>
  withQuery(uriOf(sourceId, path), { source: sourceName })

/** A snapshot of a Log Stream or Previous Log as VS Code's editor sees it: a file's URI, marked as a log's in its query. */
export const polyscopeLogUri = (sourceId: string, path: SourcePath, sourceName?: string) =>
  withQuery(uriOf(sourceId, path), { source: sourceName, log: true })

/** The Source and path a `polyscope` URI names, and whether it's a log's snapshot. */
export const locationOf = (uri: Uri) => ({ sourceId: uri.authority, path: uri.path.replace(/^\/+/, ''), log: queryOf(uri).log === true })
