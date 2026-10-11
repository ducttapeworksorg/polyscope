// The parts of the user's ~/.ssh/config SSH Files reads (ADR 0006): Host, HostName, User, Port, IdentityFile and
// ProxyJump, and Include to read other files, resolved for a host as OpenSSH's ssh resolves them. ProxyCommand is
// noticed only to say it isn't supported; every other option is ignored. The files are read but never written.

import { readdir, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { CoreError } from './core-error'

/** What the config says about a host: OpenSSH's own defaults aren't filled in. */
export interface SshHostConfig {
  /** The host to connect to: HostName, or the host itself if it names none. */
  hostName: string
  user?: string
  port?: number
  /** The key files to sign in with, `~` and `%` tokens expanded, in the order given. */
  identityFiles: string[]
  /** The bastions to go through first, as ProxyJump names them: `[user@]host[:port]` or `ssh://` URIs; none if it names none. */
  proxyJump: string[]
  /** The ProxyCommand the host needs, which Polyscope can't run; left out if it needs none. */
  proxyCommand?: string
}

export interface SshConfig {
  /** What the config says about a host, as named to ssh: an alias, or a host name. */
  resolve(host: string): SshHostConfig
  /** The aliases its Host lines name: those without wildcards or negations, each once, in the order they come. */
  hosts(): string[]
}

/** Whether a line applies to a host: those under a Host line (or Match) apply only to the hosts it matches. */
type Applies = (host: string) => boolean

/** A config line: its keyword, lowercased, its arguments, and the Host line it comes under. */
interface Entry {
  keyword: string
  args: string[]
  applies: Applies
}

/** As deep as Includes go, as in OpenSSH: further ones, likely a loop, are skipped. */
const maxIncludeDepth = 16

/**
 * A line's keyword and arguments: `Keyword value`, or `Keyword=value`, arguments in double quotes kept whole, and a
 * `#` comment ending the line left out.
 */
function entryOf(line: string): Omit<Entry, 'applies'> | undefined {
  const match = /^\s*([^\s=]+)\s*(?:=\s*|\s|$)(.*)$/.exec(line)
  if (!match || match[1]!.startsWith('#')) return undefined
  const args: string[] = []
  for (const [, quoted, word] of match[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (word?.startsWith('#')) break
    args.push(quoted ?? word!)
  }
  return { keyword: match[1]!.toLowerCase(), args }
}

const hasWildcard = (pattern: string) => /[*?]/.test(pattern)

/** A pattern as a regular expression: `*` any characters, `?` any one, case aside. */
const patternRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

/** Whether a Host line's patterns match `host`: one does, and none negated with `!` does. */
function hostMatches(patterns: string[], host: string) {
  if (patterns.some((p) => p.startsWith('!') && patternRegExp(p.slice(1)).test(host))) return false
  return patterns.some((p) => !p.startsWith('!') && patternRegExp(p).test(host))
}

/** Expands `%` tokens, as OpenSSH does: those in `tokens`, and `%%` as `%`. */
const expandTokens = (value: string, tokens: Record<string, string>) =>
  value.replace(/%(.)/g, (whole, token: string) => (token === '%' ? '%' : (tokens[token] ?? whole)))

/** `~` at the start of a path as the home folder. */
const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path)

/** The files a path names, each wildcard in it matched against what's there, in lexical order; none if there are none. */
async function filesMatching(path: string): Promise<string[]> {
  const [first = '', ...segments] = normalize(path).split(/[\\/]/)
  let found = [first || '/']
  for (const segment of segments.filter(Boolean)) {
    if (!hasWildcard(segment)) {
      found = found.map((folder) => join(folder, segment))
      continue
    }
    const matcher = patternRegExp(segment)
    const listed = await Promise.all(
      found.map(async (folder) => (await readdir(folder).catch(() => [])).filter((name) => matcher.test(name)).sort().map((name) => join(folder, name)))
    )
    found = listed.flat()
  }
  return found
}

/** The user's ~/.ssh/config, and the files it Includes, read now; empty if there isn't one. */
export async function readSshConfig(): Promise<SshConfig> {
  const sshFolder = join(homedir(), '.ssh')
  const entries: Entry[] = []
  const aliases = new Set<string>()

  /**
   * Reads a config file's lines, applying only where `within` does (the Host line an Include comes under): those
   * before its first Host line apply wherever that does, and those under a Host line of its own only there too.
   */
  const readConfigFile = async (file: string, within: Applies, depth: number) => {
    let applies = within
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split(/\r?\n/)) {
      const entry = entryOf(line)
      if (!entry) continue
      if (entry.keyword === 'host') {
        const patterns = entry.args
        for (const pattern of patterns) if (!pattern.startsWith('!') && !hasWildcard(pattern)) aliases.add(pattern)
        applies = (host) => within(host) && hostMatches(patterns, host)
      } else if (entry.keyword === 'match') {
        // Only `Match all` is understood; any other Match block is skipped.
        const all = entry.args.length === 1 && entry.args[0]!.toLowerCase() === 'all'
        applies = (host) => all && within(host)
      } else if (entry.keyword === 'include') {
        if (depth >= maxIncludeDepth) continue
        for (const path of entry.args) {
          const expanded = expandHome(path)
          const files = await filesMatching(isAbsolute(expanded) ? expanded : join(sshFolder, expanded))
          for (const included of files) await readConfigFile(included, applies, depth + 1)
        }
      } else if (entry.args.length) {
        entries.push({ ...entry, applies })
      }
    }
  }
  await readConfigFile(join(sshFolder, 'config'), () => true, 0)

  return {
    resolve(name) {
      // Each option from the first line to give it, as ssh reads them; IdentityFiles add up. ProxyJump and
      // ProxyCommand rule each other out: the first of them given counts.
      const found: Partial<Record<string, string>> = {}
      const identityFiles: string[] = []
      let proxy: { keyword: string; value: string } | undefined
      for (const { keyword, args, applies } of entries) {
        if (!applies(name)) continue
        // A port that isn't one is passed over, as if not given.
        if (keyword === 'port' && !/^\d+$/.test(args[0]!)) continue
        if (keyword === 'identityfile') identityFiles.push(args[0]!)
        else if (keyword === 'proxyjump' || keyword === 'proxycommand') proxy ??= { keyword, value: args.join(' ') }
        else found[keyword] ??= args[0]
      }
      const hostName = expandTokens(found['hostname'] ?? name, { h: name })
      const { user, port } = found
      const localUser = userInfo().username
      const tokens = { h: hostName, n: name, d: homedir(), u: localUser, r: user ?? localUser, p: port ?? '22' }
      const needs = (keyword: string) => proxy?.keyword === keyword && proxy.value.toLowerCase() !== 'none'
      return {
        hostName,
        ...(user && { user }),
        ...(port && { port: Number(port) }),
        identityFiles: identityFiles.map((file) => normalize(expandHome(expandTokens(file, tokens)))),
        proxyJump: needs('proxyjump') ? proxy!.value.split(',').filter(Boolean) : [],
        ...(needs('proxycommand') && { proxyCommand: proxy!.value })
      }
    },

    hosts: () => [...aliases]
  }
}

/** A server on the way to a host, or the host itself: where it is, and who to sign in as and with what, if the config says. */
export interface SshEndpoint {
  host: string
  port: number
  user?: string
  identityFiles: string[]
}

/** A host as ssh is told it, on its command line or in a ProxyJump: what's given here wins over the config. */
export interface SshHostSpec {
  host: string
  user?: string
  port?: number
}

/** How far ProxyJumps may lead to further ProxyJumps before they're taken to go round in a loop. */
const maxJumpDepth = 8

/** A ProxyJump bastion: `[user@]host[:port]`, a bracketed IPv6 address, or `ssh://[user@]host[:port]`. */
function parseJump(jump: string): SshHostSpec {
  const spec = jump.replace(/^ssh:\/\//i, '').replace(/\/$/, '')
  const at = spec.lastIndexOf('@')
  const user = at < 0 ? undefined : spec.slice(0, at)
  const address = spec.slice(at + 1)
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(address) ?? /^([^:]+)(?::(\d+))?$/.exec(address)
  if (!match) throw new CoreError('UNSUPPORTED_SSH_OPTION', `Not a ProxyJump host Polyscope can read: ${jump}`)
  return { host: match[1]!, ...(user && { user }), ...(match[2] && { port: Number(match[2]) }) }
}

/**
 * The servers to go through to reach a host, bastions first and the host itself last, as ssh would go: ProxyJump's
 * bastions in order, the first of them reached through its own ProxyJump if it has one. Fails with
 * UNSUPPORTED_SSH_OPTION, naming it, for a host on the way that needs ProxyCommand.
 */
export function routeTo(config: SshConfig, destination: SshHostSpec): SshEndpoint[] {
  const route = (spec: SshHostSpec, depth: number, jumpsGiven?: string[]): SshEndpoint[] => {
    const resolved = config.resolve(spec.host)
    // As `ssh -J` would, bastions given in a ProxyJump stand in for any ProxyJump or ProxyCommand of the host's own.
    if (resolved.proxyCommand !== undefined && !jumpsGiven) {
      throw new CoreError('UNSUPPORTED_SSH_OPTION', `${spec.host} needs ProxyCommand (${resolved.proxyCommand}), which Polyscope doesn’t support`)
    }
    const endpoint: SshEndpoint = {
      host: resolved.hostName,
      port: spec.port ?? resolved.port ?? 22,
      ...((spec.user || resolved.user) && { user: spec.user || resolved.user }),
      identityFiles: resolved.identityFiles
    }
    const jumps = (jumpsGiven ?? resolved.proxyJump).map(parseJump)
    if (!jumps.length) return [endpoint]
    if (depth >= maxJumpDepth) throw new CoreError('UNSUPPORTED_SSH_OPTION', `${destination.host}'s ProxyJumps go round in a loop`)
    const [first, ...rest] = jumps
    return [...route(first!, depth + 1), ...rest.flatMap((jump) => route(jump, depth + 1, [])), endpoint]
  }
  return route(destination, 0)
}
