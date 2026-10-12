import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, LogCapabilities } from '@shared/core-api'
import { createCore, type Core } from './core'
import { createFakeLogSource, type FakeLogSourceOptions } from './fake-log-source'

const none: LogCapabilities = { previousLog: false, restarts: false, status: false }

let core: Core
let sourceId: string

afterEach(async () => {
  await core.disconnect(sourceId)
})

/** A connected Log Source whose backend is a fake Log Source with these options. */
async function connected(options: FakeLogSourceOptions) {
  const fake = createFakeLogSource(options)
  core = createCore({ openLogSource: async () => fake.logSource })
  sourceId = (await core.addSource({ type: 'kubernetesLogs', name: 'Fake', context: 'fake', namespace: 'fake' })).id
  await core.connect(sourceId)
  return fake
}

describe('a Log Source Type without Previous Logs', () => {
  it('opens a Log Stream offering no Previous Log', async () => {
    await connected({ capabilities: none })

    expect(await core.openLog(sourceId, 'app/counter', { lastNLines: 2 })).toMatchObject({
      name: 'counter',
      offersPreviousLog: false,
      restarted: false,
      content: 'line 99\nline 100'
    })
  })

  it('is never asked for a Previous Log', async () => {
    const fake = await connected({ capabilities: none })

    await expect(core.openLog(sourceId, 'app/counter', { previous: true })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
    expect(fake.previousAsked).toEqual([])
  })
})

describe('a Log Source Type with Previous Logs', () => {
  it('opens a Log Stream offering its Previous Log', async () => {
    await connected({ capabilities: { previousLog: true, restarts: true, status: true } })

    expect(await core.openLog(sourceId, 'app/counter')).toMatchObject({ offersPreviousLog: true, restarted: false })
  })
})

describe('a Log Source Type without status or restarts', () => {
  it('shows neither, even if its nodes tell them', async () => {
    await connected({ capabilities: none, reportsAnyway: { status: true, restarts: true } })

    expect(await core.expand(sourceId, '')).toEqual([{ kind: 'group', name: 'app', path: 'app' }])
    expect(await core.expand(sourceId, 'app')).toEqual([
      { kind: 'logStream', name: 'counter', path: 'app/counter' },
      { kind: 'logStream', name: 'server', path: 'app/server', hasChildren: true }
    ])
  })
})

describe('a Log Source Type without restarts', () => {
  it('ends a Follow when its Log Stream ends, marking no restart', async () => {
    const fake = await connected({ capabilities: none })
    const events: FollowEvent[] = []
    const unsubscribe = core.onFollowEvent((event) => events.push(event))
    try {
      const { followId } = await core.followLog(sourceId, 'app/counter', { lastNLines: 2 })
      fake.endStreams()

      await vi.waitFor(() => expect(events).toContainEqual({ kind: 'ended', reason: 'exited', followId }))
      expect(events.map(({ kind }) => kind)).toEqual(['ended'])
    } finally {
      unsubscribe()
    }
  })
})

describe('a Log Stream with children', () => {
  it('lists them, and opens as a log', async () => {
    await connected({ capabilities: none })

    expect(await core.expand(sourceId, 'app/server')).toEqual([{ kind: 'logStream', name: 'worker', path: 'app/server/worker' }])
    expect(await core.openLog(sourceId, 'app/server', { lastNLines: 1 })).toMatchObject({ name: 'server', content: 'line 100' })
  })
})
