// Test support: stand-ins for what lies between Polyscope and a backend (an S3 store, a cluster) in a corporate network — a TLS front
// whose certificate comes from a private CA, and a proxy. The CA and certificate are made afresh for each test run
// and only ever held in memory, bar the CA's certificate (no key) in a temp file for Sources to trust.

import { webcrypto } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
// @peculiar/x509 needs the Reflect metadata API, and leaves providing it to its users.
import 'reflect-metadata'
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator
} from '@peculiar/x509'

const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const generateKeys = () => webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])

/** A private CA and a certificate it signed for 127.0.0.1 and localhost, as PEM. */
async function createCertificates() {
  const notBefore = new Date(Date.now() - 60 * 60_000)
  const notAfter = new Date(Date.now() + 24 * 60 * 60_000)
  const caKeys = await generateKeys()
  const ca = await X509CertificateGenerator.createSelfSigned(
    {
      name: 'CN=Polyscope Test CA',
      keys: caKeys,
      notBefore,
      notAfter,
      signingAlgorithm: algorithm,
      extensions: [
        new BasicConstraintsExtension(true, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)
      ]
    },
    webcrypto
  )
  const serverKeys = await generateKeys()
  const server = await X509CertificateGenerator.create(
    {
      subject: 'CN=localhost',
      issuer: ca.subject,
      publicKey: serverKeys.publicKey,
      signingKey: caKeys.privateKey,
      notBefore,
      notAfter,
      signingAlgorithm: algorithm,
      extensions: [
        new SubjectAlternativeNameExtension([
          { type: 'dns', value: 'localhost' },
          { type: 'ip', value: '127.0.0.1' }
        ]),
        new BasicConstraintsExtension(false),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth])
      ]
    },
    webcrypto
  )
  const key = PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', serverKeys.privateKey), 'PRIVATE KEY')
  return { ca: ca.toString('pem'), cert: server.toString('pem'), key }
}

// Made once per test run: generating keys is quick, but not free.
let certificates: ReturnType<typeof createCertificates> | undefined

/** Joins two sockets both ways; either failing or closing closes the other. */
function splice(a: Socket, b: Socket) {
  a.pipe(b).pipe(a)
  a.on('error', () => b.destroy())
  b.on('error', () => a.destroy())
}

async function listen(server: Server | HttpServer) {
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Not listening on a port')
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

/**
 * Serves `endpoint` (an http URL) over https on 127.0.0.1, with a certificate signed by a private test CA;
 * `caPath` is a PEM file of the CA's certificate, gone once the front is closed.
 */
export async function startTlsFront(endpoint: string) {
  const { ca, cert, key } = await (certificates ??= createCertificates())
  const dir = await mkdtemp(join(tmpdir(), 'polyscope-ca-'))
  const caPath = join(dir, 'ca.pem')
  await writeFile(caPath, ca)
  const { hostname, port } = new URL(endpoint)
  const server = createTlsServer({ cert, key }, (socket) => splice(socket, connect(Number(port), hostname)))
  const listening = await listen(server)
  return {
    url: `https://127.0.0.1:${listening.port}`,
    caPath,
    close: async () => {
      await listening.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/**
 * An HTTP proxy that tunnels with CONNECT; `tunnels` holds the `host:port` of each tunnel asked for. It
 * looks names up in `hosts` first, so it can reach servers by names that only it knows.
 */
export async function startProxy({ hosts = {} }: { hosts?: Record<string, string> } = {}) {
  const tunnels: string[] = []
  const server = createHttpServer((_request, response) => response.writeHead(405).end())
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const target = request.url ?? ''
    tunnels.push(target)
    const [host = '', port = '443'] = target.split(/:(?=\d+$)/)
    const upstream = connect(Number(port), hosts[host] ?? host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      splice(client, upstream)
    })
    upstream.on('error', () => client.destroy())
  })
  const listening = await listen(server)
  return { url: `http://127.0.0.1:${listening.port}`, tunnels, close: listening.close }
}
