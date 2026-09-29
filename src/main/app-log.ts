import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from './redact'

/** The app's own log: what went wrong in the main process, kept on disk for the user to share when filing a bug. */
export interface AppLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
  /** The most recent whole lines, at most `maxBytes` of them, oldest first. */
  recent(maxBytes?: number): Promise<string>
}

interface Options {
  dir: string
  /** The size past which the current file becomes the older one; the one before that is dropped. */
  maxFileBytes?: number
  now?: () => Date
}

const currentName = 'polyscope.log'
const olderName = 'polyscope.old.log'

const describeError = (error: unknown) => (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error))

/**
 * Creates the app log in `dir`: two files at most, so it never grows past twice `maxFileBytes`. Lines are written
 * at once (they're few, and must survive a crash) with secrets redacted first, so none reach the disk. Failing to
 * write is ignored: logging never takes the app down.
 */
export function createAppLog({ dir, maxFileBytes = 1024 * 1024, now = () => new Date() }: Options): AppLog {
  const current = join(dir, currentName)
  const older = join(dir, olderName)
  let size: number | undefined

  const write = (level: 'INFO' | 'WARN' | 'ERROR', message: string, error?: unknown) => {
    const text = error === undefined ? message : `${message}: ${describeError(error)}`
    const line = `${now().toISOString()} ${level.padEnd(5)} ${redact(text)}\n`
    const bytes = Buffer.byteLength(line)
    try {
      if (size === undefined) {
        mkdirSync(dir, { recursive: true })
        size = fileSize(current)
      }
      if (size > 0 && size + bytes > maxFileBytes) {
        renameSync(current, older)
        size = 0
      }
      appendFileSync(current, line)
      size += bytes
    } catch {
      size = undefined
    }
  }

  return {
    info: (message) => write('INFO', message),
    warn: (message, error) => write('WARN', message, error),
    error: (message, error) => write('ERROR', message, error),
    async recent(maxBytes = 256 * 1024) {
      const text = (await readOrEmpty(older)) + (await readOrEmpty(current))
      if (Buffer.byteLength(text) <= maxBytes) return text
      const tail = Buffer.from(text).subarray(-maxBytes).toString('utf8')
      // Drops the line cut short at the start.
      return tail.slice(tail.indexOf('\n') + 1)
    }
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}
