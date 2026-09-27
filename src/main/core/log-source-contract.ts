import { describe, expect, it, vi } from 'vitest'
import type { LogNode, SourcePath } from '@shared/core-api'
import type { LogSource } from './log-source'

export interface LogContractSubject {
  logSource: LogSource
  /** A container that has printed `line 1` to `line 100`, one per line, and nothing else. */
  counter: SourcePath
}

const isLog = (node: LogNode) => node.kind === 'container' || node.kind === 'previousLog'

/** Every node of a tree, walking down from `path`; logs are where it stops. */
async function walk(source: LogSource, path: SourcePath = ''): Promise<LogNode[]> {
  const children = await source.listChildren(path)
  const below = await Promise.all(children.map((node) => (isLog(node) ? [] : walk(source, node.path))))
  return children.flatMap((node, i) => [node, ...below[i]!])
}

const parentOf = (path: SourcePath) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const lastSegment = (path: SourcePath) => path.slice(path.lastIndexOf('/') + 1)
/** A log line starting with an RFC 3339 UTC timestamp, then `text`. */
const timestamped = (text: string) => new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ${text}$`)
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

      it('lists a Previous Log right after its container, under the container’s path', async () => {
        const { logSource } = await subject()
        const nodes = await walk(logSource)
        for (const [i, node] of nodes.entries()) {
          if (node.kind !== 'previousLog') continue
          expect(nodes[i - 1], node.path).toMatchObject({ kind: 'container', name: node.container, path: parentOf(node.path) })
          expect(nodes[i - 1]).toHaveProperty('restarts')
          await expect(logSource.listChildren(node.path)).rejects.toMatchObject({ code: 'NOT_A_FOLDER' })
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

      it('starts each line with when it was logged, when asked', async () => {
        const { logSource, counter } = await subject()
        const lines = (await logSource.readLog(counter, { tailLines: 2, timestamps: true })).split('\n')
        expect(lines).toEqual([expect.stringMatching(timestamped('line 99')), expect.stringMatching(timestamped('line 100')), ''])
      })

      it('tells a log’s pod and container', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.logStreamAt(counter)).toEqual({ pod: lastSegment(parentOf(counter)), container: lastSegment(counter), previous: false })
        await expect(logSource.logStreamAt(parentOf(counter))).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
      })
    })

    describe('following a log', () => {
      it('sends the current run from its start, with timestamps, and stays open for more', async () => {
        const { logSource, counter } = await subject()
        let text = ''
        const connection = await logSource.followLog(counter, {}, (piece) => (text += piece))
        try {
          await vi.waitFor(() => expect(text.split('\n')).toHaveLength(101), { timeout: 10_000 })
          const lines = text.split('\n')
          expect(lines.slice(0, 2)).toEqual([expect.stringMatching(timestamped('line 1')), expect.stringMatching(timestamped('line 2'))])
          expect(lines.slice(-2)).toEqual([expect.stringMatching(timestamped('line 100')), ''])
          const settled = await Promise.race([connection.ended.then(() => 'ended'), new Promise((resolve) => setTimeout(resolve, 500, 'open'))])
          expect(settled).toBe('open')
        } finally {
          connection.stop()
        }
      })

      it('sends only what was logged since a time', async () => {
        const { logSource, counter } = await subject()
        let text = ''
        const connection = await logSource.followLog(counter, { sinceTime: '2999-01-01T00:00:00Z' }, (piece) => (text += piece))
        await new Promise((resolve) => setTimeout(resolve, 500))
        connection.stop()
        expect(text).toBe('')
      })

      it('tells how the container is running', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.containerInstance(counter)).toEqual({ restarts: 0, state: 'running', finished: false })
      })

      it('follows only containers', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.followLog(parentOf(counter), {}, () => undefined)).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
      })
    })
  })
}
