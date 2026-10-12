import { describe, expect, it } from 'vitest'
import { containerRunOf, containerStatusOf, type ContainerInspect } from './container-status'

const container = (state: NonNullable<ContainerInspect['State']>, changes: Partial<ContainerInspect> = {}): ContainerInspect => ({
  RestartCount: 0,
  State: { StartedAt: '2026-10-12T10:00:00.123456789Z', FinishedAt: '0001-01-01T00:00:00Z', ...state },
  ...changes
})

describe('Container Status', () => {
  it('is Running for a running container', () => {
    expect(containerStatusOf(container({ Status: 'running', Running: true }))).toEqual({ reason: 'Running', health: 'healthy', restarts: 0 })
  })

  it('is Exited with its exit code, failing unless it ended well or was stopped', () => {
    expect(containerStatusOf(container({ Status: 'exited', ExitCode: 1 }))).toMatchObject({ reason: 'Exited (1)', health: 'failing' })
    expect(containerStatusOf(container({ Status: 'exited', ExitCode: 0 }))).toMatchObject({ reason: 'Exited (0)', health: 'inactive' })
    // `docker stop` ends it with SIGTERM, then SIGKILL if it's still going.
    expect(containerStatusOf(container({ Status: 'exited', ExitCode: 143 }))).toMatchObject({ reason: 'Exited (143)', health: 'inactive' })
    expect(containerStatusOf(container({ Status: 'exited', ExitCode: 137 }))).toMatchObject({ reason: 'Exited (137)', health: 'inactive' })
  })

  it('is OOMKilled for a container killed for running out of memory', () => {
    expect(containerStatusOf(container({ Status: 'exited', ExitCode: 137, OOMKilled: true }))).toMatchObject({ reason: 'OOMKilled', health: 'failing' })
  })

  it('is Restarting, failing, for a container between runs', () => {
    expect(containerStatusOf(container({ Status: 'restarting', ExitCode: 1 }, { RestartCount: 4 }))).toEqual({
      reason: 'Restarting',
      health: 'failing',
      restarts: 4
    })
  })

  it('is Unhealthy when its healthcheck fails, and Starting until the healthcheck has passed', () => {
    expect(containerStatusOf(container({ Status: 'running', Health: { Status: 'unhealthy' } }))).toMatchObject({ reason: 'Unhealthy', health: 'failing' })
    expect(containerStatusOf(container({ Status: 'running', Health: { Status: 'starting' } }))).toMatchObject({ reason: 'Starting', health: 'pending' })
    expect(containerStatusOf(container({ Status: 'running', Health: { Status: 'healthy' } }))).toMatchObject({ reason: 'Running', health: 'healthy' })
  })

  it('is Paused, Dead, Created or Removing as the engine says', () => {
    expect(containerStatusOf(container({ Status: 'paused' }))).toMatchObject({ reason: 'Paused', health: 'inactive' })
    expect(containerStatusOf(container({ Status: 'dead' }))).toMatchObject({ reason: 'Dead', health: 'failing' })
    expect(containerStatusOf(container({ Status: 'created' }))).toMatchObject({ reason: 'Created', health: 'pending' })
    expect(containerStatusOf(container({ Status: 'removing' }))).toMatchObject({ reason: 'Removing', health: 'inactive' })
  })

  it('tells when a restarted container’s last run ended', () => {
    const status = containerStatusOf(container({ Status: 'running', FinishedAt: '2026-10-12T09:59:58.5Z' }, { RestartCount: 2 }))

    expect(status).toEqual({ reason: 'Running', health: 'healthy', restarts: 2, lastRestart: Date.parse('2026-10-12T09:59:58.5Z') })
  })
})

describe('a container’s current run', () => {
  it('is running, with its restarts', () => {
    expect(containerRunOf(container({ Status: 'running' }, { RestartCount: 3 }))).toEqual({ restarts: 3, state: 'running', finished: false })
  })

  it('is waiting while the engine restarts it, or before it first starts', () => {
    expect(containerRunOf(container({ Status: 'restarting' }))).toMatchObject({ state: 'waiting', finished: false })
    expect(containerRunOf(container({ Status: 'created' }))).toMatchObject({ state: 'waiting', finished: false })
  })

  it('is over for good once it has exited: the engine would be restarting it otherwise', () => {
    expect(containerRunOf(container({ Status: 'exited', ExitCode: 1 }))).toEqual({ restarts: 0, state: 'terminated', finished: true })
    expect(containerRunOf(container({ Status: 'dead' }))).toMatchObject({ state: 'terminated', finished: true })
  })

  it('goes on while paused', () => {
    expect(containerRunOf(container({ Status: 'paused' }))).toMatchObject({ state: 'running', finished: false })
  })
})
