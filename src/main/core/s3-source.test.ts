import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewS3Source, TreeNode } from '@shared/core-api'
import { createCore } from './core'
import { createSecretStore } from './secret-store'
import { startProxy, startTlsFront } from './s3-test-network'
import { hasTestStore, seedPrefix, testS3Source } from './s3-test-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-s3-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

/** Points the AWS SDK (and Polyscope) at config and credentials files of the test's own, empty unless given. */
async function awsFiles({ config = '', credentials = '' } = {}) {
  const configFile = join(dir, 'aws-config')
  const credentialsFile = join(dir, 'aws-credentials')
  await writeFile(configFile, config)
  await writeFile(credentialsFile, credentials)
  vi.stubEnv('AWS_CONFIG_FILE', configFile)
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile)
  vi.stubEnv('AWS_PROFILE', undefined)
  vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)
}

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
      auth: 'keys',
      accessKeyId: 'AKIAEXAMPLE',
      secretKeySet: true,
      profile: '',
      verifyTls: true,
      caBundlePath: '',
      proxyUrl: ''
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

describe('an S3 Source signing in with an AWS profile', () => {
  const withProfile = (profile?: string) => offline({ auth: 'profile', profile, accessKeyId: undefined, secretAccessKey: undefined })
  const plain = { encrypt: (plain: string) => Buffer.from(plain), decrypt: (encrypted: Buffer) => encrypted.toString() }

  it('needs no keys, and is listed with its profile', async () => {
    const core = createCore()

    const added = await core.addSource(withProfile(' work-sso '))

    expect(added).toMatchObject({ auth: 'profile', profile: 'work-sso', accessKeyId: '', secretKeySet: false })
  })

  it('may leave the profile blank for the default credential chain', async () => {
    expect(await createCore().addSource(withProfile(''))).toMatchObject({ auth: 'profile', profile: '' })
  })

  it('keeps no keys typed before switching to a profile', async () => {
    const secrets = createSecretStore({ cipher: plain })
    const core = createCore({ secrets })

    const added = await core.addSource(offline({ auth: 'profile', profile: 'work' }))

    expect(added).toMatchObject({ accessKeyId: '', secretKeySet: false })
    expect(await secrets.get(added.id, 'secretKey')).toBeUndefined()
  })

  it('forgets the stored secret key when an edit switches to a profile', async () => {
    const secrets = createSecretStore({ cipher: plain })
    const core = createCore({ secrets })
    const source = await core.addSource(offline())

    const edited = await core.editSource(source.id, withProfile('work'))

    expect(edited).toMatchObject({ auth: 'profile', secretKeySet: false })
    expect(await secrets.get(source.id, 'secretKey')).toBeUndefined()
  })

  it('goes into the Error state when the profile isn’t in the local AWS config', async () => {
    await awsFiles({ config: '[profile other]\nregion = eu-west-1\n' })
    const core = createCore()
    const source = await core.addSource(withProfile('missing'))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' })
    expect(await core.connectionState(source.id)).toMatchObject({ state: 'error', code: 'CREDENTIALS_UNAVAILABLE' })
  })
})

describe('the local AWS profiles', () => {
  it('are those in the config and credentials files, by name, default first', async () => {
    await awsFiles({
      config: [
        '[default]',
        'region = eu-west-1',
        '[profile work-sso]',
        'sso_session = corp',
        '[sso-session corp]',
        'sso_start_url = https://corp.awsapps.com/start',
        '[ profile shared ]',
        '[services local]',
        's3 =',
        '  endpoint_url = http://localhost:9000'
      ].join('\n'),
      credentials: '[default]\naws_access_key_id = A\n[ci]\naws_access_key_id = B\n# [commented]\n[shared]\n'
    })

    expect(await createCore().listAwsProfiles()).toEqual(['default', 'ci', 'shared', 'work-sso'])
  })

  it('are none without the files', async () => {
    vi.stubEnv('AWS_CONFIG_FILE', join(dir, 'no-config'))
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(dir, 'no-credentials'))

    expect(await createCore().listAwsProfiles()).toEqual([])
  })
})

describe('an S3 Source’s trust and proxy settings', () => {
  it('are normalised', async () => {
    const core = createCore()

    const added = await core.addSource(offline({ verifyTls: false, caBundlePath: ' /etc/ssl/corp.pem ', proxyUrl: ' proxy.corp:3128/ ' }))

    expect(added).toMatchObject({ verifyTls: false, caBundlePath: '/etc/ssl/corp.pem', proxyUrl: 'http://proxy.corp:3128' })
  })

  it('keep an https proxy', async () => {
    expect(await createCore().addSource(offline({ proxyUrl: 'https://proxy.corp' }))).toMatchObject({ proxyUrl: 'https://proxy.corp' })
  })

  it.each(['socks5://proxy.corp:1080', 'http://'])('refuse a proxy that isn’t an http(s) address: %s', async (proxyUrl) => {
    await expect(createCore().addSource(offline({ proxyUrl }))).rejects.toMatchObject({ code: 'INVALID_PROXY' })
  })

  it('take their defaults for a Source saved before they existed', async () => {
    const dataDir = join(dir, 'user-data')
    await mkdir(dataDir)
    const saved = { id: 'old', type: 's3', name: 'Old', host: '', bucket: 'b', prefix: '', region: 'us-east-1', pathStyle: false, accessKeyId: 'AKIA' }
    await writeFile(join(dataDir, 'sources.json'), JSON.stringify({ version: 1, sources: [saved], groupOrder: ['local', 's3'] }))

    const [source] = await createCore({ dataDir }).listSources()

    expect(source).toMatchObject({ auth: 'keys', profile: '', verifyTls: true, caBundlePath: '', proxyUrl: '' })
  })

  it('keep a Source from connecting when its CA bundle can’t be read', async () => {
    const core = createCore()
    const source = await core.addSource(offline({ caBundlePath: join(dir, 'missing.pem') }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
  })

  it('keep a Source from connecting when its CA bundle holds no certificates', async () => {
    const bundle = join(dir, 'empty.pem')
    await writeFile(bundle, 'not a certificate\n')
    const core = createCore()
    const source = await core.addSource(offline({ caBundlePath: bundle }))

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
  })
})

describe.skipIf(!hasTestStore)('an S3 Source in a corporate network, against the test store', () => {
  const disposals: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  }, 120_000)
  const seeded = async () => {
    const { prefix, remove } = await seedPrefix({ 'a.log': 'a' })
    disposals.push(remove)
    return prefix
  }
  /** The test store behind TLS, with a certificate from a private CA: its `host`, and a `caBundlePath` that trusts it. */
  const behindTls = async () => {
    const front = await startTlsFront(testS3Source('', '').host)
    disposals.push(front.close)
    return { host: front.url, caBundlePath: front.caPath }
  }
  const proxy = async () => {
    const started = await startProxy()
    disposals.push(started.close)
    return started
  }
  const connects = async (settings: NewS3Source) => {
    const core = createCore()
    const source = await core.addSource(settings)
    return names(await core.connect(source.id))
  }

  it('refuses a certificate from an unknown CA while verifying TLS', async () => {
    const { host } = await behindTls()
    const settings = { ...testS3Source('Bucket', await seeded()), host }
    const core = createCore()
    const source = await core.addSource(settings)

    await expect(core.connect(source.id)).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
    await expect(core.testConnection(settings)).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
  })

  it('trusts a certificate from the CA bundle', async () => {
    const settings = { ...testS3Source('Bucket', await seeded()), ...(await behindTls()) }

    expect(await connects(settings)).toEqual(['a.log'])
  })

  it('accepts any certificate with TLS verification off', async () => {
    const { host } = await behindTls()
    const settings = { ...testS3Source('Bucket', await seeded()), host, verifyTls: false }

    expect(await connects(settings)).toEqual(['a.log'])
  })

  it('goes through its own proxy, whatever NO_PROXY says', async () => {
    vi.stubEnv('NO_PROXY', '*')
    const { url, tunnels } = await proxy()
    const tls = await behindTls()
    const settings = { ...testS3Source('Bucket', await seeded()), ...tls, proxyUrl: url }

    expect(await connects(settings)).toEqual(['a.log'])
    expect(tunnels).toContain(new URL(tls.host).host)
  })

  it('goes through HTTPS_PROXY without a proxy of its own', async () => {
    const { url, tunnels } = await proxy()
    vi.stubEnv('HTTPS_PROXY', url)
    vi.stubEnv('NO_PROXY', undefined)
    const tls = await behindTls()
    const settings = { ...testS3Source('Bucket', await seeded()), ...tls }

    expect(await connects(settings)).toEqual(['a.log'])
    expect(tunnels).toContain(new URL(tls.host).host)
  })

  it('goes straight to hosts NO_PROXY lists', async () => {
    const { url, tunnels } = await proxy()
    vi.stubEnv('HTTPS_PROXY', url)
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    const settings = { ...testS3Source('Bucket', await seeded()), ...(await behindTls()) }

    expect(await connects(settings)).toEqual(['a.log'])
    expect(tunnels).toEqual([])
  })

  it('signs in with a profile from the credentials file', async () => {
    const { accessKeyId, secretAccessKey } = testS3Source('', '')
    await awsFiles({ credentials: `[polyscope]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n` })
    const settings = { ...testS3Source('Bucket', await seeded()), auth: 'profile' as const, profile: 'polyscope' }

    expect(await connects({ ...settings, accessKeyId: undefined, secretAccessKey: undefined })).toEqual(['a.log'])
  })

  it('signs in with the default credential chain when no profile is named', async () => {
    const { accessKeyId = '', secretAccessKey = '' } = testS3Source('', '')
    await awsFiles()
    vi.stubEnv('AWS_ACCESS_KEY_ID', accessKeyId)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', secretAccessKey)
    const settings = { ...testS3Source('Bucket', await seeded()), auth: 'profile' as const, profile: '' }

    expect(await connects({ ...settings, accessKeyId: undefined, secretAccessKey: undefined })).toEqual(['a.log'])
  })
})
