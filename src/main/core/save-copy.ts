import { randomUUID } from 'node:crypto'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SaveCopyStatus, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { chunksOf, largeFileReading } from './large-file'
import { asCoreError } from './log-follow'

export interface SaveCopyOptions {
  fileSource: Pick<FileSource, 'stat' | 'read'>
  path: SourcePath
  /** Where the copy goes on this computer: a file there already is replaced only once the copy is whole. */
  target: string
  /** Told each change of status, progress at most every largeFileReading.progressInterval. */
  onStatus(status: SaveCopyStatus): void
}

/** How a save that was stopped ends. */
type Stopped = Extract<SaveCopyStatus, { state: 'cancelled' | 'failed' }>

/** A copy of a file being saved. */
export interface SavingCopy {
  /** Stops saving it, as cancelled. Nothing happens to one already done. */
  cancel(): void
  /** Stops saving it, as failed with `code`, say for its Source being disconnected. Nothing happens to one already done. */
  abort(code: CoreError['code'], message: string): void
  /** Settles once it's done, saved or not, with nothing of it left behind unless it was saved. */
  done: Promise<void>
}

/** A failure writing the copy, rather than reading the file. */
const unwritable = (error: unknown) =>
  new CoreError('SAVE_UNWRITABLE', `The copy couldn’t be saved: ${error instanceof Error ? error.message : String(error)}`)

/** Runs a step of writing the copy, any failure being the copy's. */
const writing = async <T>(step: () => Promise<T>) => {
  try {
    return await step()
  } catch (error) {
    throw unwritable(error)
  }
}

/**
 * Saves a copy of a file's bytes as stored (a compressed file stays compressed), a range at a time so only one
 * range is ever held, into a part file beside `target` that's renamed to it once whole. Cancelled, or failing to
 * read or write, the part file is removed. The file is only ever read.
 */
export function saveCopy({ fileSource, path, target, onStatus }: SaveCopyOptions): SavingCopy {
  const part = join(dirname(target), `.${basename(target)}.${randomUUID()}.part`)
  let stopped: { status: Stopped } | undefined
  let interrupt = (_status: Stopped) => {}
  // Settles the moment it's stopped, so a read still on its way isn't waited for.
  const stopping = new Promise<never>((_, reject) => {
    interrupt = (status) => {
      stopped ??= { status }
      reject(stopped)
    }
  })
  stopping.catch(() => undefined)
  const unlessStopped = <T>(work: Promise<T>) => Promise.race([work, stopping])

  let lastProgress = 0
  const progress = (savedBytes: number, totalBytes: number) => {
    const now = Date.now()
    if (now - lastProgress < largeFileReading.progressInterval) return
    lastProgress = now
    onStatus({ state: 'saving', savedBytes, totalBytes })
  }

  const run = async () => {
    let file: FileHandle | undefined
    try {
      const info = await unlessStopped(fileSource.stat(path))
      if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
      // Not raced, so a part file being made is always there to remove.
      file = await writing(() => open(part, 'wx'))
      if (stopped) throw stopped
      progress(0, info.size)
      let savedBytes = 0
      const chunks = chunksOf((range) => fileSource.read(path, range), info.size)[Symbol.asyncIterator]()
      for (let next = await unlessStopped(chunks.next()); !next.done; next = await unlessStopped(chunks.next())) {
        const chunk = next.value
        await unlessStopped(writing(() => file!.write(chunk)))
        savedBytes += chunk.length
        progress(savedBytes, info.size)
      }
      const written = file
      file = undefined
      await unlessStopped(writing(() => written.close()))
      // From here it's saved: putting it in place isn't raced, so it's never there but told cancelled.
      if (stopped) throw stopped
      stopped = { status: { state: 'cancelled' } }
      await writing(() => rename(part, target))
      onStatus({ state: 'saved', savedBytes })
    } catch (error) {
      await file?.close().catch(() => undefined)
      await rm(part, { force: true }).catch(() => undefined)
      if (stopped && error === stopped) return onStatus(stopped.status)
      const { code, message } = asCoreError(error)
      onStatus({ state: 'failed', code, message })
    } finally {
      // Stopped from now on, so neither cancel nor abort tells anything more.
      stopped ??= { status: { state: 'cancelled' } }
    }
  }

  return {
    cancel: () => !stopped && interrupt({ state: 'cancelled' }),
    abort: (code, message) => !stopped && interrupt({ state: 'failed', code, message }),
    done: run()
  }
}

/** Bytes held here, read as a File Source's one file would be: say the lines a log view shows. */
const heldBytes = (bytes: Uint8Array): SaveCopyOptions['fileSource'] => ({
  stat: async () => ({ kind: 'file', size: bytes.length, modifiedTime: Date.now() }),
  read: async (_path, { offset, length }) => bytes.subarray(offset, offset + length)
})

/** Saves a copy of `bytes` held here, as saveCopy saves a file's: into a part file renamed into place once whole. */
export function saveHeldCopy({ bytes, target, onStatus }: Omit<SaveCopyOptions, 'fileSource' | 'path'> & { bytes: Uint8Array }): SavingCopy {
  return saveCopy({ fileSource: heldBytes(bytes), path: '', target, onStatus })
}
