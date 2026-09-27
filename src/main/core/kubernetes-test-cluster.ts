// Test support: a real cluster (kind in CI) seeded from tests/kind/seed.yaml, named by POLYSCOPE_TEST_KUBE_CONTEXT
// (a context in the kubeconfig) and POLYSCOPE_TEST_KUBE_NAMESPACE. Tests that need it are skipped without it.

import { CoreV1Api } from '@kubernetes/client-node'
import type { NewKubernetesLogsSource } from '@shared/core-api'
import { kubeConfigFor } from './kubeconfig'

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

/**
 * A namespace of the test's own holding a `ticker` pod, which prints `tick 1`, `tick 2`… a second apart,
 * then fails after `ticks` of them, so it restarts (the first time about ten seconds later). Resolves once
 * the pod is running; `remove` deletes the namespace.
 */
export async function tickerNamespace(namespace: string, ticks: number) {
  const api = kubeConfigFor(context ?? '').makeApiClient(CoreV1Api)
  await api.createNamespace({ body: { metadata: { name: namespace } } })
  const remove = () => api.deleteNamespace({ name: namespace, gracePeriodSeconds: 0 }).then(() => undefined)
  try {
    // A bare pod isn't retried like a Workload's: its namespace's default ServiceAccount has to be there first.
    await until(() => api.readNamespacedServiceAccount({ name: 'default', namespace }).then(() => true, () => false))
    const script = `i=0; while [ $i -lt ${ticks} ]; do i=$((i+1)); echo "tick $i"; sleep 1; done; exit 1`
    await api.createNamespacedPod({
      namespace,
      body: {
        metadata: { name: 'ticker' },
        spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'ticker', image: 'busybox:1.36', command: ['sh', '-c', script] }] }
      }
    })
    await until(async () => (await api.readNamespacedPod({ name: 'ticker', namespace })).status?.containerStatuses?.[0]?.state?.running !== undefined)
  } catch (error) {
    await remove()
    throw error
  }
  return { remove }
}

/** Waits until `check` holds, looking every half second for up to two minutes. */
async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 240; tries++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Gave up waiting for the test cluster')
}
