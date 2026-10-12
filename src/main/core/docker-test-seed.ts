// Test support: a real Docker Engine, the one the default context reaches, seeded by tests/docker/seed.sh (as CI does)
// and announced by POLYSCOPE_TEST_DOCKER=seeded. Tests that need it are skipped without it.

/** Whether the default context's engine was seeded; the tests against it are skipped without it. */
export const hasTestDocker = process.env['POLYSCOPE_TEST_DOCKER'] === 'seeded'

/** The seed's standalone `polyscope-counter`, which logs `line 1` to `line 100`, then sleeps. */
export const testCounter = '_standalone/polyscope-counter'

/** The seed's standalone `polyscope-ticker`, which logs `tick 1`, `tick 2`… a second apart, for good. */
export const testTicker = '_standalone/polyscope-ticker'

/** The seed's Compose project, as tests/docker/compose.yaml names it. */
export const testProject = 'polyscope-test'
