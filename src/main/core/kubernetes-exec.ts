import { Readable, Writable } from 'node:stream'
import { Exec, type KubeConfig, type V1Status } from '@kubernetes/client-node'
import { CoreError } from './core-error'
import { asCoreError } from './kubernetes-api'
import type { Shell, ShellResult } from './shell-file-source'

/** Where a command runs: one container of one pod. */
export interface ExecTarget {
  namespace: string
  pod: string
  container: string
}

/** How long a command may take, in milliseconds: long enough to read a large range over a slow link. */
const execTimeout = 120_000

/** A Writable keeping everything written to it. */
function collector() {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk)
      done()
    }
  })
  return { stream, bytes: () => new Uint8Array(Buffer.concat(chunks)) }
}

/** A command's exit code, from the status the API server ends an exec with; undefined if it never ran. */
function exitCodeOf(status: V1Status): number | undefined {
  if (status.status === 'Success') return 0
  if (status.reason !== 'NonZeroExitCode') return undefined
  const code = Number(status.details?.causes?.find((cause) => cause.reason === 'ExitCode')?.message)
  return Number.isInteger(code) ? code : undefined
}

/** A failure to open the exec connection, as a CoreError: the WebSocket only says what HTTP status refused it. */
function connectError(error: unknown, { namespace, pod }: ExecTarget): CoreError {
  const cause = (error as { error?: unknown } | null)?.error ?? error
  const message = cause instanceof Error ? cause.message : String((error as { message?: unknown } | null)?.message ?? error)
  const status = Number(/Unexpected server response: (\d+)/.exec(message)?.[1])
  if (status === 401) return new CoreError('AUTH_FAILED', message)
  // Denied the one thing an exec needs.
  if (status === 403) return new CoreError('MISSING_PERMISSION', `create pods/exec in namespace ${namespace}`)
  if (status === 404) return new CoreError('POD_GONE', `Pod ${pod} no longer exists`)
  return asCoreError(cause)
}

/**
 * Runs `command` in a container, `stdin` fed to it if given, collecting what it prints. Resolves once it has
 * exited; fails with NO_SHELL if the image has no such program to run.
 */
export async function execInPod(config: KubeConfig, target: ExecTarget, command: string[], stdin?: Uint8Array): Promise<ShellResult> {
  const stdout = collector()
  const stderr = collector()
  let status: V1Status | undefined
  const input = stdin && Readable.from([Buffer.from(stdin)])
  let socket: Awaited<ReturnType<Exec['exec']>>
  try {
    socket = await new Exec(config).exec(target.namespace, target.pod, target.container, command, stdout.stream, stderr.stream, input ?? null, false, (s) => (status = s))
  } catch (error) {
    throw connectError(error, target)
  }
  const finished = await new Promise<boolean>((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve(true)
    // A command that never ends, or a connection that died quietly, gives up in the end.
    const timer = setTimeout(() => {
      resolve(false)
      socket.close()
    }, execTimeout)
    socket.addEventListener('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!finished) throw new CoreError('UNREACHABLE', `${target.pod} didn’t answer within ${execTimeout / 1000} seconds`)
  if (!status) throw new CoreError('UNREACHABLE', `The connection to ${target.pod} was cut off`)
  const exitCode = exitCodeOf(status)
  if (exitCode === undefined) {
    const message = status.message ?? 'The command couldn’t be run'
    // The runtime's words for an image without the program, e.g. `exec: "sh": executable file not found in $PATH`.
    if (/executable file not found|no such file or directory/i.test(message)) {
      throw new CoreError('NO_SHELL', `${target.container} has no ${command[0]} to run: ${message}`)
    }
    throw new CoreError('UNKNOWN', message)
  }
  return { exitCode, stdout: stdout.bytes(), stderr: new TextDecoder().decode(stderr.bytes()) }
}

/** Runs scripts with `sh` in a container. */
export const podShell =
  (config: KubeConfig, target: ExecTarget): Shell =>
  async (script, args) => {
    const result = await execInPod(config, target, ['sh', '-c', script, 'sh', ...args])
    // Some runtimes report a missing program as the exit code a shell would give; the scripts check for their own tools.
    if (result.exitCode === 126 || result.exitCode === 127) {
      throw new CoreError('NO_SHELL', `${target.container} has no sh to run: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    return result
  }
