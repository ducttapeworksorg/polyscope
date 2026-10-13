// Test support: this machine's systemd journal, seeded by tests/journal/seed.sh (as CI does) and announced by the
// POLYSCOPE_TEST_JOURNAL_COUNTER it prints. Tests that need it are skipped without it, and everywhere but Linux.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * The seed's counter, which logs `line 1` to `line 100`, then sleeps: `polyscope-counter-<when it was seeded>.service`, as
 * the journal keeps an earlier seeding's counter's lines.
 */
export const testCounter = process.env['POLYSCOPE_TEST_JOURNAL_COUNTER'] ?? ''

/** Whether the journal was seeded; the tests against it are skipped without it. */
export const hasTestJournal = process.platform === 'linux' && testCounter !== ''

/** The seed's `polyscope-levels.service`, which logs `reactor meltdown`, `disk full`, `low memory`, `all good` and `tick` at falling priorities. */
export const testLevels = 'polyscope-levels.service'

/** The seed's `polyscope-failer.service`, which logged `giving up` and failed. */
export const testFailer = 'polyscope-failer.service'

/** The seed's `polyscope-silent.service`, which runs without ever logging. */
export const testSilent = 'polyscope-silent.service'

/** The seed's `polyscope-restarter.service`, which logs `run <its pid>`, and is restarted whenever it's killed. */
export const testRestarter = 'polyscope-restarter.service'

/** Kills the seed's restarter, which systemd starts again a moment later. */
export async function restartTestRestarter() {
  const command = ['systemctl', 'kill', '--signal=KILL', testRestarter]
  if (process.getuid?.() === 0) await promisify(execFile)(command[0]!, command.slice(1))
  else await promisify(execFile)('sudo', ['-n', ...command])
}
