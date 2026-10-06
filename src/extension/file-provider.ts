import { Disposable, EventEmitter, FilePermission, FileSystemError, FileType, type FileChangeEvent, type FileSystemProvider, type Uri } from 'vscode'
import type { CoreErrorCode } from '@shared/core-api'
import type { Core } from '../main/core/core'
import { CoreError } from '../main/core/core-error'
import { t } from '../renderer/src/i18n'
import { locationOf } from './polyscope-uri'

/** Reports a core failure as VS Code's file system errors, which its editor knows how to show. */
function asFileSystemError(error: unknown, uri: Uri): FileSystemError {
  if (!(error instanceof CoreError)) return FileSystemError.Unavailable(error instanceof Error ? error.message : String(error))
  const message = t(`error.${error.code}`, { message: error.message })
  const byCode: Partial<Record<CoreErrorCode, (messageOrUri: string | Uri) => FileSystemError>> = {
    SOURCE_NOT_FOUND: FileSystemError.FileNotFound,
    NOT_FOUND: FileSystemError.FileNotFound,
    NOT_A_FILE: FileSystemError.FileIsADirectory,
    NOT_A_FOLDER: FileSystemError.FileNotADirectory,
    PERMISSION_DENIED: FileSystemError.NoPermissions
  }
  return (byCode[error.code] ?? FileSystemError.Unavailable)(error.code === 'NOT_FOUND' ? uri : message)
}

const readOnly = () => {
  throw FileSystemError.NoPermissions('Files opened from Polyscope are read-only')
}

/**
 * The read-only `polyscope` file system, through which VS Code's editor shows the files of File Sources, delivered
 * decompressed, and snapshots of Log Streams. Reading a file of a Disconnected Source connects it,
 * so the tabs VS Code restores after a reload work.
 */
export function createFileProvider(core: Core): FileSystemProvider {
  const connecting = new Map<string, Promise<unknown>>()

  /** Connects a Disconnected Source, once however many reads ask at the same time. */
  async function connected(sourceId: string) {
    let { state } = await core.connectionState(sourceId)
    // Connected from the sidebar: connecting again would cancel that, so it's waited for instead.
    while (state === 'connecting' && !connecting.has(sourceId)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      ;({ state } = await core.connectionState(sourceId))
    }
    if (!connecting.has(sourceId)) {
      if (state !== 'disconnected') return
      connecting.set(sourceId, core.connect(sourceId).finally(() => connecting.delete(sourceId)))
    }
    await connecting.get(sourceId)
  }

  /** Runs `read` on the Source and path `uri` names, and whether it's a log's, connecting the Source first if needed. */
  async function reading<T>(uri: Uri, read: (sourceId: string, path: string, log: boolean) => Promise<T>): Promise<T> {
    const { sourceId, path, log } = locationOf(uri)
    try {
      await connected(sourceId)
      return await read(sourceId, path, log)
    } catch (error) {
      throw asFileSystemError(error, uri)
    }
  }

  return {
    // Nothing is watched: a file changing in its Source shows when it's opened again.
    onDidChangeFile: new EventEmitter<FileChangeEvent[]>().event,
    watch: () => new Disposable(() => {}),

    stat: (uri) =>
      reading(uri, async (sourceId, path, log) => {
        // A log's snapshot is only read once asked for; its size isn't known until then, and needn't be.
        if (log) return { type: FileType.File, ctime: 0, mtime: 0, size: 0, permissions: FilePermission.Readonly }
        const info = await core.statPath(sourceId, path)
        const modified = info.modifiedTime ?? 0
        const common = { ctime: modified, mtime: modified, permissions: FilePermission.Readonly }
        return info.kind === 'file' ? { ...common, type: FileType.File, size: info.size } : { ...common, type: FileType.Directory, size: 0 }
      }),

    readDirectory: (uri) =>
      reading(uri, async (sourceId, path) => {
        const nodes = await core.expand(sourceId, path)
        // Paths keep a folded level, so a directory holds it rather than what the tree shows in its place.
        const folded = nodes.find((node) => node.kind === 'folded')
        if (folded) return [[folded.name, FileType.Directory]]
        return nodes.flatMap((node): [string, FileType][] =>
          node.kind === 'file' ? [[node.name, FileType.File]] : node.kind === 'folder' ? [[node.name, FileType.Directory]] : []
        )
      }),

    // A log's snapshot holds its Source's Last N lines, as a log view first shows.
    readFile: (uri) =>
      reading(uri, async (sourceId, path, log) =>
        log ? Buffer.from((await core.openLog(sourceId, path)).content) : core.readFile(sourceId, path)
      ),

    writeFile: readOnly,
    createDirectory: readOnly,
    delete: readOnly,
    rename: readOnly
  }
}
