// An SSH server in the test process, serving SFTP over a temp folder, for the SSH Files tests: it runs anywhere, with
// no setup. Its host key is generated when it starts, so none is ever committed. CI also runs the tests against a
// real OpenSSH sshd (see sshdTarget).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type Dirent, type Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import ssh2, { type AuthenticationType, type Connection, type ParsedKey, type SFTPWrapper } from 'ssh2'
import type { SeedTree } from './file-source-contract'

const { AgentProtocol, Server, utils } = ssh2
const { STATUS_CODE } = utils.sftp

export interface TestServerOptions {
  /** Whether the server offers the SFTP subsystem; on unless turned off. */
  sftp?: boolean
  /** The port to listen on; a free one unless given. */
  port?: number
  /** The key pair that signs in, from generateKey; a new unencrypted one unless given. */
  clientKey?: { private: string; public: string }
  /** A password that signs in too; none unless given. */
  password?: string
}

export interface TestSshServer {
  host: string
  port: number
  user: string
  /** The server's host key, in OpenSSH's public key format: `ssh-ed25519 AAAA…`. */
  hostKey: string
  /** The private key that signs in, in OpenSSH's format: unencrypted, unless given encrypted. */
  clientKey: string
  /** The folder SFTP serves as `/`. */
  root: string
  /** Writes a tree of files under `/` + `folder`, returning its absolute SFTP path. */
  seed(tree: SeedTree, folder?: string): Promise<string>
  /** How many clients are connected to it now. */
  connectionCount(): number
  close(): Promise<void>
}

/** A new key pair in OpenSSH's formats, the private key encrypted with `passphrase` if given. */
export function generateKey(passphrase?: string) {
  return utils.generateKeyPairSync('ed25519', passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 4 } : {})
}

/** Writes a seed tree under `root`, each folder created and each file written. */
export async function writeTree(root: string, tree: SeedTree) {
  const entries = Object.entries(tree).map(([path, content]) => ({ absolute: join(root, path), content }))
  const folders = new Set([root, ...entries.map(({ absolute, content }) => (content === null ? absolute : dirname(absolute)))])
  await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })))
  await Promise.all(entries.map(({ absolute, content }) => content !== null && writeFile(absolute, content)))
}

const errnoStatus: Record<string, number> = {
  ENOENT: STATUS_CODE.NO_SUCH_FILE,
  EACCES: STATUS_CODE.PERMISSION_DENIED,
  EPERM: STATUS_CODE.PERMISSION_DENIED
}

/** File attributes as SFTP carries them: times in whole seconds. */
const attrsOf = (s: Stats) => ({
  mode: s.mode,
  uid: s.uid,
  gid: s.gid,
  size: s.size,
  atime: Math.floor(s.atimeMs / 1000),
  mtime: Math.floor(s.mtimeMs / 1000)
})

/** Serves SFTP requests the way OpenSSH's sftp-server does, as far as SSH Files uses them, over `root`. */
function serveSftp(sftp: SFTPWrapper, root: string) {
  const handles = new Map<number, { file: FileHandle } | { folder: string; entries?: Dirent[] }>()
  let nextHandle = 0
  const handleOf = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0))
  const newHandle = (value: { file: FileHandle } | { folder: string }) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(nextHandle)
    handles.set(nextHandle++, value)
    return buffer
  }
  /** The local path of an SFTP path, which can't climb out of `root`. */
  const local = (path: string) => join(root, ...path.split('/').filter((s) => s && s !== '.' && s !== '..'))
  /** Runs a request, answering a failure with the status sftp-server would give. */
  const answer = (reqid: number, run: () => Promise<void>) =>
    run().catch((error: NodeJS.ErrnoException) => sftp.status(reqid, errnoStatus[error.code ?? ''] ?? STATUS_CODE.FAILURE, error.message))

  sftp.on('REALPATH', (reqid, path) =>
    answer(reqid, async () => {
      const real = relative(await realpath(root), await realpath(local(path)))
      const virtual = `/${real.split(sep).filter(Boolean).join('/')}`
      sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} as never }])
    })
  )
  sftp.on('STAT', (reqid, path) => answer(reqid, async () => void sftp.attrs(reqid, attrsOf(await stat(local(path))))))
  sftp.on('LSTAT', (reqid, path) => answer(reqid, async () => void sftp.attrs(reqid, attrsOf(await lstat(local(path))))))
  sftp.on('OPEN', (reqid, path) => answer(reqid, async () => void sftp.handle(reqid, newHandle({ file: await open(local(path), 'r') }))))
  sftp.on('OPENDIR', (reqid, path) =>
    answer(reqid, async () => {
      // As sftp-server, a file can't be opened as a folder.
      if (!(await stat(local(path))).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' })
      sftp.handle(reqid, newHandle({ folder: local(path) }))
    })
  )
  sftp.on('FSTAT', (reqid, buffer) =>
    answer(reqid, async () => {
      const handle = handleOf(buffer)
      if (!handle || !('file' in handle)) return void sftp.status(reqid, STATUS_CODE.FAILURE)
      sftp.attrs(reqid, attrsOf(await handle.file.stat()))
    })
  )
  sftp.on('READ', (reqid, buffer, offset, length) =>
    answer(reqid, async () => {
      const handle = handleOf(buffer)
      if (!handle || !('file' in handle)) return void sftp.status(reqid, STATUS_CODE.FAILURE)
      const data = Buffer.alloc(length)
      const { bytesRead } = await handle.file.read(data, 0, length, offset)
      if (bytesRead === 0) return void sftp.status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, data.subarray(0, bytesRead))
    })
  )
  sftp.on('READDIR', (reqid, buffer) =>
    answer(reqid, async () => {
      const handle = handleOf(buffer)
      if (!handle || !('folder' in handle)) return void sftp.status(reqid, STATUS_CODE.FAILURE)
      handle.entries ??= await readdir(handle.folder, { withFileTypes: true })
      // A hundred at a time, as sftp-server sends them, so listing a large folder takes several requests.
      const batch = handle.entries.splice(0, 100)
      if (!batch.length) return void sftp.status(reqid, STATUS_CODE.EOF)
      const names = await Promise.all(
        batch.map(async (d) => ({ filename: d.name, longname: d.name, attrs: attrsOf(await lstat(join(handle.folder, d.name))) }))
      )
      sftp.name(reqid, names)
    })
  )
  sftp.on('CLOSE', (reqid, buffer) =>
    answer(reqid, async () => {
      const handle = handleOf(buffer)
      handles.delete(buffer.readUInt32BE(0))
      if (handle && 'file' in handle) await handle.file.close()
      sftp.status(reqid, STATUS_CODE.OK)
    })
  )
  sftp.on('end', () => {
    for (const handle of handles.values()) if ('file' in handle) void handle.file.close()
  })
}

/** Whether a client's public key is `allowed`, and, when it signs, that it really holds the private key. */
function acceptsKey(allowed: ParsedKey, offered: { algo: string; data: Buffer }, signed?: { blob: Buffer; signature: Buffer; hashAlgo?: string }) {
  const expected = allowed.getPublicSSH()
  if (offered.algo !== allowed.type || offered.data.length !== expected.length || !timingSafeEqual(offered.data, expected)) return false
  return !signed || allowed.verify(signed.blob, signed.signature, signed.hashAlgo as never) === true
}

/** Starts a test server on a free port of 127.0.0.1, over a new temp folder. */
export async function startTestSshServer({
  sftp: offersSftp = true,
  port: listenOn = 0,
  clientKey: clientKeys = generateKey(),
  password
}: TestServerOptions = {}): Promise<TestSshServer> {
  const root = await mkdtemp(join(tmpdir(), 'polyscope-ssh-'))
  // The one user who may sign in.
  const user = 'polyscope'
  const hostKeys = generateKey()
  const allowed = utils.parseKey(clientKeys.public) as ParsedKey
  const connections = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    connections.add(client)
    client.on('close', () => connections.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      const methods: AuthenticationType[] = password === undefined ? ['publickey'] : ['publickey', 'password']
      if (ctx.username !== user) return ctx.reject(methods)
      if (ctx.method === 'password' && password !== undefined) return ctx.password === password ? ctx.accept() : ctx.reject(methods)
      if (ctx.method !== 'publickey') return ctx.reject(methods)
      const signed = ctx.signature ? { blob: ctx.blob!, signature: ctx.signature, ...(ctx.hashAlgo && { hashAlgo: ctx.hashAlgo }) } : undefined
      if (!acceptsKey(allowed, ctx.key, signed)) return ctx.reject(methods)
      ctx.accept()
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('sftp', (acceptSftp, reject) => {
        if (!offersSftp) return reject()
        serveSftp(acceptSftp(), root)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(listenOn, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  let seeds = 0

  return {
    host: '127.0.0.1',
    port,
    user,
    hostKey: hostKeys.public,
    clientKey: clientKeys.private,
    root,
    async seed(tree, folder = `seed-${seeds++}`) {
      await writeTree(join(root, folder), tree)
      return `/${folder}`
    },
    connectionCount: () => connections.size,
    async close() {
      for (const connection of connections) connection.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}

export interface TestSshAgent {
  /** Where it listens, as SSH_AUTH_SOCK names it: a named pipe on Windows, a socket in a temp folder elsewhere. */
  path: string
  close(): Promise<void>
}

/** Starts an SSH agent in the test process, holding the private keys given, as ssh-agent or Pageant would. */
export async function startTestSshAgent(...privateKeys: string[]): Promise<TestSshAgent> {
  const keys = privateKeys.map((key) => utils.parseKey(key) as ParsedKey)
  const name = `polyscope-agent-${randomBytes(6).toString('hex')}`
  const folder = process.platform === 'win32' ? null : await mkdtemp(join(tmpdir(), 'polyscope-agent-'))
  const path = folder ? join(folder, 'agent.sock') : `\\\\.\\pipe\\${name}`
  const server = createServer((socket) => {
    const protocol = new AgentProtocol(false)
    socket.on('error', () => undefined)
    protocol.on('error', () => socket.destroy())
    socket.pipe(protocol).pipe(socket)
    protocol.on('identities', (request) => protocol.getIdentitiesReply(request, keys))
    protocol.on('sign', (request, publicKey, data, options) => {
      const blob = publicKey.getPublicSSH()
      const key = keys.find((k) => k.getPublicSSH().equals(blob))
      const signature = key?.sign(data, options.hash as never)
      if (!(signature instanceof Buffer)) return protocol.failureReply(request)
      protocol.signReply(request, signature)
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (folder) await rm(folder, { recursive: true, force: true })
    }
  }
}

/**
 * A real OpenSSH sshd to run the tests against as well, when CI has started one: its address, user and the
 * folder it serves (on this machine, so tests seed it directly), and where the key that signs in and its host's
 * public key are.
 */
export const sshdTarget = process.env.POLYSCOPE_TEST_SSHD_PORT
  ? {
      host: process.env.POLYSCOPE_TEST_SSHD_HOST ?? '127.0.0.1',
      port: Number(process.env.POLYSCOPE_TEST_SSHD_PORT),
      user: process.env.POLYSCOPE_TEST_SSHD_USER ?? '',
      keyFile: process.env.POLYSCOPE_TEST_SSHD_KEY ?? '',
      hostKeyFile: process.env.POLYSCOPE_TEST_SSHD_HOST_KEY ?? '',
      root: process.env.POLYSCOPE_TEST_SSHD_ROOT ?? ''
    }
  : null
