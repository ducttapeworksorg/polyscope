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

/** The seed's standalone `polyscope-crasher`, which logs `run started`, then `crashing` 10 s later and exits 1, restarted each time. */
export const testCrasher = '_standalone/polyscope-crasher'

/** The seed's standalone `polyscope-unhealthy`, whose healthcheck always fails. */
export const testUnhealthy = '_standalone/polyscope-unhealthy'

/** The seed's standalone `polyscope-syslog`, which logs to syslog with no copy for the engine to read back. */
export const testSyslog = '_standalone/polyscope-syslog'

/**
 * The Docker context reaching the seeded engine through a TLS front that asks for a client certificate, as
 * tests/docker/tls.sh sets it up and POLYSCOPE_TEST_DOCKER_TLS_CONTEXT names it; the tests through it are skipped without it.
 */
export const testTlsContext = process.env['POLYSCOPE_TEST_DOCKER_TLS_CONTEXT'] || undefined

/**
 * The Docker context reaching the seeded engine over SSH, through an OpenSSH sshd on this machine, as tests/docker/ssh.sh
 * sets it up and POLYSCOPE_TEST_DOCKER_SSH_CONTEXT names it, with POLYSCOPE_TEST_DOCKER_SSH_DIR the folder holding the
 * key that signs in (`client_key`) and a `known_hosts` line for the server's host key; the tests through it are skipped without them.
 */
export const testSshContext =
  process.env['POLYSCOPE_TEST_DOCKER_SSH_CONTEXT'] && process.env['POLYSCOPE_TEST_DOCKER_SSH_DIR']
    ? { name: process.env['POLYSCOPE_TEST_DOCKER_SSH_CONTEXT'], dir: process.env['POLYSCOPE_TEST_DOCKER_SSH_DIR'] }
    : undefined
