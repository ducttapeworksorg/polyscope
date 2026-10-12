// Shared Access Signatures for Azure Blob Storage, as a user pastes them: a SAS URL from the portal's "Generate SAS"
// or Storage Explorer, or the token alone. Read the same way by the core, signing in with one, and the renderer,
// filling in the account and container from a pasted URL.

/** What a SAS says about where it reaches, besides the token itself. */
export interface Sas {
  /** The query string that signs requests, without the leading '?'. */
  token: string
  /** A SAS URL's blob endpoint, like `https://contosologs.blob.core.windows.net`; none for a token alone. */
  endpoint?: string
  /** The storage account a SAS URL names, when its address says. */
  account?: string
  /** The container a SAS URL is for; none for an account SAS, or a token alone. */
  container?: string
  /** When the SAS stops working, if it says (its `se`). */
  expiresOn?: Date
}

const isIpOrLocalhost = (hostname: string) => hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.startsWith('[')

/** A SAS URL or token, read; undefined if it isn't one: no signature (`sig=`), or an address that isn't http(s). */
export function parseSas(input: string): Sas | undefined {
  const text = input.trim()
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && URL.canParse(text) ? new URL(text) : undefined
  if (url && !['http:', 'https:'].includes(url.protocol)) return undefined
  const token = (url ? url.search : text).replace(/^\?/, '')
  const params = new URLSearchParams(token)
  if (!params.get('sig')) return undefined
  const expiry = params.get('se')
  const expiresOn = expiry ? new Date(expiry) : undefined
  const sas: Sas = { token, ...(expiresOn && !Number.isNaN(expiresOn.getTime()) && { expiresOn }) }
  if (!url) return sas
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  // An emulator like Azurite names the account in the path, after its address; Azure in the host name, as
  // `<account>.blob.<cloud>` (or `.dfs.` for a Data Lake account, whose blobs the same account's blob endpoint reaches).
  if (isIpOrLocalhost(url.hostname)) {
    const [account, container] = segments
    return { ...sas, endpoint: `${url.origin}/${account ?? ''}`.replace(/\/$/, ''), ...(account && { account }), ...(container && { container }) }
  }
  const named = /^([^.]+)\.(?:blob|dfs)\.(.+)$/i.exec(url.hostname)
  const [container] = segments
  const endpoint = named ? `${url.protocol}//${named[1]}.blob.${named[2]}${url.port ? `:${url.port}` : ''}` : url.origin
  return { ...sas, endpoint, ...(named?.[1] && { account: named[1].toLowerCase() }), ...(container && { container }) }
}
