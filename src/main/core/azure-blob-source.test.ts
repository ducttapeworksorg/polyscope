import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LargeFileSearchEvent, NewAzureBlobSource, TreeNode } from '@shared/core-api'
import { MB } from '@shared/settings'
import { hasTestAccount, seedPrefix, takesTokens, testAzureBlobSource, testEndpoint, testSasUrl } from './azure-blob-test-store'
import { expiredAzureCli, startManagedIdentity } from './azure-test-identity'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { startProxy, startTlsFront } from './test-network'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-azure-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

/** A connection string for an account that needn't exist: nothing here connects to it. */
const offlineConnectionString =
  'DefaultEndpointsProtocol=http;AccountName=contosologs;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:1/contosologs;'

/** Settings for an account that needn't exist: nothing here connects to it. */
const offline = (changes: Partial<NewAzureBlobSource> = {}): NewAzureBlobSource => ({
  type: 'azureBlob',
  name: 'Logs',
  account: 'contosologs',
  container: 'logs',
  connectionString: offlineConnectionString,
  ...changes
})

/** A SAS URL for the offline account's `logs` container that needn't work: nothing here connects with it. */
const offlineSasUrl = 'https://contosologs.blob.core.windows.net/logs?sv=2025-01-05&se=2099-01-01T00%3A00%3A00Z&sr=c&sp=rl&sig=c2lnbmF0dXJl'

/** Settings signing in to the offline account with a SAS. */
const offlineSas = (changes: Partial<NewAzureBlobSource> = {}) => offline({ auth: 'sas', connectionString: undefined, sas: offlineSasUrl, ...changes })

/** A cipher that keeps secrets out of plain sight, without a keyring. */
const reversed = {
  encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
  decrypt: (encrypted: Buffer) => [...encrypted.toString()].reverse().join('')
}

const names = (nodes: TreeNode[]) => nodes.map((node) => (node.kind === 'more' ? '…more' : node.kind === 'error' ? node.code : node.name))

describe('adding an Azure Blob Storage Source', () => {
  it('is listed with its settings normalised and only whether a connection string is set', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ account: ' contosologs ', container: ' logs ', prefix: '/app/logs/' }))

    const expected = {
      id: added.id,
      type: 'azureBlob',
      name: 'Logs',
      account: 'contosologs',
      container: 'logs',
      prefix: 'app/logs',
      endpoint: '',
      auth: 'connectionString',
      connectionStringSet: true,
      sasSet: false,
      caBundlePath: '',
      proxyUrl: ''
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })
})

describe('an Azure Blob Storage Source’s settings', () => {
  it.each([
    ['ACCOUNT_REQUIRED', { account: ' ' }],
    ['CONTAINER_REQUIRED', { container: '' }],
    ['CONNECTION_STRING_REQUIRED', { connectionString: ' ' }],
    ['CONNECTION_STRING_REQUIRED', { connectionString: undefined }],
    ['INVALID_CONNECTION_STRING', { connectionString: 'not a connection string' }],
    ['INVALID_CONNECTION_STRING', { account: 'otheraccount' }],
    ['INVALID_HOST', { auth: 'azureCli', endpoint: 'ftp://contosologs' }]
  ] as const)('are refused with %s: %o', async (code, changes) => {
    const core = createCore()

    await expect(core.addSource(offline(changes))).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it.each([
    ['SAS_REQUIRED', { sas: ' ' }],
    ['SAS_REQUIRED', { sas: undefined, connectionString: offlineConnectionString }],
    ['INVALID_SAS', { sas: 'sv=2025-01-05&sp=rl' }],
    ['INVALID_SAS', { sas: 'not a SAS' }],
    ['INVALID_SAS', { account: 'otheraccount' }],
    ['INVALID_SAS', { container: 'other' }]
  ] as const)('signing in with a SAS are refused with %s: %o', async (code, changes) => {
    const core = createCore()

    await expect(core.addSource(offlineSas(changes))).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it('take a SAS token alone, or an account SAS URL, for any container', async () => {
    const core = createCore()
    const token = new URL(offlineSasUrl).search

    await core.addSource(offlineSas({ sas: token }))
    await core.addSource(offlineSas({ sas: token.slice(1) }))
    await core.addSource(offlineSas({ container: 'other', sas: offlineSasUrl.replace('/logs?', '/?') }))

    expect(await core.listSources()).toHaveLength(3)
  })

  it('signing in through Azure CLI need nothing more, and keep no secret', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })

    const source = await core.addSource(offline({ auth: 'azureCli', endpoint: 'https://contosologs.blob.core.usgovcloudapi.net/' }))

    expect(source).toMatchObject({ auth: 'azureCli', endpoint: 'https://contosologs.blob.core.usgovcloudapi.net', connectionStringSet: false, sasSet: false })
    expect(await secrets.get(source.id, 'connectionString')).toBeUndefined()
  })

  it('are saved without waiting for the account to be reachable', async () => {
    const core = createCore()

    const source = await core.addSource(offline())

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})

describe('an Azure Blob Storage Source’s connection string', () => {
  const dataDir = () => join(dir, 'user-data')

  it('goes to the secret store, never into the saved registry', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets })

    const source = await core.addSource(offline())

    expect(await secrets.get(source.id, 'connectionString')).toBe(offlineConnectionString)
    expect(await readFile(join(dataDir(), 'sources.json'), 'utf8')).not.toContain('AccountKey')
    expect(JSON.stringify(await core.listSources())).not.toContain('AccountKey')
  })

  it('is kept when an edit leaves it blank', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    const edited = await core.editSource(source.id, offline({ name: 'Renamed', connectionString: '' }))

    expect(edited).toMatchObject({ name: 'Renamed', connectionStringSet: true })
    expect(await secrets.get(source.id, 'connectionString')).toBe(offlineConnectionString)
  })

  it('must be for the account an edit names, even when it’s kept', async () => {
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.editSource(source.id, offline({ account: 'otheraccount', connectionString: '' }))).rejects.toMatchObject({
      code: 'INVALID_CONNECTION_STRING'
    })
  })

  it('is replaced when an edit gives a new one', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())
    const rotated = offlineConnectionString.replace('AccountKey=a2V5', 'AccountKey=cm90YXRlZA==')

    await core.editSource(source.id, offline({ connectionString: rotated }))

    expect(await secrets.get(source.id, 'connectionString')).toBe(rotated)
  })

  it('is reported as not set when the secret store has lost it, and connecting says so', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets })
    const source = await core.addSource(offline())
    await secrets.remove(source.id)

    expect(await core.listSources()).toMatchObject([{ connectionStringSet: false }])
    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CONNECTION_STRING_REQUIRED' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'CONNECTION_STRING_REQUIRED' })
  })

  it('is forgotten when an edit makes the Source a Local Filesystem one', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    await core.editSource(source.id, { type: 'local', name: 'Local', rootPath: dir })

    expect(await secrets.get(source.id, 'connectionString')).toBeUndefined()
  })

  it('goes along with a duplicate', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    const copy = await core.duplicateSource(source.id)

    expect(copy).toMatchObject({ type: 'azureBlob', connectionStringSet: true })
    expect(await secrets.get(copy.id, 'connectionString')).toBe(offlineConnectionString)
  })

  it('is forgotten when the Source is deleted', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    await core.deleteSource(source.id)

    expect(await secrets.get(source.id, 'connectionString')).toBeUndefined()
  })
})

describe('an Azure Blob Storage Source’s SAS', () => {
  it('goes to the secret store, and is kept when an edit leaves it blank', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offlineSas())

    const edited = await core.editSource(source.id, offlineSas({ name: 'Renamed', sas: '' }))

    expect(edited).toMatchObject({ name: 'Renamed', auth: 'sas', sasSet: true, connectionStringSet: false })
    expect(await secrets.get(source.id, 'sas')).toBe(offlineSasUrl)
  })

  it('replaces a connection string when an edit switches to it, which is forgotten', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    await core.editSource(source.id, offlineSas())

    expect(await secrets.get(source.id, 'connectionString')).toBeUndefined()
    expect(await secrets.get(source.id, 'sas')).toBe(offlineSasUrl)
  })

  it('is forgotten when an edit switches to signing in through Azure CLI', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offlineSas())

    const edited = await core.editSource(source.id, offline({ auth: 'azureCli', connectionString: undefined }))

    expect(edited).toMatchObject({ auth: 'azureCli', sasSet: false })
    expect(await secrets.get(source.id, 'sas')).toBeUndefined()
  })

  it('goes along with a duplicate, and is forgotten when the Source is deleted', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offlineSas())

    const copy = await core.duplicateSource(source.id)
    await core.deleteSource(source.id)

    expect(await secrets.get(copy.id, 'sas')).toBe(offlineSasUrl)
    expect(await secrets.get(source.id, 'sas')).toBeUndefined()
  })

  it('that has expired is reported on connecting, saying when', async () => {
    const core = createCore()
    const source = await core.addSource(offlineSas({ sas: offlineSasUrl.replace('se=2099', 'se=2020') }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'SAS_EXPIRED', message: expect.stringContaining('2020-01-01') })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'SAS_EXPIRED' })
  })
})

describe('an Azure Blob Storage Source’s endpoint, trust and proxy settings', () => {
  it('are normalised', async () => {
    const added = await createCore().addSource(
      offline({ endpoint: 'contosologs.blob.core.chinacloudapi.cn/', caBundlePath: ' /etc/ssl/corp.pem ', proxyUrl: ' proxy.corp:3128/ ' })
    )

    expect(added).toMatchObject({ endpoint: 'https://contosologs.blob.core.chinacloudapi.cn', caBundlePath: '/etc/ssl/corp.pem', proxyUrl: 'http://proxy.corp:3128' })
  })

  it.each(['socks5://proxy.corp:1080', 'http://'])('refuse a proxy that isn’t an http(s) address: %s', async (proxyUrl) => {
    await expect(createCore().addSource(offline({ proxyUrl }))).rejects.toMatchObject({ code: 'INVALID_PROXY' })
  })

  it('take their defaults for a Source saved before they existed', async () => {
    const dataDir = join(dir, 'user-data')
    await mkdir(dataDir)
    const saved = { id: 'old', type: 'azureBlob', name: 'Old', account: 'contosologs', container: 'logs', prefix: '' }
    await writeFile(join(dataDir, 'sources.json'), JSON.stringify({ version: 1, sources: [saved], groupOrder: ['local', 'azureBlob'] }))

    const [source] = await createCore({ dataDir }).listSources()

    expect(source).toMatchObject({ auth: 'connectionString', endpoint: '', caBundlePath: '', proxyUrl: '' })
  })

  it('keep a Source from connecting when its CA bundle can’t be read, or holds no certificates', async () => {
    const empty = join(dir, 'empty.pem')
    await writeFile(empty, 'not a certificate\n')
    const core = createCore()
    const missing = await core.addSource(offline({ caBundlePath: join(dir, 'missing.pem') }))
    const notCertificates = await core.addSource(offline({ caBundlePath: empty }))

    await expect(core.connect(missing.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
    await expect(core.connect(notCertificates.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
    await expect(core.testConnection(offline({ caBundlePath: empty }))).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
  })
})

describe('an Azure Blob Storage Source whose account can’t be reached', () => {
  it('goes into the Error state on connecting', async () => {
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'UNREACHABLE' })
  })

  it('fails a connection test', async () => {
    await expect(createCore().testConnection(offline())).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('is reported as an account that doesn’t exist when nothing has its name', async () => {
    // .invalid names never resolve (RFC 6761), as an account's name on Azure doesn't once there's no such account.
    const settings = offlineSas({ endpoint: 'http://contosologs.blob.core.invalid', sas: new URL(offlineSasUrl).search })

    await expect(createCore().testConnection(settings)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
  })
})

describe('an Azure Blob Storage Source signing in through Azure CLI', () => {
  const disposals: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  })

  it('whose sign-in has expired says to run az login again', async () => {
    const az = await expiredAzureCli()
    disposals.push(az.dispose)
    for (const [name, value] of Object.entries(az.env)) vi.stubEnv(name, value)
    const core = createCore()
    const source = await core.addSource(offline({ auth: 'azureCli', connectionString: undefined }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'AZURE_LOGIN_REQUIRED', message: expect.stringContaining('az login') })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'AZURE_LOGIN_REQUIRED' })
  }, 30_000)

  it('without a role that reads blobs names the role it needs', async () => {
    const identity = await startManagedIdentity()
    disposals.push(identity.close)
    for (const [name, value] of Object.entries(identity.env)) vi.stubEnv(name, value)
    // Azure, refusing an identity that has no data role on the account: Azurite gives every identity every role.
    const azure = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/xml', 'x-ms-error-code': 'AuthorizationPermissionMismatch' })
      response.end(
        '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationPermissionMismatch</Code>' +
          '<Message>This request is not authorized to perform this operation using this permission.</Message></Error>'
      )
    })
    await new Promise<void>((resolve) => azure.listen(0, '127.0.0.1', resolve))
    disposals.push(() => new Promise((resolve) => azure.close(() => resolve())))
    const front = await startTlsFront(`http://127.0.0.1:${(azure.address() as AddressInfo).port}`)
    disposals.push(front.close)
    // As though the private CA were the public one Azure's certificates come from.
    const trusted = getCACertificates('default')
    setDefaultCACertificates([...trusted, await readFile(front.caPath, 'utf8')])
    disposals.push(async () => setDefaultCACertificates(trusted))

    await expect(
      createCore().testConnection(offline({ auth: 'azureCli', connectionString: undefined, endpoint: `${front.url}/contosologs` }))
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED', message: expect.stringContaining('Storage Blob Data Reader') })
  })
})

describe('an Azure Blob Storage Source’s blobs', () => {
  it('aren’t offered to Follow, as they don’t grow', async () => {
    const core = createCore()
    const source = await core.addSource(offline())

    await expect(core.followFile(source.id, 'app.log')).rejects.toMatchObject({ code: 'NOT_FOLLOWABLE' })
  })
})

describe.skipIf(!hasTestAccount)('an Azure Blob Storage Source against the test account', () => {
  const disposals: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  }, 120_000)
  const seeded = async (blobs: Parameters<typeof seedPrefix>[0]) => {
    const { prefix, remove } = await seedPrefix(blobs)
    disposals.push(remove)
    return prefix
  }
  const connected = async (blobs: Parameters<typeof seedPrefix>[0], options: Parameters<typeof createCore>[0] = {}) => {
    const core = createCore(options)
    const source = await core.addSource(testAzureBlobSource('Logs', await seeded(blobs)))
    return { core, source, nodes: await core.connect(source.id) }
  }

  it('connects and lists its prefix as the root: name prefixes as folders, then blobs', async () => {
    const { core, source, nodes } = await connected({ 'b.log': 'b', 'A.txt': 'a', 'zeta/x.log': 'x', 'alpha/y.log': 'y', empty: null })

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'alpha', path: 'alpha' },
      { kind: 'folder', name: 'empty', path: 'empty' },
      { kind: 'folder', name: 'zeta', path: 'zeta' },
      { kind: 'file', name: 'A.txt', path: 'A.txt', size: 1 },
      { kind: 'file', name: 'b.log', path: 'b.log', size: 1 }
    ])
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('gives blobs their size and modified time, and folders neither', async () => {
    const before = Date.now() - 10 * 60_000
    const { core, source, nodes } = await connected({ 'app/server.log': 'twelve bytes' })

    const [file] = await core.expand(source.id, 'app')

    expect(nodes[0]).not.toHaveProperty('size')
    expect(nodes[0]).not.toHaveProperty('modifiedTime')
    expect(file).toMatchObject({ kind: 'file', path: 'app/server.log', size: 12, icon: 'log' })
    expect(file?.kind === 'file' && file.modifiedTime).toBeGreaterThan(before)
  })

  it('pages a large folder 1,000 entries at a time, ending each page but the last in a more node', async () => {
    const blobs: Record<string, string> = {}
    for (let i = 0; i < 1050; i++) blobs[`big/file-${String(i).padStart(4, '0')}.log`] = ''
    const { core, source } = await connected(blobs)

    const first = await core.expand(source.id, 'big')
    const more = first.at(-1)
    expect(first).toHaveLength(1001)
    expect(more).toMatchObject({ kind: 'more', path: 'big', cursor: expect.any(String) })
    const second = await core.expand(source.id, 'big', more?.kind === 'more' ? more.cursor : undefined)

    expect(second).toHaveLength(50)
    expect([...names(first.slice(0, -1)), ...names(second)]).toEqual(Object.keys(blobs).map((name) => name.slice('big/'.length)))
  }, 300_000)

  it('lists a blob and a name prefix sharing a name as a file and a folder, opening one and expanding the other', async () => {
    const { core, source, nodes } = await connected({ app: 'the blob', 'app/server.log': 'inside' })

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'app', path: 'app' },
      { kind: 'file', name: 'app', path: 'app' }
    ])
    expect(await core.expand(source.id, 'app')).toMatchObject([{ kind: 'file', path: 'app/server.log' }])
    expect(await core.openFile(source.id, 'app')).toMatchObject({ content: 'the blob' })
  })

  it('browses a Data Lake account’s directories as folders, empty ones included', async () => {
    const { core, source, nodes } = await connected({ logs: { directory: true }, 'logs/app.log': 'a', empty: { directory: true } })

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'empty', path: 'empty' },
      { kind: 'folder', name: 'logs', path: 'logs' }
    ])
    expect(names(await core.expand(source.id, 'logs'))).toEqual(['app.log'])
    expect(await core.expand(source.id, 'empty')).toEqual([])
  })

  it('opens a blob', async () => {
    const text = 'first line\nsecond line — ünïcode\n'
    const { core, source } = await connected({ 'app/server.log': text })

    expect(await core.openFile(source.id, 'app/server.log')).toMatchObject({ view: 'editor', name: 'server.log', content: text, encoding: 'utf-8', size: 37 })
  })

  it('opens gzip and zstd blobs decompressed', async () => {
    const text = 'compressed line\n'
    const { core, source } = await connected({ 'app.log.gz': gzipSync(text), 'app.log.zst': zstdCompressSync(Buffer.from(text)) })

    expect(await core.openFile(source.id, 'app.log.gz')).toMatchObject({ view: 'editor', content: text, compression: 'gzip' })
    expect(await core.openFile(source.id, 'app.log.zst')).toMatchObject({ view: 'editor', content: text, compression: 'zstd' })
  })

  it('opens a Large File at its end, then caches it through range reads, and searches it', async () => {
    const content = Array.from({ length: 300_000 }, (_, i) => (i === 12_345 ? 'an error\n' : `line ${i + 1}\n`)).join('')
    const { core, source } = await connected({ 'big.log': content }, { cacheDir: join(dir, 'cache') })
    await core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: MB, cacheSizeCap: 8 * MB })

    const file = await core.openFile(source.id, 'big.log')

    expect(file).toMatchObject({ view: 'large', encoding: 'utf-8' })
    if (file.view !== 'large') return
    expect(file.lastLines.at(-1)).toBe('line 300000')
    await vi.waitFor(async () => expect(await core.largeFileStatus(file.largeFileId)).toMatchObject({ state: 'ready', lineCount: 300_000 }), {
      timeout: 30_000,
      interval: 100
    })
    expect(await core.readLargeFileLines(file.largeFileId, 123_455, 2)).toEqual({ firstLine: 123_455, lines: ['line 123456', 'line 123457'] })
    const updates: LargeFileSearchEvent[] = []
    core.onLargeFileSearchEvent((event) => updates.push(event))
    await core.searchLargeFile(file.largeFileId, { pattern: 'error' })
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ kind: 'done', matchedLines: 1 }), { timeout: 30_000 })
    expect(updates.flatMap((u) => (u.kind === 'progress' ? u.matches.map((m) => m.line) : []))).toEqual([12_345])
    await core.closeLargeFile(file.largeFileId)
  }, 60_000)

  it('reports a blob that’s gone as an error node when expanding', async () => {
    const { core, source } = await connected({ 'a.log': 'a' })

    expect(names(await core.expand(source.id, 'gone'))).toEqual(['NOT_FOUND'])
  })

  it('goes into the Error state with a wrong account key', async () => {
    const settings = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const wrongKey = Buffer.from('not the key').toString('base64')
    const core = createCore()
    const source = await core.addSource({ ...settings, connectionString: settings.connectionString!.replace(/AccountKey=[^;]+/, `AccountKey=${wrongKey}`) })

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'AUTH_FAILED' })
  })

  it('reports a container that doesn’t exist', async () => {
    const core = createCore()
    const source = await core.addSource({ ...testAzureBlobSource('Logs', ''), container: 'no-such-container-polyscope' })

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CONTAINER_NOT_FOUND' })
  })

  it('passes a connection test, using the stored connection string when editing leaves it blank', async () => {
    const settings = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const core = createCore()
    const source = await core.addSource(settings)

    await core.testConnection(settings)
    await core.testConnection({ ...settings, connectionString: '' }, source.id)
    await expect(core.testConnection({ ...settings, container: 'no-such-container-polyscope', connectionString: '' }, source.id)).rejects.toMatchObject({
      code: 'CONTAINER_NOT_FOUND'
    })
  })

  it('signs in with a SAS URL, which reaches the account it names', async () => {
    const { account, container, prefix } = testAzureBlobSource('Logs', await seeded({ 'app/a.log': 'a' }))
    const core = createCore()

    const source = await core.addSource({ type: 'azureBlob', name: 'Logs', account, container, prefix, auth: 'sas', sas: await testSasUrl() })

    expect(source).toMatchObject({ auth: 'sas', sasSet: true, connectionStringSet: false })
    expect(names(await core.connect(source.id))).toEqual(['app'])
    expect(await core.openFile(source.id, 'app/a.log')).toMatchObject({ content: 'a' })
  })

  it('signs in with a SAS token alone, at the endpoint it’s given', async () => {
    const { account, container, prefix } = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const url = new URL(await testSasUrl())
    const endpoint = `${url.origin}/${account}`

    await createCore().testConnection({ type: 'azureBlob', name: 'Logs', account, container, prefix, endpoint, auth: 'sas', sas: url.search })
  })

  it.each([
    ['AUTH_FAILED', 'a wrong signature', (sas: string) => sas.replace(/sig=[^&]+/, 'sig=d3Jvbmc%3D')],
    ['PERMISSION_DENIED', 'no permission to list', (sas: string) => sas]
  ] as const)('reports %s for a SAS with %s', async (code, _, change) => {
    const { account, container, prefix } = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const sas = change(await testSasUrl({ permissions: code === 'PERMISSION_DENIED' ? 'r' : 'rl' }))

    await expect(createCore().testConnection({ type: 'azureBlob', name: 'Logs', account, container, prefix, auth: 'sas', sas })).rejects.toMatchObject({ code })
  })

  it.skipIf(!takesTokens)('signs in through Azure’s default credentials, a managed identity here, storing nothing', async () => {
    const identity = await startManagedIdentity()
    disposals.push(identity.close)
    for (const [name, value] of Object.entries(identity.env)) vi.stubEnv(name, value)
    const { account, container, prefix } = testAzureBlobSource('Logs', await seeded({ 'app/a.log': 'a' }))
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })

    const source = await core.addSource({ type: 'azureBlob', name: 'Logs', account, container, prefix, endpoint: testEndpoint, auth: 'azureCli' })

    expect(names(await core.connect(source.id))).toEqual(['app'])
    expect(await core.openFile(source.id, 'app/a.log')).toMatchObject({ content: 'a' })
    expect(await secrets.get(source.id, 'connectionString')).toBeUndefined()
    expect(await secrets.get(source.id, 'sas')).toBeUndefined()
  })

  describe('in a corporate network', () => {
    /**
     * The test account behind TLS, with a certificate from a private CA: its blob `endpoint` there, a `caBundlePath`
     * that trusts it, and the front's `host` (and port), as a proxy is asked to tunnel to it.
     */
    const behindTls = async () => {
      const front = await startTlsFront(testEndpoint)
      disposals.push(front.close)
      return { endpoint: `${front.url}${new URL(testEndpoint).pathname}`, caBundlePath: front.caPath, host: new URL(front.url).host }
    }
    const proxy = async () => {
      const started = await startProxy()
      disposals.push(started.close)
      return started
    }
    /** Settings signing in with a SAS token alone, at the blob endpoint they're given rather than Azure's. */
    const atEndpoint = async ({ endpoint, ...changes }: Partial<NewAzureBlobSource> & { endpoint: string }): Promise<NewAzureBlobSource> => {
      const { account, container } = testAzureBlobSource('Logs', '')
      const prefix = await seeded({ 'a.log': 'a' })
      return { type: 'azureBlob', name: 'Logs', account, container, prefix, endpoint, auth: 'sas', sas: new URL(await testSasUrl()).search, ...changes }
    }
    const connects = async (settings: NewAzureBlobSource) => {
      const core = createCore()
      const source = await core.addSource(settings)
      return names(await core.connect(source.id))
    }

    it('refuses a certificate from an unknown CA', async () => {
      const { endpoint } = await behindTls()
      const settings = await atEndpoint({ endpoint })
      const core = createCore()
      const source = await core.addSource(settings)

      await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
      await expect(core.testConnection(settings)).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
    })

    it('reaches the account at the endpoint it’s given, trusting a certificate from the CA bundle', async () => {
      const { endpoint, caBundlePath } = await behindTls()

      expect(await connects(await atEndpoint({ endpoint, caBundlePath }))).toEqual(['a.log'])
    })

    it('goes through its own proxy, whatever NO_PROXY says', async () => {
      vi.stubEnv('NO_PROXY', '*')
      const { url, tunnels } = await proxy()
      const { endpoint, caBundlePath, host } = await behindTls()

      expect(await connects(await atEndpoint({ endpoint, caBundlePath, proxyUrl: url }))).toEqual(['a.log'])
      expect(tunnels).toContain(host)
    })

    it('goes through HTTPS_PROXY without a proxy of its own', async () => {
      const { url, tunnels } = await proxy()
      vi.stubEnv('HTTPS_PROXY', url)
      vi.stubEnv('NO_PROXY', undefined)
      const { endpoint, caBundlePath, host } = await behindTls()

      expect(await connects(await atEndpoint({ endpoint, caBundlePath }))).toEqual(['a.log'])
      expect(tunnels).toContain(host)
    })

    it('goes straight to hosts NO_PROXY lists', async () => {
      const { url, tunnels } = await proxy()
      vi.stubEnv('HTTPS_PROXY', url)
      vi.stubEnv('NO_PROXY', '127.0.0.1')
      const { endpoint, caBundlePath } = await behindTls()

      expect(await connects(await atEndpoint({ endpoint, caBundlePath }))).toEqual(['a.log'])
      expect(tunnels).toEqual([])
    })

    it.skipIf(!takesTokens)('signs in through Azure’s default credentials through them too', async () => {
      const identity = await startManagedIdentity()
      disposals.push(identity.close)
      for (const [name, value] of Object.entries(identity.env)) vi.stubEnv(name, value)
      const { url, tunnels } = await proxy()
      const { endpoint, caBundlePath, host } = await behindTls()
      const { account, container } = testAzureBlobSource('Logs', '')
      const prefix = await seeded({ 'a.log': 'a' })

      expect(await connects({ type: 'azureBlob', name: 'Logs', account, container, prefix, endpoint, auth: 'azureCli', caBundlePath, proxyUrl: url })).toEqual(['a.log'])
      expect(tunnels).toContain(host)
    })

    it('signs in with a connection string through them too', async () => {
      const { url, tunnels } = await proxy()
      const { endpoint, caBundlePath, host } = await behindTls()
      const settings = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
      const connectionString = settings.connectionString!.replace(/BlobEndpoint=[^;]+/, `BlobEndpoint=${endpoint}`)

      expect(await connects({ ...settings, connectionString, caBundlePath, proxyUrl: url })).toEqual(['a.log'])
      expect(tunnels).toContain(host)
    })
  })

  it('needs connecting afresh after its connection string changes', async () => {
    const settings = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const core = createCore()
    const source = await core.addSource(settings)
    await core.connect(source.id)

    await core.editSource(source.id, { ...settings, connectionString: `${settings.connectionString};` })

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})
