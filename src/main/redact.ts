const hidden = '[redacted]'

// Names whose values are secret, wherever they turn up: `secretAccessKey`, `X-Amz-Signature`, `access_token`,
// `client_secret`, a kubeconfig's `client-key-data`…
const secretName = String.raw`[\w.-]*(?:secret|password|passwd|pwd|passphrase|token|credential|signature|api[-_]?key|access[-_]?key|private[-_]?key|key[-_]?data)[\w.-]*`
// A value: quoted (JSON, or a shell-style `key="…"`), or bare up to the next separator.
const value = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&,;"'<>]+`

/** Keeps the quotes around a name and its value (JSON, say), hiding what's between the value's. */
const hideValue = (_match: string, quote: string, name: string, separator: string, secret: string) => {
  const valueQuote = secret.startsWith('"') || secret.startsWith("'") ? secret[0] : ''
  return `${quote}${name}${quote}${separator}${valueQuote}${hidden}${valueQuote}`
}

const rules: [RegExp, string | typeof hideValue][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  // The user (and password) part of `scheme://user:password@host`, up to the last `@` before the path, as the
  // password may hold one too; the host is kept, as it helps diagnose.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, `$1${hidden}@`],
  // The whole of an Authorization header's value, scheme included.
  [
    new RegExp(String.raw`(["']?)(authorization)\1(\s*[:=]\s*)((?:(?:bearer|basic|digest|token|negotiate)\s+)?(?:${value}))`, 'gi'),
    hideValue
  ],
  // Cookies, every one of them to the end of the line.
  [/\b((?:set-)?cookie)(\s*[:=]\s*)[^\r\n]+/gi, `$1$2${hidden}`],
  [new RegExp(String.raw`(["']?)(${secretName})\1(\s*[:=]\s*)(${value})`, 'gi'), hideValue],
  [/\b(bearer)\s+[\w.~+/=-]+/gi, `$1 ${hidden}`],
  // AWS access key IDs and JWTs are recognisable on their own, whatever surrounds them.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, hidden],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, hidden]
]

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Removes secrets from text about to leave the machine (a diagnostics report, say): private keys, the credentials
 * in URLs, secret-named keys and query parameters, Authorization headers, cookies, bearer tokens, AWS access key
 * IDs and JWTs.
 * With `homeDir`, it's shown as `~`, keeping the user's name out too. Errs towards hiding too much.
 */
export function redact(text: string, options: { homeDir?: string } = {}): string {
  let result = text
  for (const [pattern, replacement] of rules) result = result.replace(pattern, replacement as string)
  const { homeDir } = options
  if (homeDir) {
    // Windows paths are case-insensitive; elsewhere only the exact directory (not /home/alicia for /home/alice) matches.
    const flags = homeDir.includes('\\') ? 'gi' : 'g'
    result = result.replace(new RegExp(`${escapeRegExp(homeDir)}(?![\\w.-])`, flags), '~')
  }
  return result
}
