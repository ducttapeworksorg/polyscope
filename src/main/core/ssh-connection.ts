// Connecting to an SSH server and signing in (ADR 0006), apart from SSH Files itself so the other Source Types that
// reach a host over SSH can share it. It checks the server's host key before signing in, and reports failures as CoreErrors.

import { createHash } from 'node:crypto'
import ssh2, { type ParsedKey, type SFTPWrapper } from 'ssh2'
import type { HostKey } from '@shared/core-api'
import { CoreError } from './core-error'
import { networkCodes } from './network-errors'

const { Client, utils } = ssh2

export interface SshTarget {
  host: string
  port: number
  user: string
  /** The private key that signs in, as read from its file. */
  privateKey: string | Buffer
  /** The key's passphrase, if it's encrypted; ignored if it isn't. */
  passphrase?: string
}

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
  /** The connection's SFTP session, started the first time it's asked for. SFTP_UNAVAILABLE if the server has none. */
  sftp(): Promise<SFTPWrapper>
  /** Whether the connection has closed, by close() or because it dropped. */
  readonly closed: boolean
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
function privateKeyOf({ privateKey, passphrase }: SshTarget): ParsedKey {
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

/** Connects to an SSH server, checks its host key and signs in. */
export async function connectSsh(target: SshTarget, options: SshConnectOptions): Promise<SshConnection> {
  const key = privateKeyOf(target)
  const address = `${target.user}@${target.host}:${target.port}`
  const client = new Client()
  let closed = false
  // Set when the host key check refuses the server, as that's why connecting failed.
  let refusal: CoreError | undefined
  let sftp: Promise<SFTPWrapper> | undefined

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
        return reject(new CoreError('SIGN_IN_REFUSED', `${address} refused the key: ${error.message}`))
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
        sftp: () =>
          (sftp ??= new Promise<SFTPWrapper>((resolveSftp, rejectSftp) => {
            client.sftp((error, session) => {
              if (!error) return resolveSftp(session)
              sftp = undefined
              rejectSftp(
                closed
                  ? new CoreError('UNREACHABLE', `${address}: the connection closed`)
                  : new CoreError('SFTP_UNAVAILABLE', `${address} has no SFTP subsystem, or it's turned off: ${error.message}`)
              )
            })
          })),
        get closed() {
          return closed
        },
        close() {
          closed = true
          client.end()
        }
      })
    })
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        authHandler: [{ type: 'publickey', username: target.user, key }],
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
