import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, LogCapabilities } from '@shared/core-api'
import { createCore, type Core } from './core'
import { createFakeLogSource, loggedAt, type FakeLogSourceOptions } from './fake-log-source'

const none: LogCapabilities = { previousLog: false, restarts: false, status: false, since: false }

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
    await connected({ capabilities: { previousLog: true, restarts: true, status: true, since: false } })

    expect(await core.openLog(sourceId, 'app/counter')).toMatchObject({ offersPreviousLog: true, restarted: false })
  })
})

describe('a Log Source Type without Since', () => {
  it('opens a Log Stream offering no Since, and is never asked to read from a time', async () => {
    const fake = await connected({ capabilities: none })

    expect(await core.openLog(sourceId, 'app/counter', { lastNLines: 1 })).toMatchObject({ offersSince: false })
    await expect(core.openLog(sourceId, 'app/counter', { since: loggedAt(98) })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
    expect(fake.sinceAsked).toEqual([])
  })
})

describe('a Log Source Type with Since', () => {
  const since = { ...none, since: true }

  /** Every line a Follow sends, as they come, until stopped. */
  function followed() {
    const lines: string[] = []
    const unsubscribe = core.onFollowEvent((event) => event.kind === 'lines' && lines.push(...event.lines))
    return { lines, unsubscribe }
  }

  it('opens a Log Stream offering Since, showing only the lines logged since a time', async () => {
    await connected({ capabilities: since })

    expect(await core.openLog(sourceId, 'app/counter', { since: loggedAt(98) })).toMatchObject({ offersSince: true, content: 'line 98\nline 99\nline 100' })
    expect((await core.openLog(sourceId, 'app/counter', { since: loggedAt(98), lastNLines: 'all' })).content).toBe('line 98\nline 99\nline 100')
  })

  it('still shows at most the last N lines of those', async () => {
    await connected({ capabilities: since })

    expect((await core.openLog(sourceId, 'app/counter', { since: loggedAt(50), lastNLines: 2 })).content).toBe('line 99\nline 100')
  })

  it('reads from a time given in any time zone', async () => {
    await connected({ capabilities: since })

    expect((await core.openLog(sourceId, 'app/counter', { since: '2026-01-01T02:01:39+02:00' })).content).toBe('line 99\nline 100')
  })

  it('refuses a time it can’t read', async () => {
    const fake = await connected({ capabilities: since })

    await expect(core.openLog(sourceId, 'app/counter', { since: 'yesterday-ish' })).rejects.toMatchObject({ code: 'INVALID_SINCE' })
    expect(fake.sinceAsked).toEqual([])
  })

  it('follows on from the snapshot’s last line, repeating none', async () => {
    await connected({ capabilities: since })
    const follow = followed()
    try {
      const log = await core.followLog(sourceId, 'app/counter', { since: loggedAt(99) })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(log.content).toBe('line 99\nline 100')
      expect(follow.lines).toEqual([])
    } finally {
      follow.unsubscribe()
    }
  })

  it('follows on from the time when nothing was logged since it yet', async () => {
    await connected({ capabilities: since })
    const follow = followed()
    try {
      const log = await core.followLog(sourceId, 'app/counter', { since: '2999-01-01T00:00:00Z' })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(log.content).toBe('')
      expect(follow.lines).toEqual([])
    } finally {
      follow.unsubscribe()
    }
  })

  it('reads a Previous Log from the time too', async () => {
    const fake = await connected({ capabilities: { previousLog: true, restarts: true, status: true, since: true } })

    await expect(core.openLog(sourceId, 'app/counter', { since: loggedAt(98), previous: true })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
    expect(fake.sinceAsked).toEqual([{ path: 'app/counter', sinceTime: loggedAt(98), previous: true }])
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
