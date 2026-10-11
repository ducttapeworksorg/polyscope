import { posix } from 'node:path'
import ssh2, { type Attributes, type SFTPWrapper } from 'ssh2'
import type { CoreErrorCode, EntryProblem, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { ByteRange, FileEntry, FileSource, FileStat } from './file-source'
import type { SshConnection } from './ssh-connection'

const { STATUS_CODE } = ssh2.utils.sftp

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const isFolder = (attrs: Attributes) => (attrs.mode & S_IFMT) === S_IFDIR
const isLink = (attrs: Attributes) => (attrs.mode & S_IFMT) === S_IFLNK
/** SFTP keeps modified times in whole seconds. */
const modifiedTimeOf = (attrs: Attributes) => attrs.mtime * 1000

const isWholeNumber = (n: number) => Number.isSafeInteger(n) && n >= 0

/** How much of a file one read request asks for, and how many requests are under way at once. */
const chunkLength = 32 * 1024
const concurrentReads = 16

type SftpError = Error & { code?: number | string }

/** A failed SFTP request as a CoreError: what's wrong with `path`, or that the connection it went over is gone. */
function toCoreError(error: unknown, path: SourcePath, connection: SshConnection): CoreError {
  if (error instanceof CoreError) return error
  const { code, message } = error as SftpError
  const where = `/${path}`
  if (code === STATUS_CODE.NO_SUCH_FILE) return new CoreError('NOT_FOUND', `${where}: ${message}`)
  if (code === STATUS_CODE.PERMISSION_DENIED) {
    // SFTP can't read as anyone else, so it's the user's own permissions that need to change.
    return new CoreError(
      'PERMISSION_DENIED',
      `${where} isn't readable by ${connection.user}, the SSH user, and Polyscope reads files as that user, without sudo. Adding ${connection.user} to the adm group lets it read most logs under /var/log.`
    )
  }
  // No answer, as the connection dropped while the request was under way.
  if (connection.closed) return new CoreError('UNREACHABLE', `${where}: the connection closed: ${message}`)
  return new CoreError('UNKNOWN', `${where}: ${message}`)
}

/** Calls an SFTP method that takes a callback, as a promise. */
const call = <T>(run: (callback: (error: SftpError | undefined | null, value: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value))))

/**
 * A File Source over SFTP, rooted at `rootPath` (absolute) on the server; one per connection, which closing it
 * closes. Listings follow symlinks as a Local Filesystem Source's do.
 */
export function createSshFileSource(connection: SshConnection, rootPath: string): FileSource & Required<Pick<FileSource, 'close' | 'onDropped'>> {
  const root = posix.normalize(rootPath)

  const absolute = (path: SourcePath) => {
    const segments = path ? path.split('/') : []
    if (segments.some((s) => s === '..' || s === '.' || s === '')) {
      throw new CoreError('PATH_OUTSIDE_SOURCE', `Path is outside the Source root: ${path}`)
    }
    return posix.join(root, ...segments)
  }

  /** Runs `run` with the connection's SFTP session and the path's place on the server, failing as a CoreError. */
  const at = async <T>(path: SourcePath, run: (sftp: SFTPWrapper, absolute: string) => Promise<T>) => {
    const target = absolute(path)
    try {
      return await run(await connection.sftp(), target)
    } catch (error) {
      throw toCoreError(error, path, connection)
    }
  }

  const problemOf = (error: unknown, entryPath: SourcePath): EntryProblem => {
    const { code, message } = toCoreError(error, entryPath, connection)
    return { code, message }
  }

  /** The real places of a folder and every folder above it up to the root: where a symlink back would loop. */
  const realAncestors = async (sftp: SFTPWrapper, folder: string) => {
    const relativeSegments = posix.relative(root, folder).split('/').filter(Boolean)
    const folders = [root, ...relativeSegments.map((_, i) => posix.join(root, ...relativeSegments.slice(0, i + 1)))]
    return new Set(await Promise.all(folders.map((f) => call<string>((cb) => sftp.realpath(f, cb)))))
  }

  /** A listed entry, its symlink followed: where it's headed, its size and modified time. */
  const describeEntry = async (
    sftp: SFTPWrapper,
    { filename: name, attrs }: { filename: string; attrs: Attributes },
    folder: string,
    entryPath: SourcePath,
    ancestors: () => Promise<Set<string>>
  ): Promise<FileEntry> => {
    if (!isLink(attrs)) {
      const kind = isFolder(attrs) ? 'folder' : 'file'
      return { kind, name, size: attrs.size, modifiedTime: modifiedTimeOf(attrs) }
    }
    const linked = posix.join(folder, name)
    let target: Attributes
    try {
      target = await call<Attributes>((cb) => sftp.stat(linked, cb))
    } catch (error) {
      // A link whose target is missing still shows up, and says so when it's opened.
      const { code } = error as SftpError
      return code === STATUS_CODE.NO_SUCH_FILE ? { kind: 'file', name } : { kind: 'file', name, problem: problemOf(error, entryPath) }
    }
    const entry: FileEntry = { kind: isFolder(target) ? 'folder' : 'file', name, size: target.size, modifiedTime: modifiedTimeOf(target) }
    if (entry.kind !== 'folder') return entry
    try {
      if ((await ancestors()).has(await call<string>((cb) => sftp.realpath(linked, cb)))) {
        return { ...entry, problem: { code: 'SYMLINK_LOOP', message: `${entryPath}: links back to a folder that contains it` } }
      }
    } catch (error) {
      return { ...entry, problem: problemOf(error, entryPath) }
    }
    return entry
  }

  /** Whatever's at a path, telling a missing path from one that's there but the wrong kind. */
  const statAt = (sftp: SFTPWrapper, target: string) => call<Attributes>((cb) => sftp.stat(target, cb))

  const wrongKind = (code: Extract<CoreErrorCode, 'NOT_A_FOLDER' | 'NOT_A_FILE'>, path: SourcePath) =>
    new CoreError(code, code === 'NOT_A_FOLDER' ? `Not a folder: ${path}` : `Not a file: ${path}`)

  /** `length` bytes from `position`, or fewer at the end of the file, asking again after a short read. */
  const readChunk = async (sftp: SFTPWrapper, handle: Buffer, into: Uint8Array, position: number) => {
    let filled = 0
    while (filled < into.length) {
      const buffer = Buffer.from(into.buffer, into.byteOffset + filled, into.length - filled)
      const bytesRead = await call<number>((cb) => sftp.read(handle, buffer, 0, buffer.length, position + filled, cb))
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return filled
  }

  return {
    listChildren: (path) =>
      at(path, async (sftp, folder) => {
        if (!isFolder(await statAt(sftp, folder))) throw wrongKind('NOT_A_FOLDER', path)
        const listed = await call<{ filename: string; attrs: Attributes }[]>((cb) => sftp.readdir(folder, cb))
        let ancestors: Promise<Set<string>> | undefined
        const lazyAncestors = () => (ancestors ??= realAncestors(sftp, folder))
        const entries = listed
          .filter(({ filename }) => filename !== '.' && filename !== '..')
          .map((item) => describeEntry(sftp, item, folder, path ? `${path}/${item.filename}` : item.filename, lazyAncestors))
        return { entries: await Promise.all(entries) }
      }),

    stat: (path) =>
      at(path, async (sftp, target): Promise<FileStat> => {
        const attrs = await statAt(sftp, target)
        if (isFolder(attrs)) return { kind: 'folder', modifiedTime: modifiedTimeOf(attrs) }
        return { kind: 'file', size: attrs.size, modifiedTime: modifiedTimeOf(attrs) }
      }),

    read: (path, { offset, length }: ByteRange) =>
      at(path, async (sftp, target) => {
        if (!isWholeNumber(offset) || !isWholeNumber(length)) {
          throw new CoreError('INVALID_RANGE', `Not a valid byte range: offset ${offset}, length ${length}`)
        }
        let handle: Buffer
        try {
          handle = await call<Buffer>((cb) => sftp.open(target, 'r', cb))
        } catch (error) {
          // Some servers can't open a folder at all; others open it, and fstat tells.
          const { code } = error as SftpError
          if (code !== STATUS_CODE.NO_SUCH_FILE && code !== STATUS_CODE.PERMISSION_DENIED) {
            const attrs = await statAt(sftp, target).catch(() => undefined)
            if (attrs && isFolder(attrs)) throw wrongKind('NOT_A_FILE', path)
          }
          throw error
        }
        try {
          const attrs = await call<Attributes>((cb) => sftp.fstat(handle, cb))
          if (isFolder(attrs)) throw wrongKind('NOT_A_FILE', path)
          const buffer = new Uint8Array(Math.max(0, Math.min(length, attrs.size - offset)))
          // Requests in flight together, as a file far away is read in round trips.
          const starts = Array.from({ length: Math.ceil(buffer.length / chunkLength) }, (_, i) => i * chunkLength)
          const filled: number[] = []
          for (let i = 0; i < starts.length; i += concurrentReads) {
            const batch = starts.slice(i, i + concurrentReads)
            filled.push(
              ...(await Promise.all(
                batch.map((start) => readChunk(sftp, handle, buffer.subarray(start, Math.min(start + chunkLength, buffer.length)), offset + start))
              ))
            )
          }
          // The file shrank since it was measured: what's there up to the first chunk cut short.
          const short = filled.findIndex((n, i) => n < Math.min(chunkLength, buffer.length - starts[i]!))
          return short < 0 ? buffer : buffer.subarray(0, starts[short]! + filled[short]!)
        } finally {
          sftp.close(handle, () => undefined)
        }
      }),

    close: () => connection.close(),

    onDropped: (listener) => connection.onDrop(listener)
  }
}
