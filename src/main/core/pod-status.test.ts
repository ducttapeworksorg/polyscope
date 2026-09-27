import type { V1ContainerStatus, V1DaemonSet, V1Deployment, V1Pod, V1StatefulSet } from '@kubernetes/client-node'
import { describe, expect, it } from 'vitest'
import { containerInstanceOf, podStatusOf, readyCountOf, restartsOf } from './pod-status'

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

describe('a container’s current run', () => {
  const exited = (name: string, exitCode: number, restartCount = 0): V1ContainerStatus => ({
    ...running(name),
    ready: false,
    restartCount,
    state: { terminated: { exitCode } }
  })
  const withPolicy = (p: V1Pod, restartPolicy: string) => ({ ...p, spec: { ...p.spec!, restartPolicy } })

  it('is running, with the container’s restarts', () => {
    expect(containerInstanceOf(pod('Running', [running('app', { restartCount: 3 })]), 'app')).toEqual({
      restarts: 3,
      state: 'running',
      finished: false
    })
  })

  it('is waiting while backing off before a restart, not finished', () => {
    expect(containerInstanceOf(pod('Running', [crashed('app', 2, 'Error', '2026-09-27T10:00:00Z')]), 'app')).toEqual({
      restarts: 2,
      state: 'waiting',
      finished: false
    })
  })

  it('is waiting before the container has a status at all', () => {
    expect(containerInstanceOf({ ...pod('Pending'), spec: { containers: [{ name: 'app' }] } }, 'app')).toEqual({
      restarts: 0,
      state: 'waiting',
      finished: false
    })
  })

  it('is finished once its pod has completed or failed', () => {
    expect(containerInstanceOf(pod('Succeeded', [exited('app', 0)]), 'app')).toMatchObject({ state: 'terminated', finished: true })
    expect(containerInstanceOf(pod('Failed', [exited('app', 1)]), 'app')).toMatchObject({ finished: true })
  })

  it('is finished when the pod does not restart it', () => {
    expect(containerInstanceOf(withPolicy(pod('Running', [exited('app', 1)]), 'Never'), 'app')).toMatchObject({ finished: true })
    expect(containerInstanceOf(withPolicy(pod('Running', [exited('app', 0)]), 'OnFailure'), 'app')).toMatchObject({ finished: true })
    expect(containerInstanceOf(withPolicy(pod('Running', [exited('app', 1)]), 'OnFailure'), 'app')).toMatchObject({ finished: false })
    expect(containerInstanceOf(pod('Running', [exited('app', 0)]), 'app')).toMatchObject({ finished: false })
  })

  it('is finished for an init container that has done its part, but not for a sidecar', () => {
    const p: V1Pod = {
      metadata: { name: 'p' },
      spec: { initContainers: [{ name: 'setup' }, { name: 'proxy', restartPolicy: 'Always' }], containers: [{ name: 'app' }] },
      status: { phase: 'Running', initContainerStatuses: [exited('setup', 0), exited('proxy', 0, 1)], containerStatuses: [running('app')] }
    }
    expect(containerInstanceOf(p, 'setup')).toMatchObject({ state: 'terminated', finished: true })
    expect(containerInstanceOf(p, 'proxy')).toEqual({ restarts: 1, state: 'terminated', finished: false })
  })

  it('is finished once the pod is going away', () => {
    const going = { ...pod('Running', [exited('app', 0)]), metadata: { name: 'p', deletionTimestamp: new Date() } }
    expect(containerInstanceOf(going, 'app')).toMatchObject({ finished: true })
  })

  it('is not there for a container the pod does not have', () => {
    expect(containerInstanceOf(pod('Running', [running('app')]), 'other')).toBeUndefined()
  })
})
