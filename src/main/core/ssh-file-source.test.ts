import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe } from 'vitest'
import { describeFileSourceContract } from './file-source-contract'
import { connectSsh, type PresentedHostKey } from './ssh-connection'
import { createSshFileSource } from './ssh-file-source'
import { sshdTarget, startTestSshServer, writeTree } from './ssh-test-server'

/** Trusts only the host key in `publicKey`, an OpenSSH public key line. */
const trusting = (publicKey: string) => {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1]!, 'base64')
  const expected = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
  return (key: PresentedHostKey) => (key.fingerprint === expected ? 'trusted' : 'unknown')
}

describeFileSourceContract('SSH Files against the in-process server', async (tree) => {
  const server = await startTestSshServer()
  const path = await server.seed(tree)
  const connection = await connectSsh(
    { host: server.host, port: server.port, user: server.user, privateKey: server.clientKey },
    { checkHostKey: trusting(server.hostKey) }
  )
  return {
    fileSource: createSshFileSource(connection, path),
    async dispose() {
      connection.close()
      await server.close()
    }
  }
})

describe.skipIf(!sshdTarget)('SSH Files against sshd', () => {
  const sshd = sshdTarget!
  describeFileSourceContract('SSH Files against sshd', async (tree) => {
    const folder = await mkdtemp(join(sshd.root, 'contract-'))
    await writeTree(folder, tree)
    const connection = await connectSsh(
      { host: sshd.host, port: sshd.port, user: sshd.user, privateKey: await readFile(sshd.keyFile, 'utf8') },
      { checkHostKey: trusting(await readFile(sshd.hostKeyFile, 'utf8')) }
    )
    return {
      fileSource: createSshFileSource(connection, folder.split('\\').join('/')),
      async dispose() {
        connection.close()
        await rm(folder, { recursive: true, force: true })
      }
    }
  })
})
