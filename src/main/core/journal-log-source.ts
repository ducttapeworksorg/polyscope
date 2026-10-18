import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { LogStreamNode, NodeHealth, NodeStatus, SourcePath } from '@shared/core-api'
import type { ClientChannel } from 'ssh2'
import { CoreError } from './core-error'
import type { LogConnection, LogFollowOptions, LogReadOptions, LogSource, LogStreamInfo } from './log-source'
import type { SshConnection } from './ssh-connection'

// `journalctl` and `systemctl` are only ever run with arguments Polyscope builds itself: a unit's name only once it's
// checked against systemd's rules for unit names, and only as part of an `--unit=` argument. On this machine they're
// spawned directly, never through a shell; on a host over SSH, whose server runs every command through the user's
// shell, each argument is quoted for it.

/** A command running on the machine whose journal is read. */
export interface RunningCommand {
  /** Calls `listener` with its standard output as it comes. */
  onOutput(listener: (chunk: Buffer) => void): void
  /** Resolves once it has exited, with its exit code (null if it was stopped) and its standard error; rejects with NO_JOURNAL if there's no such command. */
  exited: Promise<{ code: number | null; stderr: string }>
  /** Ends it; `exited` resolves. */
  stop(): void
}

/** The machine whose journal a systemd Journal Source reads, and runs `journalctl` and `systemctl` on. */
export interface JournalHost {
  /** What to call it in failures: `this machine`, say. */
  name: string
  start(command: 'journalctl' | 'systemctl', args: string[]): RunningCommand
}

/** The machine the core runs on: its commands are spawned directly, never through a shell. */
export const thisMachine: JournalHost = {
  name: 'this machine',
  start(command, args) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SYSTEMD_COLORS: '0' } })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => (stderr += text))
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') return reject(new CoreError('UNKNOWN', `${command}: ${error.message}`))
        reject(new CoreError('NO_JOURNAL', `This machine has no ${command}, so no systemd journal to read`))
      })
      child.on('close', (code) => resolve({ code, stderr }))
    })
    return { onOutput: (listener) => child.stdout.on('data', listener), exited, stop: () => child.kill() }
  }
}

/** A word quoted for a POSIX shell: in single quotes, each of its own ended, escaped and begun again. */
const shellQuoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * Whether the user's shell couldn't find `command`, from its exit code and what it said: 127 from a POSIX shell (`sh: 1:
 * journalctl: not found`, `bash: journalctl: command not found`), and csh's `journalctl: Command not found.` or fish's
 * `fish: Unknown command: journalctl` whatever the code.
 */
const notFound = (command: string, code: number | null, said: string) =>
  code === 127 || new RegExp(`${command}: command not found|unknown command:? '?${command}`, 'i').test(said)

/**
 * A host reached over SSH: its commands run on exec channels of the one connection, as the user signed in, each
 * channel closed to stop its command. `host` is what to call it in failures.
 */
export function journalHostOver(connection: SshConnection, host: string): JournalHost {
  return {
    name: host,
    start(command, args) {
      const listeners: ((chunk: Buffer) => void)[] = []
      let channel: ClientChannel | undefined
      let stopped = false
      const stop = (running: ClientChannel) => {
        // A command that ignores its output going nowhere, like journalctl --follow before it next logs, is told to end too.
        running.signal('TERM')
        running.close()
      }
      const exited = connection.exec([command, ...args].map(shellQuoted).join(' ')).then(
        (opened) =>
          new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
            channel = opened
            const stderr: Buffer[] = []
            opened.on('data', (chunk: Buffer) => {
              for (const listener of listeners) listener(chunk)
            })
            opened.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
            opened.on('error', () => undefined)
            // ssh2 tells how the command exited as the channel closes: its exit code, or null and the signal that ended it,
            // or undefined if it never exited, as when the connection drops. ('exit' may come before this listens.)
            opened.on('close', (code?: number | null, signal?: string) => {
              const said = Buffer.concat(stderr).toString('utf8')
              if (stopped) return resolve({ code: null, stderr: said })
              // Closed without exiting: the connection dropped under it, and what it gave is only part of its output.
              if (code === undefined) return reject(new CoreError('UNREACHABLE', `${host}: the connection closed`))
              if (notFound(command, code, said)) {
                return reject(new CoreError('NO_JOURNAL', `There’s no ${command} on ${host} for ${connection.user}, so no systemd journal to read`))
              }
              if (code === null) return reject(new CoreError('UNKNOWN', `${command} on ${host} was ended by ${signal ?? 'a signal'}`))
              resolve({ code, stderr: said })
            })
            if (stopped) stop(opened)
          })
      )
      return {
        onOutput: (listener) => void listeners.push(listener),
        exited,
        stop() {
          stopped = true
          if (channel) stop(channel)
        }
      }
    }
  }
}

/** The types of unit systemd has, each a unit name's last part. */
const unitTypes = ['service', 'socket', 'device', 'mount', 'automount', 'swap', 'target', 'path', 'timer', 'slice', 'scope']

const unitNamePattern = new RegExp(String.raw`^[A-Za-z0-9:_.\\-]+(?:@[A-Za-z0-9:_.\\-]*)?\.(?:${unitTypes.join('|')})$`)

/** Whether `name` is a unit's name, by systemd's rules: letters, digits and `:_.\-`, maybe an `@instance`, then its type. */
export const isUnitName = (name: string) => name.length <= 255 && unitNamePattern.test(name)

/** What journalctl says on standard error when the user may not read the system's journal, or there's no journal at all. */
const notPermitted = /insufficient permissions|not seeing messages from other users and the system/i
const noJournalFiles = /No journal files were found/i

/** A failure `journalctl` reported, as a CoreError; none if it went well. */
function journalFailure(host: JournalHost, { code, stderr }: { code: number | null; stderr: string }) {
  if (notPermitted.test(stderr)) {
    const how = 'add the user to the systemd-journal or adm group, then sign in again'
    return new CoreError('PERMISSION_DENIED', `Not allowed to read the system journal on ${host.name}: ${how}`)
  }
  if (noJournalFiles.test(stderr)) return new CoreError('NO_JOURNAL', `There is no systemd journal on ${host.name}`)
  if (code !== 0 && code !== null) return new CoreError('UNKNOWN', `journalctl failed: ${stderr.trim() || `exit code ${code}`}`)
  return undefined
}

/**
 * Calls `onLine` with each line of a command's output, from pieces that needn't end at a line break, until `onLine`
 * returns false; `end` gives a last line not ended by one.
 */
function lineSplitter(onLine: (line: string) => boolean | void) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let done = false
  const take = (lines: string[]) => {
    for (const line of lines) if (!done && onLine(line) === false) done = true
  }
  return {
    push(chunk: Buffer) {
      const lines = (pending + decoder.write(chunk)).split('\n')
      pending = lines.pop()!
      take(lines)
      return !done
    },
    end() {
      const last = pending + decoder.end()
      if (last) take([last])
    }
  }
}

/**
 * Runs a command to its end, calling `onLine` with each line of its output; `onLine` returning false stops it there.
 * Fails as `check` says it went wrong.
 */
async function runLines(
  host: JournalHost,
  command: 'journalctl' | 'systemctl',
  args: string[],
  onLine: (line: string) => boolean | void,
  check: (outcome: { code: number | null; stderr: string }) => CoreError | undefined
) {
  const running = host.start(command, args)
  const lines = lineSplitter(onLine)
  let stopped = false
  running.onOutput((chunk) => {
    if (stopped || lines.push(chunk)) return
    stopped = true
    running.stop()
  })
  const outcome = await running.exited
  if (!stopped) lines.end()
  // Stopped early on purpose: what it says about being stopped doesn't count.
  const failure = check(stopped ? { ...outcome, code: 0 } : outcome)
  if (failure) throw failure
}

/** A journal entry, as `journalctl --output=json` gives it: a MESSAGE that isn't UTF-8 comes as its bytes. */
interface JournalEntry {
  __REALTIME_TIMESTAMP?: string
  MESSAGE?: string | number[] | null
  PRIORITY?: string
}

/**
 * The log level an entry's priority shows as, as the log highlighter knows it: emerg, alert and crit as CRIT, err as
 * ERROR, warning as WARNING and debug as DEBUG. Notice and info, a service's ordinary output, show none.
 */
const levelOf = (priority: string | undefined) => ['CRIT', 'CRIT', 'CRIT', 'ERROR', 'WARNING', '', '', 'DEBUG'][Number(priority)] ?? ''

/** An entry's time, microseconds since the epoch, as RFC 3339 in UTC. */
function timestampOf(micros: string) {
  const whole = new Date(Number(BigInt(micros) / 1000n)).toISOString()
  return `${whole.slice(0, 19)}.${micros.padStart(7, '0').slice(-6)}Z`
}

/**
 * An entry as log lines, each ending in '\n': its level, if it shows one, then its message, `timestamps` putting its time
 * before each. A message of several lines gives as many, each so marked. Nothing for a line that isn't an entry.
 */
function linesOf(json: string, timestamps: boolean) {
  let entry: JournalEntry
  try {
    entry = JSON.parse(json) as JournalEntry
  } catch {
    return ''
  }
  if (typeof entry !== 'object' || entry === null || !entry.__REALTIME_TIMESTAMP) return ''
  const { MESSAGE: message } = entry
  const text = Array.isArray(message) ? Buffer.from(message).toString('utf8') : typeof message === 'string' ? message : ''
  const prefix = [timestamps ? timestampOf(entry.__REALTIME_TIMESTAMP) : '', levelOf(entry.PRIORITY)].filter(Boolean).join(' ')
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `${prefix && `${prefix} `}${line}\n`)
    .join('')
}

/** A unit's active state, as systemctl lists it. */
interface UnitState {
  active: string
  description: string
}

const healthOf = (active: string): NodeHealth =>
  active === 'active' ? 'healthy'
  : active === 'failed' ? 'failing'
  : ['activating', 'deactivating', 'reloading', 'refreshing'].includes(active) ? 'pending'
  : 'inactive'

/** Units' active states from `systemctl list-units --output=json`. */
function statesFromJson(text: string): Map<string, UnitState> {
  const listed = JSON.parse(text) as { unit?: string; active?: string; description?: string }[]
  return new Map(listed.filter((u) => u.unit && u.active).map((u) => [u.unit!, { active: u.active!, description: u.description ?? '' }]))
}

/** Units' active states from `systemctl list-units --plain --no-legend`: unit, load, active and sub state, then its description. */
function statesFromPlain(text: string): Map<string, UnitState> {
  const states = new Map<string, UnitState>()
  for (const line of text.split('\n')) {
    // Units not found or failed may be marked with a bullet first.
    const [unit, , active, , ...description] = line.replace(/^\s*[●*]?\s*/, '').split(/\s+/)
    if (unit && active) states.set(unit, { active, description: description.join(' ') })
  }
  return states
}

/** What `journalctl` is asked for to read a unit's journal: its entries as JSON, with only what makes a log line. */
const unitJournal = (unit: string) => ['--output=json', '--output-fields=MESSAGE,PRIORITY', `--unit=${unit}`]

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The system units on a machine that have journal entries of their own, as a Log Source of one flat list of Log Streams,
 * each unit's path its name, e.g. `nginx.service`, failed units first. Each tells its active state as its status.
 * The journal is one log across a unit's restarts, so it has no restarts and no Previous Log; a Follow goes on across them.
 */
export function createJournalLogSource(host: JournalHost): LogSource {
  const journalctl = async (args: string[], onLine: (line: string) => boolean | void) =>
    runLines(host, 'journalctl', ['--no-pager', ...args], onLine, (outcome) => journalFailure(host, outcome))

  /** The units with journal entries of their own: what's in the tree. Units with names systemd wouldn't give are left out. */
  const loggingUnits = async () => {
    const units = new Set<string>()
    await journalctl(['--field=_SYSTEMD_UNIT'], (line) => void (isUnitName(line) && units.add(line)))
    return units
  }

  /** What systemctl output, all of it, or undefined if it failed. */
  const systemctl = async (args: string[]) => {
    let text = ''
    try {
      await runLines(host, 'systemctl', ['--no-pager', 'list-units', '--all', ...args], (line) => void (text += `${line}\n`), ({ code }) =>
        code === 0 ? undefined : new CoreError('UNKNOWN', 'systemctl failed')
      )
      return text
    } catch {
      return undefined
    }
  }

  /** Every loaded unit's active state: none if systemctl can't tell, as in a container systemd didn't boot. */
  const unitStates = async () => {
    // JSON from systemd 246 on; older systemctl doesn't know it, and lists them plainly.
    const json = await systemctl(['--output=json'])
    if (json !== undefined) {
      try {
        return statesFromJson(json)
      } catch {
        // Not JSON after all: listed plainly below.
      }
    }
    const plain = await systemctl(['--plain', '--no-legend'])
    return plain === undefined ? new Map<string, UnitState>() : statesFromPlain(plain)
  }

  /** The unit a Log Stream's path names, once it's clear it's one with journal entries; nothing runs for a name that isn't a unit's. */
  const unitAt = async (path: SourcePath) => {
    if (!path) throw new CoreError('NOT_A_LOG_STREAM', 'The journal’s root is no unit’s log')
    if (!isUnitName(path)) throw new CoreError('NOT_FOUND', `Not a unit’s name: ${path}`)
    if (!(await loggingUnits()).has(path)) throw new CoreError('NOT_FOUND', `No unit ${path} has logged on ${host.name}`)
    return path
  }

  return {
    capabilities: { previousLog: false, restarts: false, status: true, since: false },

    async listChildren(path) {
      if (path) {
        await unitAt(path)
        throw new CoreError('NOT_A_FOLDER', `A unit’s log has no children: ${path}`)
      }
      const [units, states] = await Promise.all([loggingUnits(), unitStates()])
      const nodes = [...units].map((unit): LogStreamNode => {
        const state = states.get(unit)
        if (!state) return { kind: 'logStream', name: unit, path: unit, systemd: { kind: 'unit' } }
        const status: NodeStatus = { reason: state.active, health: healthOf(state.active), restarts: 0 }
        return { kind: 'logStream', name: unit, path: unit, status, systemd: { kind: 'unit', ...(state.description && { description: state.description }) } }
      })
      const failed = (node: LogStreamNode) => (node.status?.health === 'failing' ? 0 : 1)
      return nodes.toSorted((a, b) => failed(a) - failed(b) || byName.compare(a.name, b.name))
    },

    async logStreamAt(path): Promise<LogStreamInfo> {
      return { name: await unitAt(path) }
    },

    async readLog(path, { tailLines, limitBytes = Infinity, timestamps = false }: LogReadOptions = {}) {
      const unit = await unitAt(path)
      let text = ''
      let bytes = 0
      await journalctl([...unitJournal(unit), ...(tailLines === undefined ? [] : [`--lines=${tailLines}`])], (line) => {
        const lines = linesOf(line, timestamps)
        text += lines
        bytes += Buffer.byteLength(lines)
        return bytes < limitBytes
      })
      return text
    },

    async followLog(path, { sinceTime }: LogFollowOptions, onText): Promise<LogConnection> {
      const unit = await unitAt(path)
      // To the second: `--since` takes no fraction of one.
      const since = sinceTime === undefined ? [] : [`--since=@${Math.floor(Date.parse(sinceTime) / 1000)}`]
      const running = host.start('journalctl', ['--no-pager', ...unitJournal(unit), '--follow', '--lines=all', ...since])
      let stopped = false
      const lines = lineSplitter((line) => {
        const text = linesOf(line, true)
        if (text && !stopped) onText(text)
      })
      running.onOutput((chunk) => void lines.push(chunk))
      const ended = running.exited.then((outcome) => {
        if (stopped) return
        lines.end()
        const failure = journalFailure(host, outcome)
        if (failure) throw failure
      })
      // Settled whether or not anyone is still waiting on it, say after stopping.
      ended.catch(() => undefined)
      return {
        ended,
        stop() {
          stopped = true
          running.stop()
        }
      }
    }
  }
}
