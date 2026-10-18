import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowEvent, NewSystemdJournalSource, TreeNode } from '@shared/core-api'
import { createCore, type Core } from './core'
import { counterLines, hasTestJournal, restartTestRestarter, testCounter, testFailer, testLevels, testRestarter, testSilent } from './journal-test-seed'
import { sshdTarget } from './ssh-test-server'

const settings = (changes: Partial<NewSystemdJournalSource> = {}): NewSystemdJournalSource => ({ type: 'systemdJournal', name: 'Laptop', ...changes })

/** Has the core believe it runs on `platform`, until the test ends. */
const pretendPlatform = (platform: NodeJS.Platform) => vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('adding a systemd Journal Source', () => {
  it('is listed, reading this machine’s journal unless told', async () => {
    pretendPlatform('linux')
    const core = createCore()

    const added = await core.addSource(settings())

    const unused = { host: '', user: '', auth: 'agent', keyFile: '', passphraseSet: false, passwordSet: false }
    const expected = { id: added.id, type: 'systemdJournal', name: 'Laptop', target: 'thisMachine', ...unused }
    expect(added).toEqual(expected)
    expect(await core.listSources()).toEqual([expected])
  })

  it('is refused for this machine when it isn’t Linux, which has no systemd journal', async () => {
    pretendPlatform('darwin')

    await expect(createCore().addSource(settings())).rejects.toMatchObject({ code: 'NO_JOURNAL' })
    await expect(createCore().testConnection(settings())).rejects.toMatchObject({ code: 'NO_JOURNAL' })
  })

  it('tells the OS the core runs on, for the dialog to offer this machine only on Linux', async () => {
    pretendPlatform('win32')

    expect(await createCore().platform()).toBe('win32')
  })
})

/**
 * Puts stand-ins for `journalctl` and `systemctl` alone on PATH: sh scripts with the given bodies (none for a command
 * left out), each noting its arguments in `calls` first. Returns `calls`' path.
 */
async function standIns(scripts: { journalctl?: string; systemctl?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'polyscope-journal-'))
  const calls = join(dir, 'calls')
  await writeFile(calls, '')
  for (const [command, body] of Object.entries(scripts)) {
    await writeFile(join(dir, command), `#!/bin/sh\necho "${command} $*" >> '${calls}'\n${body}\n`)
    await chmod(join(dir, command), 0o755)
  }
  vi.stubEnv('PATH', dir)
  return calls
}

/** The real journalctl's words to a user who may not read the system's journal, with nothing but the shell's builtins on PATH. */
const notPermitted = `printf '%s\\n' >&2 \\
  'Hint: You are currently not seeing messages from other users and the system.' \\
  "      Users in groups 'adm', 'systemd-journal', 'wheel' can see all messages." \\
  '      Pass -q to turn off this notice.' \\
  'No journal files were opened due to insufficient permissions.'
exit 1`

// The stand-ins are sh scripts.
describe.skipIf(process.platform === 'win32')('a systemd Journal Source’s failures', () => {
  it('says there’s no journal on a machine without journalctl', async () => {
    pretendPlatform('linux')
    await standIns({})

    await expect(createCore().testConnection(settings())).rejects.toMatchObject({ code: 'NO_JOURNAL' })
  })

  it('says to join the systemd-journal or adm group when the journal may not be read', async () => {
    pretendPlatform('linux')
    await standIns({ journalctl: notPermitted, systemctl: 'exit 1' })

    await expect(createCore().testConnection(settings())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringMatching(/systemd-journal.*adm/)
    })
  })

  it('refuses a unit’s name that isn’t one before running anything with it', async () => {
    pretendPlatform('linux')
    const calls = await standIns({ journalctl: 'echo nginx.service', systemctl: 'exit 1' })
    const core = createCore()
    const { id } = await core.addSource(settings())
    expect(names(await core.connect(id))).toEqual(['nginx.service'])
    await writeFile(calls, '')

    for (const path of ['nginx.service; reboot', '--since=yesterday', '../nginx.service', 'nginx', 'nginx.*']) {
      await expect(core.openLog(id, path), path).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(core.followLog(id, path), path).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await core.expand(id, path), path).toEqual([expect.objectContaining({ kind: 'error', code: 'NOT_FOUND' })])
    }
    expect(await readFile(calls, 'utf8')).toBe('')
  })
})

const names = (nodes: TreeNode[]) => nodes.map((node) => ('name' in node ? node.name : node.kind))

/** Collects every Follow update the core sends, by followId. */
function followUpdates(core: Core) {
  const events: FollowEvent[] = []
  const unsubscribe = core.onFollowEvent((event) => events.push(event))
  const of = (followId: string) => events.filter((e) => e.followId === followId).flatMap((e) => (e.kind === 'lines' ? e.lines : [e.kind]))
  return { events, of, unsubscribe }
}

describe.skipIf(!hasTestJournal)('a systemd Journal Source on this machine’s journal', () => {
  let core: Core
  let sourceId: string
  let root: TreeNode[]

  beforeAll(async () => {
    core = createCore()
    sourceId = (await core.addSource(settings())).id
    root = await core.connect(sourceId)
  })

  it('tests a connection by reading the journal', async () => {
    expect(await createCore().testConnection(settings())).toEqual({})
  })

  it('lists the units that have logged, with their active states, failed units first', async () => {
    const unit = (name: string) => root.find((node) => 'name' in node && node.name === name)

    expect(unit(testCounter)).toEqual({
      kind: 'logStream',
      name: testCounter,
      path: testCounter,
      status: { reason: 'active', health: 'healthy', restarts: 0 },
      systemd: { kind: 'unit', description: expect.any(String) }
    })
    expect(unit(testFailer)).toMatchObject({ status: { reason: 'failed', health: 'failing' } })
    const failing = root.filter((node) => 'status' in node && node.status?.health === 'failing').length
    expect(names(root).indexOf(testFailer)).toBeLessThan(failing)
  })

  it('leaves out units that have never logged', async () => {
    expect(names(root)).not.toContain(testSilent)
  })

  it('opens a unit’s last N lines, with their timestamps when asked', async () => {
    expect(await core.openLog(sourceId, testCounter, { lastNLines: 2 })).toMatchObject({ content: 'line 99\nline 100', offersPreviousLog: false })
    const { content } = await core.openLog(sourceId, testCounter, { lastNLines: 1, timestamps: true })
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z line 100$/)
  })

  it('shows only the lines logged since a time, at most the last N of them', async () => {
    const since = async (time: string, lastNLines: number | 'all') => (await core.openLog(sourceId, testCounter, { since: time, lastNLines })).content

    expect((await core.openLog(sourceId, testCounter, { since: '2999-01-01T00:00:00Z' })).offersSince).toBe(true)
    expect(await since('2999-01-01T00:00:00Z', 'all')).toBe('')
    expect(await since('2000-01-01T00:00:00Z', 'all')).toBe(counterLines.join('\n'))
    expect(await since('2000-01-01T00:00:00Z', 3)).toBe('line 98\nline 99\nline 100')
  })

  it('follows on from the lines since a time, repeating none of them', { timeout: 15_000 }, async () => {
    // Since when the restarter's current run logged.
    const [stamped] = (await core.openLog(sourceId, testRestarter, { lastNLines: 1, timestamps: true })).content.split('\n')
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, testRestarter, { lastNLines: 1_000, since: stamped!.slice(0, stamped!.indexOf(' ')) })
    const run = stamped!.slice(stamped!.indexOf(' ') + 1)
    // From the start of its second, which may hold systemd's own line starting the run.
    expect(followed.content.split('\n').filter((line) => /^run \d+$/.test(line))).toEqual([run])

    await restartTestRestarter()
    await vi.waitFor(() => expect(updates.of(followed.followId)).toContainEqual(expect.stringMatching(/^run \d+$/)), { timeout: 10_000 })
    // systemd's own lines about the restart come too; of the runs', only the new run's.
    const runs = updates.of(followed.followId).filter((line) => /^run \d+$/.test(line))
    expect(runs).toHaveLength(1)
    expect(runs).not.toContain(run)
    await core.stopFollow(followed.followId)
    updates.unsubscribe()
  })

  it('shows journal priorities as log levels', async () => {
    const { content } = await core.openLog(sourceId, testLevels, { lastNLines: 'all' })

    for (const line of ['CRIT reactor meltdown', 'ERROR disk full', 'WARNING low memory', 'all good', 'DEBUG tick']) expect(content.split('\n')).toContain(line)
  })

  it('refuses a unit’s name that isn’t one, and a unit that has never logged', async () => {
    await expect(core.openLog(sourceId, 'polyscope counter.service')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(core.openLog(sourceId, testSilent)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('holds a Follow’s lines back while paused, and sends them once resumed', { timeout: 15_000 }, async () => {
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, testRestarter, { lastNLines: 1 })
    expect(followed.content).toMatch(/^run \d+$/)

    await core.pauseFollow(followed.followId)
    await restartTestRestarter()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(updates.of(followed.followId)).toEqual([])

    await core.resumeFollow(followed.followId)
    expect(updates.of(followed.followId)).toContainEqual(expect.stringMatching(/^run \d+$/))
    await core.stopFollow(followed.followId)
    updates.unsubscribe()
  })

  it('goes on following a unit across its restarts, as the journal does', { timeout: 30_000 }, async () => {
    const updates = followUpdates(core)
    const followed = await core.followLog(sourceId, testRestarter, { lastNLines: 1 })

    await restartTestRestarter()
    await vi.waitFor(() => expect(updates.of(followed.followId)).toContainEqual(expect.stringMatching(/^run \d+$/)), { timeout: 10_000 })
    await restartTestRestarter()
    await vi.waitFor(() => expect(updates.of(followed.followId).filter((line) => /^run \d+$/.test(line))).toHaveLength(2), { timeout: 10_000 })

    expect(updates.of(followed.followId)).not.toContain('ended')
    await core.stopFollow(followed.followId)
    updates.unsubscribe()
  })
})

// The same journal on a host over SSH: this machine, through sshd on localhost, as CI runs it.
describe.skipIf(!hasTestJournal || !sshdTarget)('a systemd Journal Source on a host over sshd', () => {
  let home: string
  let core: Core
  let settings: NewSystemdJournalSource

  beforeAll(async () => {
    const sshd = sshdTarget!
    settings = { type: 'systemdJournal', name: 'sshd', target: 'ssh', host: sshd.host, port: sshd.port, user: sshd.user, auth: 'keyFile', keyFile: sshd.keyFile }
    // A home of the tests' own, so the user's real ~/.ssh is never read, and its host key unknown until trusted.
    home = await mkdtemp(join(tmpdir(), 'polyscope-journal-sshd-'))
    await mkdir(join(home, '.ssh'))
    core = createCore({ dataDir: join(home, 'user-data') })
  })

  beforeEach(() => {
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterAll(() => rm(home, { recursive: true, force: true }))

  it('offers sshd’s host key to trust, then tests a connection by reading the journal', async () => {
    const failure = (await core.testConnection(settings).catch((error: unknown) => error)) as { code: string; hostKey: never }
    expect(failure).toMatchObject({ code: 'HOST_KEY_UNKNOWN' })
    await core.trustHostKey(failure.hostKey)

    await expect(core.testConnection(settings)).resolves.toEqual({})
  })

  it('lists the units with their states, reads a unit’s last lines, and follows it across restarts', { timeout: 30_000 }, async () => {
    const { id } = await core.addSource(settings)
    const root = await core.connect(id)

    expect(root).toContainEqual(expect.objectContaining({ name: testCounter, status: { reason: 'active', health: 'healthy', restarts: 0 } }))
    expect(root.find((node) => 'name' in node && node.name === testFailer)).toMatchObject({ status: { health: 'failing' } })
    expect(await core.openLog(id, testCounter, { lastNLines: 2 })).toMatchObject({ content: 'line 99\nline 100' })
    expect((await core.openLog(id, testCounter, { since: '2999-01-01T00:00:00Z' })).content).toBe('')
    expect((await core.openLog(id, testCounter, { since: '2000-01-01T00:00:00Z', lastNLines: 'all' })).content).toBe(counterLines.join('\n'))
    expect((await core.openLog(id, testCounter, { since: '2000-01-01T00:00:00Z', lastNLines: 3 })).content).toBe('line 98\nline 99\nline 100')

    const updates = followUpdates(core)
    const followed = await core.followLog(id, testRestarter, { lastNLines: 1 })
    await restartTestRestarter()
    await vi.waitFor(() => expect(updates.of(followed.followId)).toContainEqual(expect.stringMatching(/^run \d+$/)), { timeout: 10_000 })
    await core.disconnect(id)
    expect(updates.of(followed.followId)).toContain('ended')
    updates.unsubscribe()
  })
})
