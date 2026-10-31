import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, SaveCopyEvent } from '@shared/core-api'
import { MB } from '@shared/settings'
import { createCore, type Core } from './core'
import type { LogSource } from './log-source'

// A logger's coloured console output, as it lands in a log.
const coloured = '\x1b[32mINF\x1b[0m started\n\x1b[1;31mERROR\x1b[0m disk full\n'
const plain = 'INF started\nERROR disk full\n'

let dir: string
let core: Core
let sourceId: string
let events: FollowEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-escapes-'))
  core = createCore({ cacheDir: join(dir, '.cache') })
  sourceId = (await core.addSource({ type: 'local', name: 'Logs', rootPath: dir })).id
  await core.connect(sourceId)
  events = []
  core.onFollowEvent((event) => events.push(event))
})

/** A Follow's lines so far. */
const linesOf = (followId: string) => events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : []))

/** Waits for `check` to pass, long enough for a few looks at a file. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 100 })

afterEach(async () => {
  await core.disconnect(sourceId)
  await rm(dir, { recursive: true, force: true })
})

describe('a file opened in the editor', () => {
  it('opens without escape sequences when it opens as a log', async () => {
    await writeFile(join(dir, 'app.log'), coloured)

    expect(await core.openFile(sourceId, 'app.log')).toMatchObject({ language: 'log', content: plain })
  })

  it('opens unchanged in any other language', async () => {
    await writeFile(join(dir, 'notes.txt'), coloured)
    await writeFile(join(dir, 'colours.sh'), coloured)

    expect(await core.openFile(sourceId, 'notes.txt')).toMatchObject({ content: coloured })
    expect(await core.openFile(sourceId, 'colours.sh')).toMatchObject({ content: coloured })
  })
})

describe('a file read for VS Code’s editor, in the Extension Copy', () => {
  it('reads without escape sequences when it opens as a log', async () => {
    await writeFile(join(dir, 'app.log'), coloured)

    expect(Buffer.from(await core.readFile(sourceId, 'app.log')).toString()).toBe(plain)
  })

  it('reads without them in the encoding it is stored in, its BOM kept', async () => {
    const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16()
    await writeFile(join(dir, 'le.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(coloured, 'utf16le')]))
    await writeFile(join(dir, 'be.log'), Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(coloured)]))
    await writeFile(join(dir, 'latin1.log'), Buffer.from(`\x1b[1mcafé\x1b[0m\n`, 'latin1'))

    expect(Buffer.from(await core.readFile(sourceId, 'le.log'))).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plain, 'utf16le')]))
    expect(Buffer.from(await core.readFile(sourceId, 'be.log'))).toEqual(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(plain)]))
    expect(Buffer.from(await core.readFile(sourceId, 'latin1.log'))).toEqual(Buffer.from('café\n', 'latin1'))
  })

  it('reads unchanged in any other language', async () => {
    await writeFile(join(dir, 'notes.txt'), coloured)

    expect(Buffer.from(await core.readFile(sourceId, 'notes.txt')).toString()).toBe(coloured)
  })
})

describe("a file's last lines", () => {
  it('open in a log view without escape sequences', async () => {
    await writeFile(join(dir, 'app.out'), coloured)

    expect(await core.openFileLog(sourceId, 'app.out', { lastNLines: 2 })).toMatchObject({ content: 'INF started\nERROR disk full' })
  })

  it('are followed without escape sequences', async () => {
    await writeFile(join(dir, 'app.out'), coloured)
    const followed = await core.followFile(sourceId, 'app.out', { lastNLines: 2 })
    expect(followed).toMatchObject({ content: 'INF started\nERROR disk full' })

    await appendFile(join(dir, 'app.out'), '\x1b[33mWRN\x1b[0m slow\n')
    await eventually(() => expect(linesOf(followed.followId)).toEqual(['WRN slow']))
  })
})

describe('a Log Stream', () => {
  /** `text`'s lines, each starting with when it was logged if `timestamps`. */
  const stamped = (text: string, timestamps = false) => (timestamps ? text.replace(/^(?=.)/gm, '2026-10-30T12:00:00.000Z ') : text)

  // A Log Stream whose lines are coloured: the last two read first, then the two before, then one arriving.
  const colouredLog: LogSource = {
    capabilities: { previousLog: false, restarts: false, status: false, since: false },
    listChildren: async () => [{ kind: 'logStream', name: 'web', path: 'web' }],
    logStreamAt: async () => ({ name: 'web' }),
    readLog: async (_path, { timestamps } = {}) => stamped(coloured, timestamps),
    readLogBack: async (_path, { before, timestamps }) =>
      before ? { text: stamped('\x1b[2mDBG\x1b[0m a\n\x1b[2mDBG\x1b[0m b\n', timestamps) } : { text: stamped(coloured, timestamps), before: 'earlier' },
    async followLog(_path, _options, onText) {
      setTimeout(() => onText('2026-10-30T12:00:01.000Z \x1b[33mWRN\x1b[0m slow\n'))
      return { ended: new Promise<void>(() => {}), stop: () => {} }
    }
  }

  let logsCore: Core
  let logSourceId: string

  beforeEach(async () => {
    logsCore = createCore({ openLogSource: async () => colouredLog })
    logSourceId = (await logsCore.addSource({ type: 'kubernetesLogs', name: 'Cluster', context: 'kind', namespace: 'default' })).id
    await logsCore.connect(logSourceId)
    logsCore.onFollowEvent((event) => events.push(event))
  })

  afterEach(async () => {
    await logsCore.disconnect(logSourceId)
  })

  it('opens without escape sequences', async () => {
    expect(await logsCore.openLog(logSourceId, 'web', { lastNLines: 2 })).toMatchObject({ content: 'INF started\nERROR disk full' })
  })

  it('reads its earlier lines without escape sequences', async () => {
    const { earlier } = await logsCore.openLog(logSourceId, 'web', { lastNLines: 2 })

    expect(await logsCore.readEarlierLog(logSourceId, 'web', { earlier: earlier!, lines: 2 })).toMatchObject({ content: 'DBG a\nDBG b' })
  })

  it('is followed without escape sequences', async () => {
    const followed = await logsCore.followLog(logSourceId, 'web', { lastNLines: 2 })
    expect(followed).toMatchObject({ content: 'INF started\nERROR disk full' })

    await eventually(() => expect(linesOf(followed.followId)).toEqual(['WRN slow']))
  })
})

describe('a copy saved of a file', () => {
  /** Saves a copy of `name` beside it, returning what was saved once it's done. */
  async function savedCopyOf(name: string) {
    const saved: SaveCopyEvent[] = []
    core.onSaveCopyEvent((event) => saved.push(event))
    const target = join(dir, `copy-of-${name}`)
    const { saveId } = await core.saveCopy(sourceId, name, target)
    await vi.waitFor(() => expect(saved.findLast((event) => event.saveId === saveId)?.state).toBe('saved'), { timeout: 10_000 })
    return readFile(target, 'utf8')
  }

  it('keeps its escape sequences, byte for byte as stored', async () => {
    await writeFile(join(dir, 'app.log'), coloured)

    expect(await savedCopyOf('app.log')).toBe(coloured)
  })

  it('keeps them for a Large File too', async () => {
    await core.updateSettings({ largeFileThreshold: MB, openAnywayLimit: MB })
    const large = coloured.repeat(40_000)
    await writeFile(join(dir, 'large.log'), large)
    expect(await core.openFile(sourceId, 'large.log')).toMatchObject({ view: 'large' })

    expect(await savedCopyOf('large.log')).toBe(large)
  })
})
