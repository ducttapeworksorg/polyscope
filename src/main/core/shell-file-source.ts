import type { CoreErrorCode, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { ByteRange, FileEntry, FileSource, FileStat } from './file-source'

/** What a shell script run with some arguments ended with. */
export interface ShellResult {
  exitCode: number
  stdout: Uint8Array
  stderr: string
}

/**
 * Runs `script` with `sh -c`, `args` being its $1, $2…; fails with a CoreError only when it couldn't be
 * run at all (say there's no sh), not when it ran and exited non-zero.
 */
export type Shell = (script: string, args: string[]) => Promise<ShellResult>

// The scripts' exit codes for what went wrong, apart from their tools' own.
const exitCodes: Record<number, CoreErrorCode> = {
  10: 'NOT_FOUND',
  11: 'NOT_A_FOLDER',
  12: 'NOT_A_FILE',
  13: 'PERMISSION_DENIED'
}
/** Exits 20, naming it, when a tool the script needs isn't there. */
const needs = (...tools: string[]) =>
  `for t in ${tools.join(' ')}; do command -v "$t" >/dev/null 2>&1 || { echo "$t" >&2; exit 20; }; done`

// Only POSIX sh and tools busybox and coreutils both have, with the options both know. `stat -c %f` is the raw
// mode in hex, the same everywhere, unlike `%F`'s wording.

/**
 * $1's entries (dotfiles included), each as `l mode size mtime name` without following links and `L …` following
 * them; a few hundred at a time, so a huge folder never makes a command line longer than the system allows.
 */
const listScript = `${needs('stat')}
[ -e "$1" ] || exit 10
[ -d "$1" ] || exit 11
cd -- "$1" 2>/dev/null && [ -r . ] || exit 13
batch() {
  [ $# -gt 0 ] || return 0
  stat -c 'l %f %s %Y %n' -- "$@" 2>/dev/null
  stat -L -c 'L %f %s %Y %n' -- "$@" 2>/dev/null
  return 0
}
set --
for f in * .[!.]* ..?*; do
  if [ -e "$f" ] || [ -L "$f" ]; then set -- "$@" "$f"; fi
  if [ $# -ge 500 ]; then batch "$@"; set --; fi
done
batch "$@"
exit 0`

/** $1 as `mode size mtime`, following links. */
const statScript = `${needs('stat')}
[ -e "$1" ] || exit 10
stat -L -c '%f %s %Y' -- "$1" || exit 13`

/**
 * $3 bytes of $1 from byte $2 on: dd seeks to the block they start in and reads only the blocks they span, so the
 * end of a huge file is as quick to read as its start.
 */
const readScript = `${needs('dd', 'tail', 'head')}
[ -e "$1" ] || exit 10
[ -f "$1" ] || exit 12
[ -r "$1" ] || exit 13
[ "$3" -gt 0 ] || exit 0
b=65536
dd if="$1" bs=$b skip=$(($2 / b)) count=$((($2 % b + $3 + b - 1) / b)) 2>/dev/null | tail -c +$(($2 % b + 1)) | head -c "$3"`

const statLine = /^([0-9a-f]+) (\d+) (\d+)(?: (.*))?$/

type Kind = 'folder' | 'file' | 'other' | 'link'

/** The kind of entry a raw `st_mode` in hex says it is. */
function kindOf(hexMode: string): Kind {
  const type = Number.parseInt(hexMode, 16) & 0o170000
  if (type === 0o040000) return 'folder'
  if (type === 0o100000) return 'file'
  if (type === 0o120000) return 'link'
  return 'other'
}

interface Stated {
  kind: Kind
  size: number
  modifiedTime: number
}

function parseStat(line: string): (Stated & { name: string }) | undefined {
  const match = statLine.exec(line)
  if (!match) return undefined
  const [, mode, size, seconds, name = ''] = match
  return { kind: kindOf(mode!), size: Number(size), modifiedTime: Number(seconds) * 1000, name }
}

const checkRange = ({ offset, length }: ByteRange) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new CoreError('INVALID_RANGE', `Not a range of whole bytes from zero on: ${offset}+${length}`)
  }
}

/**
 * A folder somewhere a shell can reach, typically inside a container, as a File Source: listed and read by
 * running POSIX sh scripts that need only `stat`, `dd`, `tail` and `head`, so busybox and coreutils both do.
 * `root` is the folder's absolute path there. Names with a line break in them aren't listed.
 */
export function createShellFileSource(shell: Shell, root: string): FileSource {
  const base = root.replace(/\/+$/, '')

  /** Where a Source path is in the shell's filesystem; it may not climb out of the root. */
  const locate = (path: SourcePath) => {
    const segments = path ? path.split('/') : []
    if (segments.some((s) => s === '..' || s === '.' || s === '')) {
      throw new CoreError('PATH_OUTSIDE_SOURCE', `Not a path inside ${root}: ${path}`)
    }
    return segments.length ? `${base}/${segments.join('/')}` : base || '/'
  }

  /** Runs a script on the path, failing with the CoreError its exit code stands for. */
  const run = async (script: string, path: SourcePath, ...rest: string[]) => {
    const where = locate(path)
    const { exitCode, stdout, stderr } = await shell(script, [where, ...rest])
    if (exitCode === 0) return stdout
    if (exitCode === 20) throw new CoreError('TOOLS_MISSING', `The container has no ${stderr.trim() || 'tool it needs'}`)
    const code = exitCodes[exitCode]
    if (code) throw new CoreError(code, `${code === 'NOT_FOUND' ? 'Nothing at' : 'Can’t use'} ${where}`)
    throw new CoreError('UNKNOWN', `Reading ${where} failed (exit ${exitCode}): ${stderr.trim()}`)
  }

  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  return {
    async listChildren(path) {
      const lines = text(await run(listScript, path)).split('\n')
      const stated = (prefix: 'l ' | 'L ') => lines.flatMap((line) => (line.startsWith(prefix) ? (parseStat(line.slice(2)) ?? []) : []))
      const targets = new Map(stated('L ').map((entry) => [entry.name, entry]))
      const entries = stated('l ').map((entry): FileEntry => {
        const target = entry.kind === 'link' ? targets.get(entry.name) : entry
        if (!target || target.kind === 'link') {
          return { kind: 'file', name: entry.name, problem: { code: 'NOT_FOUND', message: 'A link to nothing, or back to itself' } }
        }
        const { name } = entry
        if (target.kind === 'folder') return { kind: 'folder', name, modifiedTime: target.modifiedTime }
        const listed: FileEntry = { kind: 'file', name, size: target.size, modifiedTime: target.modifiedTime }
        return target.kind === 'file' ? listed : { ...listed, problem: { code: 'NOT_A_FILE', message: 'Not a regular file: a device, pipe or socket' } }
      })
      return { entries }
    },

    async stat(path): Promise<FileStat> {
      const stated = parseStat(text(await run(statScript, path)).trim())
      if (!stated) throw new CoreError('UNKNOWN', `Couldn’t read what ${locate(path)} is`)
      if (stated.kind === 'folder') return { kind: 'folder', modifiedTime: stated.modifiedTime }
      return { kind: 'file', size: stated.size, modifiedTime: stated.modifiedTime }
    },

    async read(path, range) {
      checkRange(range)
      return run(readScript, path, String(range.offset), String(range.length))
    }
  }
}
