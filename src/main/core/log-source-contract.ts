import { describe, expect, it, vi } from 'vitest'
import type { LogNode, SourcePath } from '@shared/core-api'
import type { LogSource } from './log-source'

export interface LogContractSubject {
  logSource: LogSource
  /** A container that has printed `line 1` to `line 100`, one per line, and nothing else. */
  counter: SourcePath
}

/** Every node of a tree, walking down from `path`; containers, the logs, are where it stops. */
async function walk(source: LogSource, path: SourcePath = ''): Promise<LogNode[]> {
  const children = await source.listChildren(path)
  const below = await Promise.all(children.map((node) => (node.kind === 'container' ? [] : walk(source, node.path))))
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

      it('lists no Previous Logs, only the restarts of the containers that have them', async () => {
        const { logSource } = await subject()
        for (const node of await walk(logSource)) {
          expect(['group', 'workload', 'pod', 'container'], node.path).toContain(node.kind)
          if (node.kind === 'container' && 'restarts' in node) expect(node.restarts, node.path).toBeGreaterThan(0)
        }
      })

      it('names each node by the last segment of its path, under its parent’s path', async () => {
        const { logSource } = await subject()
        for (const node of await walk(logSource)) {
          expect(lastSegment(node.path)).toBe(node.name)
          expect(node.path.split('/').length > 1 || node.kind === 'group', node.path).toBe(true)
        }
      })

      it('folds a pod’s only container into it, still listing the container under the pod', async () => {
        const { logSource } = await subject()
        const pods = (await walk(logSource)).filter((node) => node.kind === 'pod')
        expect(pods.length).toBeGreaterThan(0)
        for (const pod of pods) {
          const containers = await logSource.listChildren(pod.path)
          expect(pod.containerCount, pod.path).toBe(containers.length)
          const [only] = containers
          if (containers.length !== 1 || only?.kind !== 'container') {
            expect(pod, pod.path).not.toHaveProperty('container')
            continue
          }
          // Not its restarts: the container may restart between the two listings.
          const { kind, name, path, role } = only
          expect(pod.container, pod.path).toMatchObject({ kind, name, path, ...(role && { role }) })
        }
      })

      it('folds a Workload’s only pod, and a CronJob’s only Job, into it, still listing it under the Workload', async () => {
        const { logSource } = await subject()
        for (const group of await logSource.listChildren('')) expect(Object.keys(group), group.path).toEqual(['kind', 'workloadKind', 'name', 'path'])
        for (const workload of (await walk(logSource)).filter((node) => node.kind === 'workload')) {
          const children = await logSource.listChildren(workload.path)
          const [only] = children
          const field = workload.workloadKind === 'CronJob' ? 'job' : 'pod'
          expect(workload, workload.path).not.toHaveProperty(field === 'job' ? 'pod' : 'job')
          expect(Boolean(workload.empty), workload.path).toBe(children.length === 0)
          if (children.length !== 1 || !only) {
            expect(workload, workload.path).not.toHaveProperty(field)
            continue
          }
          // Only what names it: its status may change between the two listings.
          expect(workload[field], workload.path).toMatchObject({ kind: only.kind, name: only.name, path: only.path })
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

      it('has no Previous Log to give for a container that has not restarted', async () => {
        const { logSource, counter } = await subject()
        await expect(logSource.readLog(counter, { previous: true })).rejects.toMatchObject({ code: 'LOG_UNAVAILABLE' })
      })

      it('starts each line with when it was logged, when asked', async () => {
        const { logSource, counter } = await subject()
        const lines = (await logSource.readLog(counter, { tailLines: 2, timestamps: true })).split('\n')
        expect(lines).toEqual([expect.stringMatching(timestamped('line 99')), expect.stringMatching(timestamped('line 100')), ''])
      })

      it('tells a log’s pod and container, and how many times it has restarted', async () => {
        const { logSource, counter } = await subject()
        expect(await logSource.logStreamAt(counter)).toEqual({ pod: lastSegment(parentOf(counter)), container: lastSegment(counter), restarts: 0 })
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
