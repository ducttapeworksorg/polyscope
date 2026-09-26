import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CoreErrorCode, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileEntry, FileSource } from './file-source'

const errnoCodes: Record<string, CoreErrorCode> = {
  ENOENT: 'NOT_FOUND',
  ENOTDIR: 'NOT_A_FOLDER',
  EISDIR: 'NOT_A_FILE'
}

function toCoreError(error: unknown, path: SourcePath): CoreError {
  const errno = (error as NodeJS.ErrnoException).code ?? ''
  return new CoreError(errnoCodes[errno] ?? 'UNKNOWN', `${path || '/'}: ${(error as Error).message}`)
}

export function createLocalFileSource(rootPath: string): FileSource {
  const root = resolve(rootPath)

  const toAbsolute = (path: SourcePath) => {
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new CoreError('PATH_OUTSIDE_SOURCE', `Path is outside the Source root: ${path}`)
    }
    return absolute
  }

  const withinRoot = async <T>(path: SourcePath, run: (absolute: string) => Promise<T>) => {
    const absolute = toAbsolute(path)
    try {
      return await run(absolute)
    } catch (error) {
      throw toCoreError(error, path)
    }
  }

  return {
    listChildren: (path) =>
      withinRoot(path, async (absolute) => {
        const dirents = await readdir(absolute, { withFileTypes: true })
        return Promise.all(
          dirents.map(async (d): Promise<FileEntry> => {
            const isFolder = d.isSymbolicLink()
              ? await stat(join(absolute, d.name)).then((s) => s.isDirectory(), () => false)
              : d.isDirectory()
            return { kind: isFolder ? 'folder' : 'file', name: d.name }
          })
        )
      }),

    stat: (path) =>
      withinRoot(path, async (absolute) => {
        const s = await stat(absolute)
        return { kind: s.isDirectory() ? 'folder' : 'file', size: s.size, modifiedTime: s.mtimeMs }
      }),

    read: (path) => withinRoot(path, (absolute) => readFile(absolute))
  }
}
