// Which SSH host keys are known: those in the user's known_hosts, read but never written, and those the user
// trusted in Polyscope, kept in its own data folder.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostKey } from '@shared/core-api'
import { CoreError } from './core-error'
import { jsonFileWriter, readJsonFile } from './json-file'
import type { HostKeyVerdict, PresentedHostKey } from './ssh-connection'

export interface HostKeyStore {
  /** Whether a server's host key is known for it; one that's unknown can be trusted afterwards. */
  check(host: string, port: number, key: PresentedHostKey): Promise<HostKeyVerdict>
  /** The types of the host keys known for a server, to ask it for first. */
  knownTypes(host: string, port: number): Promise<string[]>
  /** Trusts a host key check() found unknown since the store was made: HOST_KEY_UNKNOWN for any other. */
  trust(hostKey: HostKey): Promise<void>
  /** Forgets the host keys trusted in Polyscope for a server; those in known_hosts aren't Polyscope's to forget. */
  forget(host: string, port: number): Promise<void>
}

/** A host key known for a server, from a known_hosts line or Polyscope's own store. */
interface KnownKey {
  keyType: string
  blob: Buffer
  /** A known_hosts `@revoked` line: the key is never trusted, for any server it names. */
  revoked?: boolean
}

// What's saved: each host key trusted, under the server's known_hosts name.
interface SavedKeys {
  version?: number
  keys?: { host: string; keyType: string; key: string }[]
}

/** How known_hosts names a server: its host alone on port 22, `[host]:port` on any other. */
const knownHostsName = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`).toLowerCase()

/** Whether `name` matches a known_hosts host pattern: `*` any characters, `?` any one. */
const matchesPattern = (pattern: string, name: string) => {
  const source = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(name)
}

/** Whether a known_hosts line's hosts field names `name`: hashed, as HashKnownHosts writes it, or a list of patterns. */
function namesHost(hosts: string, name: string) {
  if (hosts.startsWith('|1|')) {
    const [, , salt, hash] = hosts.split('|')
    if (!salt || !hash) return false
    const expected = Buffer.from(hash, 'base64')
    const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest()
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  const patterns = hosts.split(',')
  // A negated pattern that matches rules the line out, whatever else matches.
  if (patterns.some((p) => p.startsWith('!') && matchesPattern(p.slice(1), name))) return false
  return patterns.some((p) => !p.startsWith('!') && matchesPattern(p, name))
}

/** The keys a known_hosts file holds for a server; none if there's no such file. */
async function knownHostsKeys(file: string, name: string): Promise<KnownKey[]> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ''
    throw error
  })
  return text.split(/\r?\n/).flatMap((line): KnownKey[] => {
    const fields = line.trim().split(/\s+/)
    if (!fields[0] || fields[0].startsWith('#')) return []
    const marker = fields[0].startsWith('@') ? fields.shift() : undefined
    const [hosts, keyType, key] = fields
    // A CA's key vouches for certificates, which Polyscope doesn't take.
    if (!hosts || !keyType || !key || marker === '@cert-authority' || !namesHost(hosts, name)) return []
    return [{ keyType, blob: Buffer.from(key, 'base64'), ...(marker === '@revoked' && { revoked: true }) }]
  })
}

const sameKey = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

/** Where a key found unknown is kept until it's trusted: by its server's known_hosts name and its fingerprint. */
const offeredKey = (name: string, fingerprint: string) => `${name} ${fingerprint}`

/** The host keys Polyscope knows, keeping those the user trusts in `dataDir` (only in memory without one). */
export function createHostKeyStore({ dataDir }: { dataDir?: string } = {}): HostKeyStore {
  const file = dataDir && join(dataDir, 'trusted-host-keys.json')
  const write = file ? jsonFileWriter(file) : null
  const saved = (file ? readJsonFile(file) : Promise.resolve(undefined)).then((value) => ((value ?? {}) as SavedKeys).keys ?? [])
  // Keys found unknown, by the server's name and their fingerprint, which the user may go on to trust.
  const offered = new Map<string, PresentedHostKey>()
  // The user's own, as OpenSSH reads them by default; read each time, so changes to them count straight away.
  const knownHostsFiles = () => ['known_hosts', 'known_hosts2'].map((name) => join(homedir(), '.ssh', name))

  const knownKeys = async (name: string): Promise<KnownKey[]> => {
    const fromFiles = await Promise.all(knownHostsFiles().map((f) => knownHostsKeys(f, name)))
    const trusted = (await saved).filter((k) => k.host === name).map((k) => ({ keyType: k.keyType, blob: Buffer.from(k.key, 'base64') }))
    return [...fromFiles.flat(), ...trusted]
  }

  return {
    async check(host, port, key) {
      const name = knownHostsName(host, port)
      const known = await knownKeys(name)
      if (known.some((k) => k.revoked && sameKey(k.blob, key.blob))) return 'changed'
      const ofType = known.filter((k) => !k.revoked && k.keyType === key.keyType)
      if (ofType.some((k) => sameKey(k.blob, key.blob))) return 'trusted'
      if (ofType.length) return 'changed'
      offered.set(offeredKey(name, key.fingerprint), key)
      return 'unknown'
    },

    async knownTypes(host, port) {
      const known = await knownKeys(knownHostsName(host, port))
      return [...new Set(known.filter((k) => !k.revoked).map((k) => k.keyType))]
    },

    async trust({ host, port, fingerprint }) {
      const name = knownHostsName(String(host), Number(port))
      const key = offered.get(offeredKey(name, String(fingerprint)))
      if (!key) throw new CoreError('HOST_KEY_UNKNOWN', `${host}'s host key ${fingerprint} hasn't been offered: connect again to see it`)
      const keys = await saved
      if (!keys.some((k) => k.host === name && sameKey(Buffer.from(k.key, 'base64'), key.blob))) {
        const trusted = { host: name, keyType: key.keyType, key: key.blob.toString('base64') }
        // Kept only once saved, so a key that couldn't be saved isn't trusted just until the next launch.
        await write?.({ version: 1, keys: [...keys, trusted] } satisfies SavedKeys)
        keys.push(trusted)
      }
      offered.delete(offeredKey(name, String(fingerprint)))
    },

    async forget(host, port) {
      const name = knownHostsName(host, port)
      const keys = await saved
      if (!keys.some((k) => k.host === name)) return
      const kept = keys.filter((k) => k.host !== name)
      await write?.({ version: 1, keys: kept } satisfies SavedKeys)
      keys.splice(0, keys.length, ...kept)
    }
  }
}
