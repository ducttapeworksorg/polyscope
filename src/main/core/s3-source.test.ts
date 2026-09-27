import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NewS3Source, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { hasTestStore, seedPrefix, testS3Source } from './s3-test-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-s3-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Settings for a store that needn't exist: nothing here connects to it. */
const offline = (changes: Partial<NewS3Source> = {}): NewS3Source => ({
  type: 's3',
  name: 'Bucket',
  host: 'http://127.0.0.1:1',
  bucket: 'logs',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI',
  ...changes
})

const names = (nodes: TreeNode[]) => nodes.map((node) => (node.kind === 'more' ? '…more' : node.kind === 'error' ? node.code : node.name))

describe('adding an S3 Source', () => {
  it('is listed with its settings normalised and only whether a secret key is set', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ host: ' minio.internal:9000/ ', prefix: '/app/logs/', pathStyle: true }))

    const expected = {
      id: added.id,
      type: 's3',
      name: 'Bucket',
      host: 'https://minio.internal:9000',
      bucket: 'logs',
      prefix: 'app/logs',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIAEXAMPLE',
      secretKeySet: true
    }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('keeps an explicit http scheme and region', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ host: 'http://localhost:9000', region: 'eu-west-2' }))

    expect(added).toMatchObject({ host: 'http://localhost:9000', region: 'eu-west-2', pathStyle: false, prefix: '' })
  })

  it('may leave the host blank for AWS itself', async () => {
    const core = createCore()

    expect(await core.addSource(offline({ host: '' }))).toMatchObject({ host: '' })
  })

  it.each([
    ['BUCKET_REQUIRED', { bucket: ' ' }],
    ['ACCESS_KEY_REQUIRED', { accessKeyId: '' }],
    ['SECRET_KEY_REQUIRED', { secretAccessKey: ' ' }],
    ['SECRET_KEY_REQUIRED', { secretAccessKey: undefined }],
    ['INVALID_HOST', { host: 'ftp://files.internal' }],
    ['INVALID_HOST', { host: 'http://' }]
  ] as const)('refuses settings with %s: %o', async (code, changes) => {
    const core = createCore()

    await expect(core.addSource(offline(changes))).rejects.toMatchObject({ code })
    expect(await core.listSources()).toEqual([])
  })

  it('is saved without waiting for its store to be reachable', async () => {
    const core = createCore()

    await core.addSource(offline())

    expect(await core.connectionState((await core.listSources())[0]!.id)).toEqual({ state: 'disconnected' })
  })
})

describe('an S3 Source’s secret key', () => {
  const reversed = {
    encrypt: (plain: string) => Buffer.from([...plain].reverse().join('')),
    decrypt: (encrypted: Buffer) => [...encrypted.toString()].reverse().join('')
  }
  const dataDir = () => join(dir, 'user-data')

  it('goes to the secret store, never into the saved registry', async () => {
    const secrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets })

    const source = await core.addSource(offline({ secretAccessKey: 'wJalrXUtnFEMI' }))

    expect(await secrets.get(source.id, 'secretKey')).toBe('wJalrXUtnFEMI')
    expect(await readFile(join(dataDir(), 'sources.json'), 'utf8')).not.toContain('wJalrXUtnFEMI')
    expect(JSON.stringify(await core.listSources())).not.toContain('wJalrXUtnFEMI')
  })

  it('is kept when an edit leaves it blank', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ secretAccessKey: 'first' }))

    const edited = await core.editSource(source.id, offline({ name: 'Renamed', secretAccessKey: '' }))

    expect(edited).toMatchObject({ name: 'Renamed', secretKeySet: true })
    expect(await secrets.get(source.id, 'secretKey')).toBe('first')
  })

  it('is replaced when an edit gives a new one', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ secretAccessKey: 'first' }))

    await core.editSource(source.id, offline({ secretAccessKey: 'rotated' }))

    expect(await secrets.get(source.id, 'secretKey')).toBe('rotated')
  })

  it('is reported as not set when the secret store has lost it, and connecting says so', async () => {
    const dataDirSecrets = createSecretStore({ dataDir: dataDir(), cipher: reversed })
    const core = createCore({ dataDir: dataDir(), secrets: dataDirSecrets })
    const source = await core.addSource(offline())
    await dataDirSecrets.remove(source.id)

    expect(await core.listSources()).toMatchObject([{ secretKeySet: false }])
    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'SECRET_KEY_REQUIRED' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'SECRET_KEY_REQUIRED' })
  })

  it('is forgotten when an edit makes the Source a Local Filesystem one', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    await core.editSource(source.id, { type: 'local', name: 'Local', rootPath: dir })

    expect(await secrets.get(source.id, 'secretKey')).toBeUndefined()
  })

  it('goes along with a duplicate', async () => {
    const secrets = createSecretStore({ cipher: reversed })
    const core = createCore({ secrets })
    const source = await core.addSource(offline({ secretAccessKey: 'shared' }))

    const copy = await core.duplicateSource(source.id)

    expect(copy).toMatchObject({ type: 's3', secretKeySet: true })
    expect(await secrets.get(copy.id, 'secretKey')).toBe('shared')
  })
})

describe('an S3 Source whose store can’t be reached', () => {
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

describe.skipIf(!hasTestStore)('an S3 Source against the test store', () => {
  const disposals: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  }, 120_000)
  const seeded = async (objects: Parameters<typeof seedPrefix>[0]) => {
    const { prefix, remove } = await seedPrefix(objects)
    disposals.push(remove)
    return prefix
  }

  it('connects and lists its prefix as the root: key prefixes as folders, then files', async () => {
    const prefix = await seeded({ 'b.log': 'b', 'A.txt': 'a', 'zeta/x.log': 'x', 'alpha/y.log': 'y', empty: null })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))

    const nodes = await core.connect(source.id)

    expect(nodes).toMatchObject([
      { kind: 'folder', name: 'alpha', path: 'alpha' },
      { kind: 'folder', name: 'empty', path: 'empty' },
      { kind: 'folder', name: 'zeta', path: 'zeta' },
      { kind: 'file', name: 'A.txt', path: 'A.txt', size: 1 },
      { kind: 'file', name: 'b.log', path: 'b.log', size: 1 }
    ])
    expect(await core.connectionState(source.id)).toEqual({ state: 'connected' })
  })

  it('gives files their size and modified time, and folders neither', async () => {
    const prefix = await seeded({ 'app/server.log': 'twelve bytes' })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))
    const before = Date.now() - 10 * 60_000

    const [folder] = await core.connect(source.id)
    const [file] = await core.expand(source.id, 'app')

    expect(folder).not.toHaveProperty('size')
    expect(folder).not.toHaveProperty('modifiedTime')
    expect(file).toMatchObject({ kind: 'file', path: 'app/server.log', size: 12, icon: 'log' })
    expect(file?.kind === 'file' && file.modifiedTime).toBeGreaterThan(before)
  })

  it('goes into the Error state with bad credentials', async () => {
    const prefix = await seeded({ 'a.log': 'a' })
    const core = createCore()
    const source = await core.addSource({ ...testS3Source('Bucket', prefix), secretAccessKey: 'not-the-secret' })

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'AUTH_FAILED' })
  })

  it('reports a bucket that doesn’t exist', async () => {
    const core = createCore()
    const source = await core.addSource({ ...testS3Source('Bucket', ''), bucket: 'no-such-bucket-polyscope' })

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'BUCKET_NOT_FOUND' })
  })

  it('pages a large prefix 1,000 entries at a time, ending each page but the last in a more node', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 1050; i++) objects[`big/file-${String(i).padStart(4, '0')}.log`] = ''
    const prefix = await seeded(objects)
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))
    await core.connect(source.id)

    const first = await core.expand(source.id, 'big')
    const more = first.at(-1)
    expect(first).toHaveLength(1001)
    expect(more).toMatchObject({ kind: 'more', path: 'big', cursor: expect.any(String) })
    const second = await core.expand(source.id, 'big', more?.kind === 'more' ? more.cursor : undefined)

    expect(second).toHaveLength(50)
    expect([...names(first.slice(0, -1)), ...names(second)]).toEqual(Object.keys(objects).map((key) => key.slice('big/'.length)))
  }, 300_000)

  it('opens a file', async () => {
    const text = 'first line\nsecond line — ünïcode\n'
    const prefix = await seeded({ 'app/server.log': text })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))
    await core.connect(source.id)

    const file = await core.openFile(source.id, 'app/server.log')

    expect(file).toMatchObject({ view: 'editor', name: 'server.log', content: text, encoding: 'utf-8', size: 37 })
  })

  it('reports a key that’s gone as an error node when expanding', async () => {
    const prefix = await seeded({ 'a.log': 'a' })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))
    await core.connect(source.id)

    expect(names(await core.expand(source.id, 'gone'))).toEqual(['NOT_FOUND'])
  })

  it('passes a connection test, using the stored secret key when editing leaves it blank', async () => {
    const prefix = await seeded({ 'a.log': 'a' })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))

    await core.testConnection(testS3Source('Bucket', prefix))
    await core.testConnection({ ...testS3Source('Bucket', prefix), secretAccessKey: '' }, source.id)
    await expect(core.testConnection({ ...testS3Source('Bucket', prefix), secretAccessKey: 'wrong' }, source.id)).rejects.toMatchObject({
      code: 'AUTH_FAILED'
    })
  })

  it('needs connecting afresh after its secret key changes', async () => {
    const prefix = await seeded({ 'a.log': 'a' })
    const core = createCore()
    const source = await core.addSource(testS3Source('Bucket', prefix))
    await core.connect(source.id)

    await core.editSource(source.id, { ...testS3Source('Bucket', prefix), secretAccessKey: 'rotated' })

    expect(await core.connectionState(source.id)).toEqual({ state: 'disconnected' })
  })
})
