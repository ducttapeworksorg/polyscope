import { describe, expect, it } from 'vitest'
import type { LogGroupNode, LogNode, SourcePath } from '@shared/core-api'
import { kubeConfigFor } from './kubeconfig'
import { createKubernetesLogSource } from './kubernetes-log-source'
import { hasTestCluster, testKubernetesLogsSource } from './kubernetes-test-cluster'
import { describeLogSourceContract } from './log-source-contract'
import type { LogSource } from './log-source'

const counter = 'pods/counter/counter'

const testLogSource = () => {
  const { context, namespace } = testKubernetesLogsSource()
  return createKubernetesLogSource(kubeConfigFor(context), namespace)
}

/** Every node of a tree, walking down from `path`; containers, the logs, are where it stops. */
async function walk(source: LogSource, path: SourcePath = ''): Promise<LogNode[]> {
  const children = await source.listChildren(path)
  const below = await Promise.all(children.map((node) => (node.kind === 'logStream' ? [] : walk(source, node.path))))
  return children.flatMap((node, i) => [node, ...below[i]!])
}

const parentOf = (path: SourcePath) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

describe.skipIf(!hasTestCluster)('Kubernetes Logs against the test cluster', () => {
  describeLogSourceContract('Kubernetes Logs', { previousLog: true, restarts: true, status: true, since: false }, async () => ({ logSource: testLogSource(), counter }))

  describe('its tree', () => {
    it('starts with a group per kind of Workload, which never folds, and reaches containers only through pods', async () => {
      const logSource = testLogSource()
      for (const group of await logSource.listChildren('')) {
        expect(group, group.path).toEqual({ kind: 'group', name: group.path, path: group.path, unfoldable: true, kubernetes: { kind: 'workloads', workloadKind: expect.any(String) } })
      }
      const nodes = await walk(logSource)
      for (const node of nodes.filter((n) => n.kind === 'logStream')) {
        expect(node.kubernetes?.kind, node.path).toBe('container')
        const parent = nodes.find((n) => n.path === parentOf(node.path))
        expect(parent?.kind === 'group' && parent.kubernetes?.kind, node.path).toBe('pod')
      }
    })

    it('gives each pod its Pod Status, and folds a pod’s only container into it', async () => {
      const logSource = testLogSource()
      const pods = (await walk(logSource)).filter((node): node is LogGroupNode => node.kind === 'group' && node.kubernetes?.kind === 'pod')
      expect(pods.length).toBeGreaterThan(0)
      for (const pod of pods) {
        const containers = await logSource.listChildren(pod.path)
        expect(pod.status, pod.path).toMatchObject({ reason: expect.any(String) })
        expect(pod.kubernetes, pod.path).toEqual({ kind: 'pod', containerCount: containers.length })
        if (containers.length === 1) expect(pod.folded, pod.path).toMatchObject({ kind: 'logStream', path: containers[0]!.path })
        else expect(pod, pod.path).not.toHaveProperty('folded')
      }
    })

    it('folds a Workload’s only pod, and a CronJob’s only Job, into it', async () => {
      const logSource = testLogSource()
      const workloads = (await walk(logSource)).filter((node) => node.kind === 'group' && node.kubernetes?.kind === 'workload')
      for (const workload of workloads) {
        if (workload.kind !== 'group' || workload.kubernetes?.kind !== 'workload') continue
        const children = await logSource.listChildren(workload.path)
        expect(Boolean(workload.empty), workload.path).toBe(children.length === 0)
        if (children.length !== 1) {
          expect(workload, workload.path).not.toHaveProperty('folded')
          continue
        }
        const foldsIn = workload.kubernetes.workloadKind === 'CronJob' ? 'workload' : 'pod'
        expect(workload.folded?.kind === 'group' && workload.folded.kubernetes?.kind, workload.path).toBe(foldsIn)
      }
    })

    it('tells a log’s pod and container, and how many times it has restarted', async () => {
      expect(await testLogSource().logStreamAt(counter)).toEqual({
        name: 'counter',
        hasPreviousLog: false,
        kubernetes: { pod: 'counter', container: 'counter', restarts: 0 }
      })
    })
  })
})
