// Connecting to an SSH server and signing in (ADR 0006), apart from SSH Files itself so the other Source Types that
// reach a host over SSH can share it. It checks the server's host key before signing in, and reports failures as CoreErrors.

import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import ssh2, { type AnyAuthMethod, type BaseAgent, type ParsedKey, type SFTPWrapper } from 'ssh2'
import type { HostKey } from '@shared/core-api'
import { CoreError } from './core-error'
import { networkCodes } from './network-errors'

const { Client, utils } = ssh2

/** How a connection signs in: with a private key, a key in an SSH agent (see ssh-agent.ts), or a password. */
export type SshSignIn =
  | {
      /** The private key that signs in, as read from its file. */
      privateKey: string | Buffer
      /** The key's passphrase, if it's encrypted; ignored if it isn't. */
      passphrase?: string
    }
  | { agent: BaseAgent }
  | { password: string }

export type SshTarget = { host: string; port: number; user: string } & SshSignIn

/** A host key as the server presented it: its type and fingerprint, and the key itself in SSH's wire format. */
export interface PresentedHostKey {
  keyType: string
  fingerprint: string
  blob: Buffer
}

/** What's known about a presented host key: the one known for its server, unknown, or not the one known. */
export type HostKeyVerdict = 'trusted' | 'unknown' | 'changed'

export interface SshConnectOptions {
  /** Says whether the server's host key is the one known for it; nothing is sent to a server it isn't trusted for. */
  checkHostKey(key: PresentedHostKey): HostKeyVerdict | Promise<HostKeyVerdict>
  /** Host key types to ask the server for first, e.g. those already known for it, so it presents a known one. */
  preferredHostKeyTypes?: string[]
  /** How long connecting and signing in may take, in milliseconds. */
  timeout?: number
}

/** One signed-in connection to an SSH server, shared by everything that talks to it until it's closed. */
export interface SshConnection {
  /** The user signed in as, whose permissions everything over the connection has. */
  readonly user: string
  /** The connection's SFTP session, started the first time it's asked for. SFTP_UNAVAILABLE if the server has none. */
  sftp(): Promise<SFTPWrapper>
  /** Whether the connection has closed, by close() or because it dropped. */
  readonly closed: boolean
  /** Calls `listener` once the connection drops, closing other than by close(); straight away if it already has. */
  onDrop(listener: () => void): void
  close(): void
}

/** A host key's fingerprint, as OpenSSH shows it. */
export const fingerprintOf = (blob: Buffer) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`

/** The key type a host key in SSH's wire format starts with, e.g. `ssh-ed25519`. */
const keyTypeOf = (blob: Buffer) => (blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1') : '')

/** The host key algorithms that present a key of each type: an RSA key is signed with SHA-2 by preference. */
const algorithmsFor: Record<string, string[]> = {
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
}

/**
 * The private key, decrypted with its passphrase if it's encrypted, failing with what's wrong with it. Decrypting is
 * slow (bcrypt, deliberately), so it's done once, here, and ssh2 is handed the key ready to use.
 */
function privateKeyOf({ privateKey, passphrase }: { privateKey: string | Buffer; passphrase?: string }): ParsedKey {
  let parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) {
    if (!/passphrase/i.test(parsed.message)) throw new CoreError('KEY_FILE_UNREADABLE', `Not a private key Polyscope can read: ${parsed.message}`)
    if (!passphrase) throw new CoreError('PASSPHRASE_REQUIRED', 'The key file is encrypted: enter its passphrase')
    parsed = utils.parseKey(privateKey, passphrase)
    if (parsed instanceof Error) throw new CoreError('PASSPHRASE_WRONG', `The key file's passphrase is wrong: ${parsed.message}`)
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  // A public key file, say, picked by mistake.
  if (!key || !key.isPrivateKey()) throw new CoreError('KEY_FILE_UNREADABLE', 'The key file holds no private key')
  return key
}

/** A server to go through on the way to another (a ProxyJump bastion), and how to check its host key. */
export interface SshJump {
  target: SshTarget
  options: SshConnectOptions
}

/** A client signed in to one server, and whether it has closed since. */
interface SignedIn {
  client: InstanceType<typeof Client>
  readonly closed: boolean
}

/** Connects to one SSH server, over `sock` if given (a channel forwarded by a bastion), checks its host key and signs in. */
function signIn(target: SshTarget, options: SshConnectOptions, sock?: Duplex): Promise<SignedIn> {
  const username = target.user
  // Only the one way of signing in is tried: the user picked it.
  const method: AnyAuthMethod =
    'agent' in target
      ? { type: 'agent', username, agent: target.agent }
      : 'password' in target
        ? { type: 'password', username, password: target.password }
        : { type: 'publickey', username, key: privateKeyOf(target) }
  const refused = { agent: 'refused every key in the SSH agent', password: 'refused the password', publickey: 'refused the key' }[method.type]
  const address = addressOf(target)
  const client = new Client()
  let closed = false
  // Set when the host key check refuses the server, as that's why connecting failed.
  let refusal: CoreError | undefined

  const hostVerifier = (blob: Buffer, verify: (valid: boolean) => void) => {
    const presented = { keyType: keyTypeOf(blob), fingerprint: fingerprintOf(blob), blob }
    const hostKey: HostKey = { host: target.host, port: target.port, keyType: presented.keyType, fingerprint: presented.fingerprint }
    Promise.resolve(options.checkHostKey(presented)).then(
      (verdict) => {
        if (verdict === 'unknown') {
          refusal = new CoreError('HOST_KEY_UNKNOWN', `${target.host}'s ${hostKey.keyType} host key isn't known: ${hostKey.fingerprint}`, hostKey)
        } else if (verdict === 'changed') {
          refusal = new CoreError(
            'HOST_KEY_CHANGED',
            `${target.host}'s ${hostKey.keyType} host key isn't the one known for it (${hostKey.fingerprint}): someone may be impersonating it`
          )
        }
        verify(verdict === 'trusted')
      },
      (error: unknown) => {
        refusal = error instanceof CoreError ? error : new CoreError('UNKNOWN', String(error))
        verify(false)
      }
    )
  }

  const preferred = (options.preferredHostKeyTypes ?? []).flatMap((type) => algorithmsFor[type] ?? [type])

  return new Promise((resolve, reject) => {
    // Only the first outcome counts: a connection failing goes on to emit more errors, and a close.
    let settled = false
    const fail = (error: Error & { level?: string; code?: string }) => {
      closed = true
      client.end()
      if (settled) return
      settled = true
      if (refusal) return reject(refusal)
      if (error.level === 'client-authentication') {
        return reject(new CoreError('SIGN_IN_REFUSED', `${address} ${refused}: ${error.message}`))
      }
      if (error.level === 'client-timeout') return reject(new CoreError('UNREACHABLE', `${address}: timed out connecting`))
      if (networkCodes.has(error.code ?? '') || error.level === 'client-socket' || error.level === 'client-dns') {
        return reject(new CoreError('UNREACHABLE', `${address}: ${error.message}`))
      }
      reject(new CoreError('UNKNOWN', `${address}: ${error.message}`))
    }
    // Errors after signing in end the connection too; the calls under way then fail with them.
    client.on('error', fail)
    client.on('close', () => fail(Object.assign(new Error('the connection closed'), { level: 'client-socket' })))
    client.once('ready', () => {
      settled = true
      resolve({
        client,
        get closed() {
          return closed
        }
      })
    })
    try {
      client.connect({
        host: target.host,
        port: target.port,
        ...(sock && { sock }),
        username: target.user,
        authHandler: [method],
        readyTimeout: options.timeout ?? 20_000,
        keepaliveInterval: 15_000,
        hostVerifier,
        ...(preferred.length && { algorithms: { serverHostKey: { prepend: preferred } as never } })
      } as never)
    } catch (error) {
      fail(error as Error)
    }
  })
}

/** How a server is named in messages: `user@host:port`. */
const addressOf = ({ user, host, port }: SshTarget) => `${user}@${host}:${port}`

/** A channel from a signed-in bastion to the next server along, for the next connection to go over. */
function forward(bastion: SignedIn, from: SshTarget, to: SshTarget) {
  return new Promise<Duplex>((resolve, reject) => {
    bastion.client.forwardOut('127.0.0.1', 0, to.host, to.port, (error, channel) => {
      if (!error) return resolve(channel)
      reject(new CoreError('UNREACHABLE', `${addressOf(from)} couldn't reach ${to.host}:${to.port}: ${error.message}`))
    })
  })
}

/**
 * Connects to an SSH server, checks its host key and signs in. With `jumps`, it goes through each of them in turn,
 * as ssh's ProxyJump does: each is connected to over a channel the one before forwards, its own host key checked.
 */
export async function connectSsh(target: SshTarget, options: SshConnectOptions, jumps: SshJump[] = []): Promise<SshConnection> {
  const bastions: SignedIn[] = []
  const closeBastions = () => {
    for (const bastion of bastions) bastion.client.end()
  }
  let sock: Duplex | undefined
  let signedIn: SignedIn
  try {
    for (const [index, jump] of jumps.entries()) {
      const bastion = await signIn(jump.target, jump.options, sock)
      bastions.push(bastion)
      sock = await forward(bastion, jump.target, (jumps[index + 1] ?? { target }).target)
    }
    signedIn = await signIn(target, options, sock)
  } catch (error) {
    closeBastions()
    throw error
  }
  const { client } = signedIn
  const address = addressOf(target)
  let sftp: Promise<SFTPWrapper> | undefined
  // A bastion is closed along with the connection through it: when that closes, so does the channel through it.
  client.on('close', closeBastions)
  // Set by close(): the connection closing after that hasn't dropped.
  let closing = false

  return {
    user: target.user,
    sftp: () =>
      (sftp ??= new Promise<SFTPWrapper>((resolveSftp, rejectSftp) => {
        client.sftp((error, session) => {
          if (!error) return resolveSftp(session)
          sftp = undefined
          rejectSftp(
            signedIn.closed
              ? new CoreError('UNREACHABLE', `${address}: the connection closed`)
              : new CoreError('SFTP_UNAVAILABLE', `${address} has no SFTP subsystem, or it's turned off: ${error.message}`)
          )
        })
      })),
    get closed() {
      return signedIn.closed
    },
    onDrop(listener) {
      if (signedIn.closed) {
        if (!closing) queueMicrotask(listener)
        return
      }
      client.once('close', () => closing || listener())
    },
    close() {
      closing = true
      client.end()
      closeBastions()
    }
  }
}
