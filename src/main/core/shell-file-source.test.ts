import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { describeFileSourceContract } from './file-source-contract'
import { CoreError } from './core-error'
import { createShellFileSource, type Shell } from './shell-file-source'

// The scripts a pod runs, run here by the local sh: coreutils on Linux and on Windows (Git's). Skipped where
// the tools aren't coreutils or busybox, like macOS's BSD stat.
const hasSh = spawnSync('sh', ['-c', 'stat -c %s .'], { encoding: 'utf8' }).status === 0

/** Runs scripts with the local sh, as a pod's would be. */
const localShell: Shell = (script, args) =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script, 'sh', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error) => reject(new CoreError('NO_SHELL', error.message)))
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: new Uint8Array(Buffer.concat(stdout)), stderr }))
  })

// Every call starts a few processes, which Git's sh on Windows is slow at.
vi.setConfig({ testTimeout: 30_000 })

describe.skipIf(!hasSh)('a Shell File Source run by the local sh', () => {
  const seedRoot = async (tree: Record<string, string | Uint8Array | null>) => {
    const root = await mkdtemp(join(tmpdir(), 'polyscope-shell-'))
    const entries = Object.entries(tree).map(([path, content]) => ({ absolute: join(root, path), content }))
    const folders = new Set(entries.map(({ absolute, content }) => (content === null ? absolute : dirname(absolute))))
    await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })))
    await Promise.all(entries.map(({ absolute, content }) => content !== null && writeFile(absolute, content)))
    // The shell's own way of writing the path: '/'-separated, as Git's sh on Windows also takes it.
    return { root, shellRoot: root.replaceAll('\\', '/') }
  }

  describeFileSourceContract('Shell', async (tree) => {
    const { root, shellRoot } = await seedRoot(tree)
    return { fileSource: createShellFileSource(localShell, shellRoot), dispose: () => rm(root, { recursive: true, force: true }) }
  })

  it('lists dotfiles and names with spaces', async () => {
    const { root, shellRoot } = await seedRoot({ '.env': 'x', 'my notes.txt': 'y', '..odd': 'z' })
    try {
      const names = (await createShellFileSource(localShell, shellRoot).listChildren('')).entries.map((e) => e.name).sort()
      expect(names).toEqual(['..odd', '.env', 'my notes.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Windows needs privileges to make links.
  it.skipIf(process.platform === 'win32')('lists what links lead to, and flags links that lead nowhere', async () => {
    const { root, shellRoot } = await seedRoot({ 'logs/a.log': 'a' })
    try {
      await symlink('logs', join(root, 'current'))
      await symlink('missing', join(root, 'dangling'))
      await symlink('loop', join(root, 'loop'))
      const entries = (await createShellFileSource(localShell, shellRoot).listChildren('')).entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))
      expect(entries).toEqual([
        { kind: 'folder', name: 'current', modifiedTime: expect.any(Number) },
        { kind: 'file', name: 'dangling', problem: expect.objectContaining({ code: 'NOT_FOUND' }) },
        { kind: 'file', name: 'loop', problem: expect.objectContaining({ code: 'NOT_FOUND' }) },
        { kind: 'folder', name: 'logs', modifiedTime: expect.any(Number) }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses paths that climb out of its root', async () => {
    const { root, shellRoot } = await seedRoot({ 'a.log': 'a' })
    try {
      const source = createShellFileSource(localShell, shellRoot)
      await expect(source.listChildren('..')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SOURCE' })
      await expect(source.stat('logs/../../x')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SOURCE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says which tool is missing when a container lacks one', async () => {
    // A shell whose PATH has none of the tools.
    const bare: Shell = (script, args) => localShell(`PATH=/nonexistent; ${script}`, args)
    const { root, shellRoot } = await seedRoot({ 'a.log': 'a' })
    try {
      await expect(createShellFileSource(bare, shellRoot).stat('a.log')).rejects.toMatchObject({
        code: 'TOOLS_MISSING',
        message: expect.stringContaining('stat')
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
