import { describe } from 'vitest'
import { createFakeLogSource } from './fake-log-source'
import { describeLogSourceContract } from './log-source-contract'

// The contract checks only what a Source Type says it offers: a fake offering nothing, and one offering everything.
describe('a fake Log Source', () => {
  for (const capabilities of [
    { previousLog: false, restarts: false, status: false },
    { previousLog: true, restarts: true, status: true }
  ]) {
    const offers = capabilities.previousLog ? 'every capability' : 'no capabilities'
    describeLogSourceContract(`A fake with ${offers}`, capabilities, async () => ({ logSource: createFakeLogSource({ capabilities }).logSource, counter: 'app/counter' }))
  }
})
