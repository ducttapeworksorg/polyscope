// Reaching a Docker Engine on a host over SSH, as the Docker CLI reaches an `ssh://` context's: each connection to its
// API is a `docker system dial-stdio` run on the host, over the one SSH connection, its stdin and stdout piped to the
// engine's socket there.

import { Duplex } from 'node:stream'
import { CoreError } from './core-error'
import type { SshConnection } from './ssh-connection'

/** Opens a connection to an engine's API: a stream that speaks HTTP to it. */
export type DockerDialer = () => Promise<Duplex>

/** What the Docker CLI runs on the host to reach its engine. */
export const dialStdio = 'docker system dial-stdio'

/** Why `docker system dial-stdio` on `host` ended without reaching the engine, from its exit code and what it wrote to stderr. */
function failureOf(host: string, user: string, exitCode: number | undefined, stderr: string) {
  const said = stderr.trim()
  // A shell's own "command not found" is 127, as is the CLI missing from a non-interactive shell's PATH.
  if (exitCode === 127 || /docker: (command )?not found|not recognized as/i.test(said)) {
    return new CoreError('DOCKER_NOT_FOUND', `There's no docker command on ${host} for ${user}, or it isn't on the PATH a command run over SSH gets: ${said}`)
  }
  // The Docker CLI's own words, not any "permission denied" on the way to running it.
  if (/permission denied while trying to connect to the docker/i.test(said)) {
    return new CoreError(
      'PERMISSION_DENIED',
      `${user} isn't allowed to use the Docker socket on ${host}: add them to the docker group there (sudo usermod -aG docker ${user}), then connect again. (${said})`
    )
  }
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(said)) {
    return new CoreError('UNREACHABLE', `Docker isn't running on ${host}: ${said}`)
  }
  return new CoreError('UNREACHABLE', `${dialStdio} failed on ${host}${exitCode === undefined ? '' : ` (exit ${exitCode})`}: ${said || 'it said nothing'}`)
}

/** A connection dialled to an engine, which Node's HTTP Agent keeps open as a socket: what it'd tune on one does nothing here. */
class DialedStream extends Duplex {
  setKeepAlive = () => this
  setNoDelay = () => this
  setTimeout = () => this
  ref = () => this
  unref = () => this
}

/**
 * Connections to the engine on the host `connection` is signed in to, each over a channel running `docker system
 * dial-stdio`. One that ends before the engine says anything fails with why, from what the command wrote to stderr:
 * no `docker` there, no permission to use its socket, or no engine running.
 */
export function dialerOver(connection: SshConnection, host: string): DockerDialer {
  return async () => {
    const channel = await connection.exec(dialStdio)
    let stderr = ''
    let exitCode: number | undefined
    let answered = false
    channel.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf8')))
    channel.on('exit', (code: number | null) => (exitCode = code ?? undefined))
    // The channel's end is held back until it closes, by when its exit and stderr are in, to tell why it ended.
    const stream = new DialedStream({
      read: () => void channel.resume(),
      write: (chunk: Buffer, _encoding, done) => void channel.write(chunk, done),
      final: (done) => {
        channel.end()
        done()
      },
      destroy: (error, done) => {
        channel.destroy()
        done(error)
      }
    })
    channel.on('data', (data: Buffer) => {
      answered = true
      if (!stream.push(data)) channel.pause()
    })
    channel.on('error', (error: Error) => stream.destroy(error))
    channel.on('close', () => {
      if (answered) stream.push(null)
      else stream.destroy(failureOf(host, connection.user, exitCode, stderr))
    })
    return stream
  }
}
