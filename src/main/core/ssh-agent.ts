// Finding the user's SSH agent, for SSH Files Sources that sign in through it (ADR 0006): SSH_AUTH_SOCK's, as
// OpenSSH's ssh uses; and on Windows, where SSH_AUTH_SOCK is often a stale Git Bash socket or not set at all, then
// Pageant, then Windows' OpenSSH agent's named pipe, which 1Password's agent answers on too.

import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'
import ssh2, { type BaseAgent } from 'ssh2'
import { CoreError } from './core-error'

const { createAgent, OpenSSHAgent } = ssh2

/** Where Windows' OpenSSH agent listens. */
const windowsOpenSshPipe ='\\\\.\\pipe\\openssh-ssh-agent'

/**
 * How long an agent may take to list its keys before it's taken not to be there. Generous, as starting pagent.exe
 * alone can take seconds while antivirus checks it.
 */
const probeTimeout = 10_000

export interface FindSshAgentOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** ssh2's pagent.exe, which talks to Pageant for it; Pageant is skipped without it. */
  pageantHelper?: string
  /** Where Windows' OpenSSH agent listens, if not where it always does (as in tests). */
  openSshPipe?: string
}

/**
 * Pageant's messages carried by ssh2's pagent.exe, started for each request, as ssh2's own PageantAgent does: only
 * that looks for the helper beside ssh2's source, which isn't there once it's bundled.
 */
class PageantSocket extends Duplex {
  private pending = Buffer.alloc(0)
  private helper: ChildProcess | undefined

  constructor(private readonly helperPath: string) {
    super()
  }

  override _read() {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.pending = Buffer.concat([this.pending, chunk])
    // A request is sent whole, once all of it, its length first, has been written.
    if (this.pending.length < 4 || this.pending.length - 4 < this.pending.readUInt32BE(0)) return done()
    const request = this.pending
    this.pending = Buffer.alloc(0)
    const helper = (this.helper = spawn(this.helperPath, [String(request.length)], { windowsHide: true }))
    let failed = false
    helper.stdout!.on('data', (data: Buffer) => this.push(data))
    helper.on('error', (error) => {
      failed = true
      done(error)
    })
    helper.on('close', (code) => {
      this.helper = undefined
      if (failed) return
      // pagent.exe's exit codes: 11 is Pageant not running, the others its own failures.
      done(code ? new Error(code === 11 ? 'Pageant is not running' : `pagent.exe failed (${code})`) : null)
    })
    helper.stdin!.end(request)
  }

  override _destroy(error: Error | null, done: (error: Error | null) => void) {
    this.helper?.kill()
    done(error)
  }
}

class PageantAgent extends OpenSSHAgent {
  constructor(private readonly helperPath: string) {
    super('pageant')
  }

  getStream(done: (error: Error | undefined, stream?: Duplex) => void) {
    done(undefined, new PageantSocket(this.helperPath))
  }
}

/** Whether an agent answers, listing its keys, in time. */
function answers(agent: BaseAgent) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), probeTimeout)
    agent.getIdentities((error) => {
      clearTimeout(timer)
      resolve(!error)
    })
  })
}

/** The user's SSH agent, the first that answers of those looked for: AGENT_NOT_FOUND if none does. */
export async function findSshAgent({
  env = process.env,
  platform = process.platform,
  pageantHelper,
  openSshPipe = windowsOpenSshPipe
}: FindSshAgentOptions = {}) {
  const socket = env.SSH_AUTH_SOCK
  const windows = platform === 'win32'
  const candidates: { agent: BaseAgent; name: string }[] = [
    ...(socket ? [{ agent: createAgent(socket), name: `SSH_AUTH_SOCK (${socket})` }] : []),
    ...(windows && pageantHelper ? [{ agent: new PageantAgent(pageantHelper), name: 'Pageant' }] : []),
    ...(windows ? [{ agent: new OpenSSHAgent(openSshPipe), name: 'the OpenSSH Authentication Agent' }] : [])
  ]
  for (const { agent } of candidates) if (await answers(agent)) return agent
  if (!candidates.length) throw new CoreError('AGENT_NOT_FOUND', 'SSH_AUTH_SOCK isn’t set')
  throw new CoreError('AGENT_NOT_FOUND', `None answered: ${candidates.map((c) => c.name).join(', ')}`)
}
