import { execFile } from 'node:child_process'
import { constants, type Dirent, type Stats } from 'node:fs'
import { access, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { CoreErrorCode, EntryProblem, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { ByteRange, FileEntry, FileSource } from './file-source'

const errnoCodes: Record<string, CoreErrorCode> = {
  ENOENT: 'NOT_FOUND',
  ENOTDIR: 'NOT_A_FOLDER',
  EISDIR: 'NOT_A_FILE',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  ELOOP: 'SYMLINK_LOOP'
}

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? ''

function toCoreError(error: unknown, path: SourcePath): CoreError {
  if (error instanceof CoreError) return error
  return new CoreError(errnoCodes[errnoOf(error)] ?? 'UNKNOWN', `${path || '/'}: ${(error as Error).message}`)
}

const isWholeNumber = (n: number) => Number.isSafeInteger(n) && n >= 0

const execFileAsync = promisify(execFile)

/**
 * The names in a folder that carry the Windows hidden attribute, which Node can't read directly.
 * `cmd /u` writes the listing as UTF-16 so any name survives. The folder arrives through the
 * environment, so cmd expands it once and never reads `%` or `&` in its name as syntax.
 */
async function windowsHiddenNames(folder: string): Promise<Set<string>> {
  const listing = await execFileAsync('cmd.exe', ['/d /u /c dir /a:h /b "%POLYSCOPE_FOLDER%"'], {
    encoding: 'buffer',
    env: { ...process.env, POLYSCOPE_FOLDER: folder },
    windowsHide: true,
    windowsVerbatimArguments: true
  }).then(
    ({ stdout }) => stdout.toString('utf16le'),
    (error) => {
      // `dir` exits with a status when nothing is hidden; not being able to run cmd at all is a real failure.
      if (typeof (error as { code?: unknown }).code !== 'number') throw error
      return ''
    }
  )
  return new Set(listing.split('\r\n').filter(Boolean))
}

export interface LocalFileSourceOptions {
  /** Whether dotfiles (and, on Windows, files with the hidden attribute) are listed. */
  showHidden: boolean
}

export function createLocalFileSource(rootPath: string, { showHidden }: LocalFileSourceOptions): FileSource {
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

  /** The real locations of a folder and every folder above it up to the root: where a symlink back would loop. */
  const realAncestors = async (path: SourcePath) => {
    const segments = path ? path.split('/') : []
    const folders = segments.map((_, i) => join(root, ...segments.slice(0, i + 1)))
    return new Set(await Promise.all([root, ...folders].map((folder) => realpath(folder))))
  }

  const problemOf = (error: unknown, entryPath: SourcePath): EntryProblem => {
    const { code, message } = toCoreError(error, entryPath)
    return { code, message }
  }

  /** Where a listed entry is headed, following symlinks, whether it can be read, and its size and modified time. */
  const describeEntry = async (
    dirent: Dirent,
    folder: string,
    folderPath: SourcePath,
    ancestors: () => Promise<Set<string>>
  ): Promise<FileEntry> => {
    const { name } = dirent
    const absolute = join(folder, name)
    const entryPath = folderPath ? `${folderPath}/${name}` : name
    let info: Stats | undefined
    try {
      info = await stat(absolute)
    } catch (error) {
      // A link whose target is missing still shows up, and says so when it's opened.
      if (dirent.isSymbolicLink()) {
        return errnoOf(error) === 'ENOENT' ? { kind: 'file', name } : { kind: 'file', name, problem: problemOf(error, entryPath) }
      }
      // Anything else goes on without metadata (e.g. a file Windows keeps locked) and is still checked for access.
    }
    const kind: FileEntry['kind'] = (info ?? dirent).isDirectory() ? 'folder' : 'file'
    const entry: FileEntry = info ? { kind, name, size: info.size, modifiedTime: info.mtimeMs } : { kind, name }
    if (dirent.isSymbolicLink() && kind === 'folder') {
      try {
        if ((await ancestors()).has(await realpath(absolute))) {
          const message = `${entryPath}: links back to a folder that contains it`
          return { ...entry, problem: { code: 'SYMLINK_LOOP', message } }
        }
      } catch (error) {
        // Only this entry is affected, e.g. when its link changed since it was listed.
        return { ...entry, problem: problemOf(error, entryPath) }
      }
    }
    try {
      await access(absolute, kind === 'folder' ? constants.R_OK | constants.X_OK : constants.R_OK)
    } catch (error) {
      return { ...entry, problem: problemOf(error, entryPath) }
    }
    return entry
  }

  return {
    listChildren: (path) =>
      withinRoot(path, async (absolute) => {
        let dirents = await readdir(absolute, { withFileTypes: true })
        if (!showHidden) {
          const hidden = process.platform === 'win32' ? await windowsHiddenNames(absolute) : new Set<string>()
          dirents = dirents.filter((d) => !d.name.startsWith('.') && !hidden.has(d.name))
        }
        let ancestors: Promise<Set<string>> | undefined
        const lazyAncestors = () => (ancestors ??= realAncestors(path))
        return Promise.all(dirents.map((d) => describeEntry(d, absolute, path, lazyAncestors)))
      }),

    stat: (path) =>
      withinRoot(path, async (absolute) => {
        const s = await stat(absolute)
        return { kind: s.isDirectory() ? 'folder' : 'file', size: s.size, modifiedTime: s.mtimeMs }
      }),

    read: (path, { offset, length }: ByteRange) =>
      withinRoot(path, async (absolute) => {
        if (!isWholeNumber(offset) || !isWholeNumber(length)) {
          throw new CoreError('INVALID_RANGE', `Not a valid byte range: offset ${offset}, length ${length}`)
        }
        const file = await open(absolute, 'r')
        try {
          const info = await file.stat()
          if (info.isDirectory()) throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
          const buffer = new Uint8Array(Math.max(0, Math.min(length, info.size - offset)))
          let filled = 0
          while (filled < buffer.length) {
            const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, offset + filled)
            if (bytesRead === 0) break // the file shrank since it was measured
            filled += bytesRead
          }
          return buffer.subarray(0, filled)
        } finally {
          await file.close()
        }
      })
  }
}
