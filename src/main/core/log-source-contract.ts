import { describe, expect, it } from 'vitest'
import type { LogNode, SourcePath } from '@shared/core-api'
import type { LogSource } from './log-source'

export interface LogContractSubject {
  logSource: LogSource
  /** A container that has printed `line 1` to `line 100`, one per line, and nothing else. */
  counter: SourcePath
}

/** Every node of a tree, walking down from `path`; containers are where it stops. */
async function walk(source: LogSource, path: SourcePath = ''): Promise<LogNode[]> {
  const children = await source.listChildren(path)
  const below = await Promise.all(children.map((node) => (node.kind === 'container' ? [] : walk(source, node.path))))
  return children.flatMap((node, i) => [node, ...below[i]!])
}

const parentOf = (path: SourcePath) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const lastSegment = (path: SourcePath) => path.slice(path.lastIndexOf('/') + 1)
const counterLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('')

/**
 * The behaviour every Log Source must show. A Source Type's tests call this with a function returning a
 * Log Source whose backend holds a `counter` container, as described in LogContractSubject.
 */
export function describeLogSourceContract(name: string, subject: () => Promise<LogContractSubject>) {
  describe(`${name} as a Log Source`, () => {
    describe('the tree', () => {
      it('starts with groups, and reaches containers only through pods', async () => {
        const { logSource } = await subject()
        const root = await logSource.listChildren('')
        expect(root.length).toBeGreaterThan(0)
        expect(root.every((node) => node.kind === 'group')).toBe(true)

        const nodes = await walk(logSource)
        for (const node of nodes.filter((n) => n.kind === 'container')) {
          const parent = nodes.find((n) => n.path === parentOf(node.path))
          expect(parent?.kind, node.path).toBe('pod')
        }
      })

      it('names each node by the last segment of its path, under its parent’s path', async () => {
        const { logSource } = await subject()
        for (const node of await walk(logSource)) {
          expect(lastSegment(node.path)).toBe(node.name)
          expect(node.path.split('/').length > 1 || node.kind === 'group', node.path).toBe(true)
        }
      })

      it('lists the counter container', async () => {
        const { logSource, counter } = await subject()
        const siblings = await logSource.listChildren(parentOf(counter))
        expect(siblings).toContainEqual(expect.objectContaining({ kind: 'container', path: counter }))
      })

      it('has nothing under a container', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.listChildren(counter)).rejects.toMatchObject({ code: 'NOT_A_FOLDER' })
      })

      it('reports a path that is not in the tree', async () => {
        const { logSource, counter } = await subject()
        for (const path of ['no-such-group', `${parentOf(counter)}/no-such-container/x`, `${parentOf(parentOf(counter))}/no-such-pod`]) {
          await expect(logSource.listChildren(path), path).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }
      })
    })

    describe('reading a log', () => {
      it('reads all of it', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.readLog(counter)).toBe(counterLines(1, 100))
      })

      it('reads only the last lines', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.readLog(counter, { tailLines: 3 })).toBe(counterLines(98, 100))
      })

      it('reads everything when asked for more lines than there are', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.readLog(counter, { tailLines: 1_000 })).toBe(counterLines(1, 100))
      })

      it('stops after about as many bytes as asked for, from the start', async () => {
        const { logSource, counter } = await subject()
        const read = await logSource.readLog(counter, { limitBytes: 20 })
        expect(counterLines(1, 100).startsWith(read)).toBe(true)
        expect(read.length).toBeGreaterThanOrEqual(20)
        expect(read.length).toBeLessThan(100)
      })

      it('reads only containers', async () => {
        const { logSource, counter } = await subject()
        for (const path of ['', parentOf(counter)]) {
          await expect(logSource.readLog(path), path).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
        }
        await expect(logSource.readLog((await logSource.listChildren(''))[0]!.path)).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
      })

      it('reports a container that is not there', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.readLog(`${parentOf(counter)}/no-such-container`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })
  })
}
