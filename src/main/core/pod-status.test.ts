import type { V1ContainerStatus, V1DaemonSet, V1Deployment, V1Pod, V1StatefulSet } from '@kubernetes/client-node'
import { describe, expect, it } from 'vitest'
import { podStatusOf, readyCountOf, restartsOf } from './pod-status'

const running = (name: string, changes: Partial<V1ContainerStatus> = {}): V1ContainerStatus => ({
  name,
  image: 'busybox',
  imageID: '',
  ready: true,
  restartCount: 0,
  state: { running: { startedAt: new Date('2026-09-27T10:00:00Z') } },
  ...changes
})

const pod = (phase: string, containerStatuses: V1ContainerStatus[] = [], changes: Partial<V1Pod> = {}): V1Pod => ({
  metadata: { name: 'p' },
  spec: { containers: containerStatuses.map(({ name }) => ({ name })) },
  status: { phase, containerStatuses },
  ...changes
})

const crashed = (name: string, restartCount: number, reason: string, finishedAt: string): V1ContainerStatus => ({
  ...running(name),
  ready: false,
  restartCount,
  state: { waiting: { reason: 'CrashLoopBackOff' } },
  lastState: { terminated: { exitCode: reason === 'OOMKilled' ? 137 : 1, reason, finishedAt: new Date(finishedAt) } }
})

describe('Pod Status', () => {
  it('is the phase for a pod going as it should', () => {
    expect(podStatusOf(pod('Running', [running('app')]))).toEqual({ reason: 'Running', health: 'healthy', restarts: 0 })
    expect(podStatusOf(pod('Succeeded'))).toMatchObject({ reason: 'Succeeded', health: 'healthy' })
    expect(podStatusOf(pod('Pending'))).toMatchObject({ reason: 'Pending', health: 'pending' })
    expect(podStatusOf(pod('Failed'))).toMatchObject({ reason: 'Failed', health: 'failing' })
    expect(podStatusOf(pod('Unknown'))).toMatchObject({ reason: 'Unknown', health: 'inactive' })
  })

  it('is a pod’s own reason over its phase, e.g. an evicted pod', () => {
    expect(podStatusOf(pod('Failed', [], { status: { phase: 'Failed', reason: 'Evicted' } }))).toMatchObject({
      reason: 'Evicted',
      health: 'failing'
    })
  })

  it('is why a container is waiting, still starting or failing to', () => {
    const waiting = (reason: string) => running('app', { ready: false, state: { waiting: { reason } } })

    expect(podStatusOf(pod('Pending', [waiting('ContainerCreating')]))).toMatchObject({ reason: 'ContainerCreating', health: 'pending' })
    expect(podStatusOf(pod('Pending', [waiting('ImagePullBackOff')]))).toMatchObject({ reason: 'ImagePullBackOff', health: 'failing' })
    expect(podStatusOf(pod('Running', [running('a'), waiting('CrashLoopBackOff')]))).toMatchObject({
      reason: 'CrashLoopBackOff',
      health: 'failing'
    })
  })

  it('is why a container ended, unless it simply completed', () => {
    const ended = (reason: string, exitCode: number) => running('app', { state: { terminated: { reason, exitCode } } })

    expect(podStatusOf(pod('Running', [ended('Error', 1)]))).toMatchObject({ reason: 'Error', health: 'failing' })
    expect(podStatusOf(pod('Failed', [ended('OOMKilled', 137)]))).toMatchObject({ reason: 'OOMKilled', health: 'failing' })
    expect(podStatusOf(pod('Succeeded', [ended('Completed', 0)]))).toMatchObject({ reason: 'Completed', health: 'healthy' })
  })

  it('names an init container’s trouble as such, but not a sidecar’s start', () => {
    const initStatuses = [
      running('setup', { ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }),
      running('proxy', { ready: false, state: { waiting: { reason: 'PodInitializing' } } })
    ]
    const initPod = (statuses: V1ContainerStatus[]) =>
      pod('Pending', [], {
        spec: { containers: [], initContainers: [{ name: 'setup' }, { name: 'proxy', restartPolicy: 'Always' }] },
        status: { phase: 'Pending', initContainerStatuses: statuses }
      })

    expect(podStatusOf(initPod(initStatuses))).toMatchObject({ reason: 'Init:CrashLoopBackOff', health: 'failing' })
    expect(podStatusOf(initPod([running('setup', { state: { terminated: { exitCode: 2 } } })]))).toMatchObject({
      reason: 'Init:ExitCode:2',
      health: 'failing'
    })
    expect(podStatusOf(initPod([running('setup', { ready: false, state: { running: {} } })]))).toMatchObject({
      reason: 'Init:0/2',
      health: 'pending'
    })
  })

  it('is Terminating once the pod is being deleted, whatever else', () => {
    const deleting = pod('Running', [running('app')], { metadata: { name: 'p', deletionTimestamp: new Date() } })

    expect(podStatusOf(deleting)).toMatchObject({ reason: 'Terminating', health: 'inactive' })
  })

  it('counts restarts across containers, init containers included, with the latest restart and why it happened', () => {
    const restarted = pod('Running', [crashed('a', 2, 'OOMKilled', '2026-09-27T10:05:00Z'), crashed('b', 3, 'Error', '2026-09-27T10:01:00Z')])
    restarted.spec!.initContainers = [{ name: 'proxy', restartPolicy: 'Always' }]
    restarted.status!.initContainerStatuses = [running('proxy', { restartCount: 1, started: true })]

    expect(podStatusOf(restarted)).toEqual({
      reason: 'CrashLoopBackOff',
      health: 'failing',
      restarts: 6,
      lastRestart: Date.parse('2026-09-27T10:05:00Z'),
      lastTerminationReason: 'OOMKilled'
    })
  })

  it('gives an exit code when a container ended without a reason', () => {
    const status = crashed('a', 1, '', '2026-09-27T10:05:00Z')
    status.lastState!.terminated!.reason = undefined

    expect(podStatusOf(pod('Running', [status]))).toMatchObject({ lastTerminationReason: 'ExitCode:1' })
  })

  it('knows each container’s restarts, left out until it has any', () => {
    const p = pod('Running', [running('app'), crashed('crash', 4, 'Error', '2026-09-27T10:05:00Z')])

    expect(restartsOf(p, 'crash')).toBe(4)
    expect(restartsOf(p, 'app')).toBeUndefined()
    expect(restartsOf(p, 'missing')).toBeUndefined()
  })
})

describe('Ready Count', () => {
  it('is the ready replicas out of those wanted for Deployments and StatefulSets', () => {
    const deployment: V1Deployment = { spec: { replicas: 3, selector: {}, template: {} }, status: { readyReplicas: 2 } }
    const statefulSet: V1StatefulSet = { spec: { replicas: 1, selector: {}, template: {}, serviceName: 'db' }, status: { replicas: 0 } }

    expect(readyCountOf('Deployment', deployment)).toEqual({ ready: 2, desired: 3 })
    expect(readyCountOf('StatefulSet', statefulSet)).toEqual({ ready: 0, desired: 1 })
  })

  it('is the ready pods out of those to schedule for DaemonSets', () => {
    const daemonSet: V1DaemonSet = {
      status: { numberReady: 4, desiredNumberScheduled: 5, currentNumberScheduled: 5, numberMisscheduled: 0 }
    }

    expect(readyCountOf('DaemonSet', daemonSet)).toEqual({ ready: 4, desired: 5 })
  })

  it('is left out for Workloads that run to completion', () => {
    expect(readyCountOf('Job', {})).toBeUndefined()
    expect(readyCountOf('CronJob', {})).toBeUndefined()
  })
})
