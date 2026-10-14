// Test support: a host's systemd journal as stand-in `journalctl` and `systemctl` commands answer for it, run by the
// in-process SSH test server (ssh-test-server.ts), which has no journal of its own.

import type { TestCommand, TestProcess } from './ssh-test-server'

/** A journal entry as `journalctl --output=json` gives it, logged `second`s after 2026-10-13T10:00:00Z. */
export const entry = (second: number, message: string, priority = 6) =>
  `${JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.UTC(2026, 9, 13, 10, 0, second) * 1000), MESSAGE: message, PRIORITY: String(priority) })}\n`

/** The arguments of a command as the core runs it over SSH: each word quoted for the remote shell. */
export const argsOf = (command: string) => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(([, arg]) => arg!.replaceAll(`'\\''`, `'`))

/**
 * A host's journal as stand-in `journalctl` and `systemctl` commands answer for it: nginx.service, active, and
 * backup.service, failed, each with its entries; a Follow of a unit stays running, sent what `log` logs to it.
 */
export function standInJournal() {
  const entries: Record<string, string[]> = {
    'nginx.service': [entry(1, 'started'), entry(2, 'GET /'), entry(3, 'upstream timed out', 3)],
    'backup.service': [entry(4, 'giving up', 2)]
  }
  const follows = new Map<string, TestProcess>()
  /** Set while the next read of a unit's journal is to stall partway, as one cut off by a dropped connection does. */
  let stalling: (() => void) | undefined
  const exec = (command: string): TestCommand | undefined => {
    const [name, ...args] = argsOf(command)
    if (name === 'systemctl') {
      const units = [
        { unit: 'nginx.service', load: 'loaded', active: 'active', sub: 'running', description: 'A high performance web server' },
        { unit: 'backup.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Nightly backup' }
      ]
      return { exitCode: 0, stdout: JSON.stringify(units) }
    }
    if (name !== 'journalctl') return undefined
    if (args.includes('--field=_SYSTEMD_UNIT')) return { exitCode: 0, stdout: Object.keys(entries).join('\n') + '\n' }
    const unit = args.find((arg) => arg.startsWith('--unit='))?.slice('--unit='.length) ?? ''
    if (args.includes('--follow')) return { run: (process) => void (follows.set(unit, process), process.onEnded(() => follows.delete(unit))) }
    const stalled = stalling
    stalling = undefined
    if (stalled) return { run: (process) => (process.write(entries[unit]?.[0] ?? ''), stalled()) }
    const lines = args.find((arg) => arg.startsWith('--lines='))?.slice('--lines='.length)
    const logged = entries[unit] ?? []
    return { exitCode: 0, stdout: (lines === undefined ? logged : logged.slice(-Number(lines))).join('') }
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
