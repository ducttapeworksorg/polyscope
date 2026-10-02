import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Reads a JSON file, or returns undefined when it doesn't exist yet, including when a file stands
 * where one of its folders should be (missing on Windows, ENOTDIR elsewhere). A file that can't be
 * parsed is renamed aside (kept for the user to recover by hand) and treated as missing,
 * so one damaged file never locks the user out of the app.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    await rename(file, `${file}.unreadable-${Date.now()}`)
    return undefined
  }
}

/**
 * Returns a function that saves a value to `file`. Saves run one at a time, and each
 * replaces the file atomically, so a crash mid-save leaves the previous version intact.
 */
export function jsonFileWriter(file: string): (value: unknown) => Promise<void> {
  let saving: Promise<void> = Promise.resolve()
  return (value) => {
    const text = JSON.stringify(value, null, 2)
    saving = saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(`${file}.tmp`, text)
        await rename(`${file}.tmp`, file)
      })
    return saving
  }
}
