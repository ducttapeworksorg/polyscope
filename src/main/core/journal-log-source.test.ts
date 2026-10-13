import { describe } from 'vitest'
import { createJournalLogSource, thisMachine } from './journal-log-source'
import { hasTestJournal, testCounter } from './journal-test-seed'
import { describeLogSourceContract } from './log-source-contract'

describe.skipIf(!hasTestJournal)('systemd Journal against this machine’s journal', () => {
  describeLogSourceContract('systemd Journal', { previousLog: false, restarts: false, status: true }, async () => ({
    logSource: createJournalLogSource(thisMachine),
    counter: testCounter
  }))
})
