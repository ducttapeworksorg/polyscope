import { describe } from 'vitest'
import { kubeConfigFor } from './kubeconfig'
import { createKubernetesLogSource } from './kubernetes-log-source'
import { hasTestCluster, testKubernetesLogsSource } from './kubernetes-test-cluster'
import { describeLogSourceContract } from './log-source-contract'

describe.skipIf(!hasTestCluster)('Kubernetes Logs against the test cluster', () => {
  describeLogSourceContract('Kubernetes Logs', async () => {
    const { context, namespace } = testKubernetesLogsSource()
    return { logSource: createKubernetesLogSource(kubeConfigFor(context), namespace), counter: 'pods/counter/counter' }
  })
})
