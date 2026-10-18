// Test support: a host's systemd journal as stand-in `journalctl` and `systemctl` commands answer for it, run by the
// in-process SSH test server (ssh-test-server.ts), which has no journal of its own.

import type { TestCommand, TestProcess } from './ssh-test-server'

/** A journal entry as `journalctl --output=json` gives it, logged `second`s after 2026-10-13T10:00:00Z. */
export const entry = (second: number, message: string, priority = 6) =>
  `${JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.UTC(2026, 9, 13, 10, 0, second) * 1000), MESSAGE: message, PRIORITY: String(priority) })}\n`

/** The arguments of a command as the core runs it over SSH: each word quoted for the remote shell. */
export const argsOf = (command: string) => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(([, arg]) => arg!.replaceAll(`'\\''`, `'`))

/** The unit `standInJournal({ counter: true })` adds, which logs as the Log Source contract's counter does. */
export const standInCounter = 'polyscope-counter.service'

/**
 * A host's journal as stand-in `journalctl` and `systemctl` commands answer for it: nginx.service, active, and
 * backup.service, failed, each with its entries, and with `counter`, standInCounter, active, which logged `line 1` to
 * `line 100` a second apart. Reads and Follows take `--lines` and `--since`; a Follow of a unit sends its entries so
 * far, then stays running, sent what `log` logs to it.
 */
export function standInJournal({ counter = false } = {}) {
  const entries: Record<string, string[]> = {
    'nginx.service': [entry(1, 'started'), entry(2, 'GET /'), entry(3, 'upstream timed out', 3)],
    'backup.service': [entry(4, 'giving up', 2)],
    ...(counter && { [standInCounter]: Array.from({ length: 100 }, (_, i) => entry(i + 1, `line ${i + 1}`, 5)) })
  }
  const follows = new Map<string, TestProcess>()
  /** Set while the next read of a unit's journal is to stall partway, as one cut off by a dropped connection does. */
  let stalling: (() => void) | undefined
  const exec = (command: string): TestCommand | undefined => {
    const [name, ...args] = argsOf(command)
    if (name === 'systemctl') {
      const units = [
        { unit: 'nginx.service', load: 'loaded', active: 'active', sub: 'running', description: 'A high performance web server' },
        { unit: 'backup.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Nightly backup' },
        ...(counter ? [{ unit: standInCounter, load: 'loaded', active: 'active', sub: 'running', description: 'Counter' }] : [])
      ]
      return { exitCode: 0, stdout: JSON.stringify(units) }
    }
    if (name !== 'journalctl') return undefined
    if (args.includes('--field=_SYSTEMD_UNIT')) return { exitCode: 0, stdout: Object.keys(entries).join('\n') + '\n' }
    const option = (flag: string) => args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(`--${flag}=`.length)
    const unit = option('unit') ?? ''
    // `--since=@<seconds>`, as the core gives it: the entries since then, the last `--lines` of those.
    const since = option('since')
    const from = since === undefined ? -Infinity : Number(since.slice(1)) * 1_000_000
    const lines = option('lines')
    const microsOf = (logged: string) => Number((JSON.parse(logged) as { __REALTIME_TIMESTAMP: string }).__REALTIME_TIMESTAMP)
    const sinceThen = (entries[unit] ?? []).filter((logged) => microsOf(logged) >= from)
    const selected = lines === undefined || lines === 'all' ? sinceThen : sinceThen.slice(-Number(lines))
    if (args.includes('--follow')) {
      return { run: (process) => void (process.write(selected.join('')), follows.set(unit, process), process.onEnded(() => follows.delete(unit))) }
    }
    const stalled = stalling
    stalling = undefined
    if (stalled) return { run: (process) => (process.write(entries[unit]?.[0] ?? ''), stalled()) }
    return { exitCode: 0, stdout: selected.join('') }
  }
  return {
    exec,
    /** Logs `message` to a followed unit. */
    log: (unit: string, second: number, message: string) => follows.get(unit)?.write(entry(second, message)),
    following: (unit: string) => follows.has(unit),
    /** Has the next read of a unit's journal write its first entry and go no further; resolves once it has. */
    stallNextRead: () => new Promise<void>((resolve) => (stalling = resolve))
  }
}
