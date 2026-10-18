import { readFile } from 'node:fs/promises'
import { afterAll, describe } from 'vitest'
import { createJournalLogSource, journalHostOver, thisMachine } from './journal-log-source'
import { hasTestJournal, testCounter } from './journal-test-seed'
import { describeLogSourceContract } from './log-source-contract'
import { connectSsh, fingerprintOf, type SshConnection } from './ssh-connection'
import { sshdTarget } from './ssh-test-server'

describe.skipIf(!hasTestJournal)('systemd Journal against this machine’s journal', () => {
  describeLogSourceContract('systemd Journal', { previousLog: false, restarts: false, status: true, since: false }, async () => ({
    logSource: createJournalLogSource(thisMachine),
    counter: testCounter
  }))
})

// The same journal, read over SSH through sshd on localhost, as CI runs it.
describe.skipIf(!hasTestJournal || !sshdTarget)('systemd Journal against this machine’s journal over sshd', () => {
  const sshd = sshdTarget!
  const connections: SshConnection[] = []
  afterAll(() => connections.forEach((connection) => connection.close()))

  describeLogSourceContract('systemd Journal over SSH', { previousLog: false, restarts: false, status: true, since: false }, async () => {
    const hostKey = Buffer.from((await readFile(sshd.hostKeyFile, 'utf8')).trim().split(/\s+/)[1]!, 'base64')
    const connection = await connectSsh(
      { host: sshd.host, port: sshd.port, user: sshd.user, privateKey: await readFile(sshd.keyFile) },
      { checkHostKey: (key) => (key.fingerprint === fingerprintOf(hostKey) ? 'trusted' : 'changed') }
    )
    connections.push(connection)
    return { logSource: createJournalLogSource(journalHostOver(connection, sshd.host)), counter: testCounter }
  })
})
