import { describe } from 'vitest'
import { describeFileSourceContract } from './file-source-contract'
import { createKubernetesFileSource } from './kubernetes-file-source'
import { hasTestCluster, podsNamed, seedContainerFolder, testKubernetesFilesSource } from './kubernetes-test-cluster'
import { kubeConfigFor } from './kubeconfig'
import type { FileSource } from './file-source'

/** A File Source seen from inside one of its pods: `pod/…` paths as the Source's own. */
const insidePod = (source: FileSource, pod: string): FileSource => ({
  listChildren: (path, cursor) => source.listChildren(path ? `${pod}/${path}` : pod, cursor),
  stat: (path) => source.stat(path ? `${pod}/${path}` : pod),
  read: (path, range) => source.read(`${pod}/${path}`, range)
})

describe.skipIf(!hasTestCluster)('Kubernetes Files against the test cluster', () => {
  for (const [image, workloadKind, workloadName] of [
    ['busybox', 'Deployment', 'files-busybox'],
    ['coreutils', 'StatefulSet', 'files-coreutils']
  ] as const) {
    describeFileSourceContract(`Kubernetes Files in a ${image} image`, async (tree) => {
      const [pod] = await podsNamed(workloadName)
      const { path, remove } = await seedContainerFolder(pod!, tree)
      const { context, namespace } = testKubernetesFilesSource()
      const source = createKubernetesFileSource(kubeConfigFor(context), { namespace, workloadKind, workloadName, path })
      return { fileSource: insidePod(source, pod!), dispose: remove }
    })
  }
})
