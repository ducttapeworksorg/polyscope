import { describe, expect, it, vi } from 'vitest'
import type { LogCapabilities, LogNode, SourcePath } from '@shared/core-api'
import type { LogSource } from './log-source'

export interface LogContractSubject {
  logSource: LogSource
  /** A Log Stream that has logged `line 1` to `line 100`, one per line, and nothing else, and goes on running. It has no children, hasn't restarted, and is under a group. */
  counter: SourcePath
}

/** A node of a tree, with the path of the node it was listed under. */
interface Listed {
  parent: SourcePath
  node: LogNode
}

/** Every node of a tree, walking down from `path`; Log Streams without children are where it stops. */
async function walk(source: LogSource, path: SourcePath = ''): Promise<Listed[]> {
  const children = await source.listChildren(path)
  const below = await Promise.all(children.map((node) => (node.kind === 'logStream' && !node.hasChildren ? [] : walk(source, node.path))))
  return children.flatMap((node, i) => [{ parent: path, node }, ...below[i]!])
}

/** A node and every node folded into it, in turn. */
const withFolded = (node: LogNode): LogNode[] => (node.kind === 'group' && node.folded ? [node, ...withFolded(node.folded)] : [node])

/** Every node of a tree, with those folded into others: all the nodes it shows. */
const shownNodes = async (source: LogSource) => (await walk(source)).flatMap(({ node }) => withFolded(node))

/** Some of a tree's groups, which have no logs: the first few, and the counter's own. */
const someGroups = async (source: LogSource, counter: SourcePath) => {
  const groups = (await walk(source)).map(({ node }) => node).filter((node) => node.kind === 'group')
  return [...new Set([...groups.slice(0, 3).map((node) => node.path), parentOf(counter)])]
}

const parentOf = (path: SourcePath) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const lastSegment = (path: SourcePath) => path.slice(path.lastIndexOf('/') + 1)
/** A log line starting with an RFC 3339 UTC timestamp, then `text`. */
const timestamped = (text: string) => new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ${text}$`)
const counterLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('')

/**
 * The behaviour every Log Source must show, and what it offers beyond that as far as its Source Type's `capabilities`
 * say, which it must declare. A Source Type's tests call this with a function returning a Log Source whose backend
 * holds a `counter` Log Stream, as described in LogContractSubject.
 */
export function describeLogSourceContract(name: string, capabilities: LogCapabilities, subject: () => Promise<LogContractSubject>) {
  describe(`${name} as a Log Source`, () => {
    it('declares its capabilities', async () => {
      const { logSource } = await subject()
      expect(logSource.capabilities).toEqual(capabilities)
    })

    describe('the tree', () => {
      it('has nodes under its root, each a group or a Log Stream, and no Previous Logs', async () => {
        const { logSource } = await subject()
        expect((await logSource.listChildren('')).length).toBeGreaterThan(0)
        for (const node of await shownNodes(logSource)) expect(['group', 'logStream'], node.path).toContain(node.kind)
      })

      it('names each node by the last segment of its path, under its parent’s path', async () => {
        const { logSource } = await subject()
        for (const { parent, node } of await walk(logSource)) {
          expect(lastSegment(node.path)).toBe(node.name)
          expect(parentOf(node.path), node.path).toBe(parent)
        }
      })

      it('folds a group’s only child into it, still listing the child under the group', async () => {
        const { logSource } = await subject()
        for (const { node } of await walk(logSource)) {
          const children = node.kind === 'logStream' && !node.hasChildren ? [] : await logSource.listChildren(node.path)
          if (node.empty) expect(children, node.path).toEqual([])
          if (node.kind !== 'group' || !node.folded) continue
          expect(node.unfoldable, node.path).toBeUndefined()
          expect(children, node.path).toHaveLength(1)
          // Only what names it: how it's doing may change between the two listings.
          const { kind, name, path } = children[0]!
          expect(node.folded, node.path).toMatchObject({ kind, name, path })
        }
      })

      it('lists the counter Log Stream', async () => {
        const { logSource, counter } = await subject()
        const siblings = await logSource.listChildren(parentOf(counter))
        expect(siblings).toContainEqual(expect.objectContaining({ kind: 'logStream', path: counter }))
      })

      it('has nothing under a Log Stream without children', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.listChildren(counter)).rejects.toMatchObject({ code: 'NOT_A_FOLDER' })
      })

      it('reports a path that is not in the tree', async () => {
        const { logSource, counter } = await subject()
        for (const path of ['no-such-node', `${parentOf(counter)}/no-such-node/x`, `${parentOf(counter)}/no-such-node`]) {
          await expect(logSource.listChildren(path), path).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }
      })

      if (capabilities.status) {
        it('may tell how its nodes are doing', async () => {
          const { logSource } = await subject()
          for (const node of await shownNodes(logSource)) {
            if (node.status) expect(node.status, node.path).toMatchObject({ reason: expect.any(String), health: expect.any(String) })
          }
        })
      } else {
        it('tells no status', async () => {
          const { logSource } = await subject()
          for (const node of await shownNodes(logSource)) expect(node, node.path).not.toHaveProperty('status')
        })
      }

      if (capabilities.restarts) {
        it('tells the restarts only of the Log Streams that have restarted', async () => {
          const { logSource } = await subject()
          for (const node of await shownNodes(logSource)) {
            if (node.kind === 'logStream' && 'restarts' in node) expect(node.restarts, node.path).toBeGreaterThan(0)
          }
        })
      } else {
        it('tells no restarts', async () => {
          const { logSource } = await subject()
          for (const node of await shownNodes(logSource)) expect(node, node.path).not.toHaveProperty('restarts')
        })
      }
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

      it('reads only Log Streams', async () => {
        const { logSource, counter } = await subject()
        for (const path of ['', ...(await someGroups(logSource, counter))]) {
          await expect(logSource.readLog(path), path).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
        }
      })

      it('reports a Log Stream that is not there', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.readLog(`${parentOf(counter)}/no-such-log`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('starts each line with when it was logged, when asked', async () => {
        const { logSource, counter } = await subject()
        const lines = (await logSource.readLog(counter, { tailLines: 2, timestamps: true })).split('\n')
        expect(lines).toEqual([expect.stringMatching(timestamped('line 99')), expect.stringMatching(timestamped('line 100')), ''])
      })

      it('tells a log’s name', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.logStreamAt(counter)).toMatchObject({ name: lastSegment(counter) })
        for (const path of await someGroups(logSource, counter)) {
          await expect(logSource.logStreamAt(path), path).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
        }
      })

      if (capabilities.previousLog) {
        it('has no Previous Log to give for a Log Stream that has not restarted', async () => {
          const { logSource, counter } = await subject()
          expect(await logSource.logStreamAt(counter)).toMatchObject({ hasPreviousLog: false })
          await expect(logSource.readLog(counter, { previous: true })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
        })
      } else {
        it('tells of no Previous Log', async () => {
          const { logSource, counter } = await subject()
          expect(await logSource.logStreamAt(counter)).not.toHaveProperty('hasPreviousLog')
        })
      }
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

      it('follows only Log Streams', async () => {
        const { logSource, counter } = await subject()
        for (const path of await someGroups(logSource, counter)) {
          await expect(logSource.followLog(path, {}, () => undefined), path).rejects.toMatchObject({ code: 'NOT_A_LOG_STREAM' })
        }
      })

      if (capabilities.restarts) {
        it('tells how the Log Stream’s current run is going', async () => {
          const { logSource, counter } = await subject()
          expect(await logSource.currentRun?.(counter)).toEqual({ restarts: 0, state: 'running', finished: false })
        })
      } else {
        it('has no runs to tell of', async () => {
          const { logSource } = await subject()
          expect(logSource.currentRun).toBeUndefined()
        })
      }
    })
  })
}
