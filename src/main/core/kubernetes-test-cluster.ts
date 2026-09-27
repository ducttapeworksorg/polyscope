// Test support: a real cluster (kind in CI) seeded from tests/kind/seed.yaml, named by POLYSCOPE_TEST_KUBE_CONTEXT
// (a context in the kubeconfig) and POLYSCOPE_TEST_KUBE_NAMESPACE. Tests that need it are skipped without it.

import type { NewKubernetesLogsSource } from '@shared/core-api'

const context = process.env['POLYSCOPE_TEST_KUBE_CONTEXT']

/** Whether a test cluster was given; Kubernetes tests are skipped without one. */
export const hasTestCluster = Boolean(context)

export const testNamespace = process.env['POLYSCOPE_TEST_KUBE_NAMESPACE'] || 'polyscope-test'

/** Settings of a Kubernetes Logs Source pointing at the seeded namespace of the test cluster. */
export const testKubernetesLogsSource = (name = 'Cluster', namespace = testNamespace): NewKubernetesLogsSource => ({
  type: 'kubernetesLogs',
  name,
  context: context ?? '',
  namespace
})

/** What the seed's `counter` pod prints, one line each, before it sleeps: `line 1` to `line 100`. */
export const counterLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
