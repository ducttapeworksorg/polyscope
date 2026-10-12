import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LargeFileSearchEvent, NewAzureBlobSource, TreeNode } from '@shared/core-api'
import { MB } from '@shared/settings'
import { hasTestAccount, seedPrefix, testAzureBlobSource } from './azure-blob-test-store'
import { createCore } from './core'
import { createSecretStore } from './secret-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-azure-'))
})

afterEach(async () => {
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

const names = (nodes: TreeNode[]) => nodes.map((node) => (node.kind === 'more' ? '…more' : node.kind === 'error' ? node.code : node.name))

describe('adding an Azure Blob Storage Source', () => {
  it('is listed with its settings normalised and only whether a connection string is set', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ account: ' contosologs ', container: ' logs ', prefix: '/app/logs/' }))

    const expected = { id: added.id, type: 'azureBlob', name: 'Logs', account: 'contosologs', container: 'logs', prefix: 'app/logs', connectionStringSet: true }
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
    ['INVALID_CONNECTION_STRING', { account: 'otheraccount' }]
  ] as const)('are refused with %s: %o', async (code, changes) => {
    const core = createCore()

    await expect(core.addSource(offline(changes))).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it('are saved without waiting for the account to be reachable', async () => {
    const core = createCore()

    const source = await core.addSource(offline())

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})

describe('an Azure Blob Storage Source’s connection string', () => {
  const reversed = {
    encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
    decrypt: (encrypted: Buffer) => [...encrypted.toString()].reverse().join('')
  }
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

  it('needs connecting afresh after its connection string changes', async () => {
    const settings = testAzureBlobSource('Logs', await seeded({ 'a.log': 'a' }))
    const core = createCore()
    const source = await core.addSource(settings)
    await core.connect(source.id)

    await core.editSource(source.id, { ...settings, connectionString: `${settings.connectionString};` })

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})
