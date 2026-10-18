import type { LogCapabilities, LogNode, NodeStatus, SourcePath } from '@shared/core-api'
import { CoreError } from './core-error'
import type { LogConnection, LogSource } from './log-source'

/** When the fake's counter logged its `n`th line: a second apart, from the start of 2026. */
export const loggedAt = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

const counterLines = Array.from({ length: 100 }, (_, i) => ({ time: loggedAt(i + 1), text: `line ${i + 1}` }))

const running: NodeStatus = { reason: 'Running', health: 'healthy', restarts: 0 }

export interface FakeLogSourceOptions {
  capabilities: LogCapabilities
  /** Whether its nodes tell their status and restarts anyway, whatever its capabilities say; as they say when left out. */
  reportsAnyway?: Partial<Pick<LogCapabilities, 'status' | 'restarts'>>
}

/**
 * An in-memory Log Source with a small tree: a group `app` holding the Log Stream `app/counter`, which logged
 * `line 1` to `line 100` and goes on running, and the Log Stream `app/server`, which has a Log Stream of its own,
 * `app/server/worker`. Every Log Stream logs the same lines.
 */
export function createFakeLogSource({ capabilities, reportsAnyway = {} }: FakeLogSourceOptions) {
  const { status = capabilities.status, restarts = capabilities.restarts } = reportsAnyway
  const withStatus = status ? { status: running } : {}
  const withRestarts = restarts ? { restarts: 2 } : {}
  const worker: LogNode = { kind: 'logStream', name: 'worker', path: 'app/server/worker', ...withStatus }
  const tree: Record<SourcePath, LogNode[]> = {
    '': [{ kind: 'group', name: 'app', path: 'app', ...withStatus }],
    app: [
      { kind: 'logStream', name: 'counter', path: 'app/counter', ...withStatus },
      { kind: 'logStream', name: 'server', path: 'app/server', hasChildren: true, ...withStatus, ...withRestarts }
    ],
    'app/server': [worker]
  }
  const nodeAt = (path: SourcePath) => Object.values(tree).flat().find((node) => node.path === path)
  const logStreamAt = async (path: SourcePath) => {
    const node = nodeAt(path)
    if (!path) throw new CoreError('NOT_A_LOG_STREAM', 'The root has no log')
    if (!node) throw new CoreError('NOT_FOUND', `Nothing at ${path}`)
    if (node.kind !== 'logStream') throw new CoreError('NOT_A_LOG_STREAM', `Only Log Streams have logs: ${path}`)
    return { name: node.name, ...(capabilities.previousLog && { hasPreviousLog: false }) }
  }
  const connections = new Set<{ end(): void }>()
  /** Every Previous Log it was asked for, by path. */
  const previousAsked: SourcePath[] = []
  /** Every read it was asked for with a Since. */
  const sinceAsked: { path: SourcePath; sinceTime: string; previous: boolean }[] = []

  const logSource: LogSource = {
    capabilities,
    async listChildren(path) {
      const children = tree[path]
      if (children) return children
      throw nodeAt(path) ? new CoreError('NOT_A_FOLDER', `A log has no children: ${path}`) : new CoreError('NOT_FOUND', `Nothing at ${path}`)
    },
    logStreamAt,
    async readLog(path, { tailLines, limitBytes, timestamps, previous, sinceTime } = {}) {
      await logStreamAt(path)
      if (sinceTime !== undefined) sinceAsked.push({ path, sinceTime, previous: previous === true })
      if (previous) {
        previousAsked.push(path)
        throw new CoreError('LOG_UNAVAILABLE', `${path} has not restarted`)
      }
      const since = sinceTime === undefined ? undefined : Date.parse(sinceTime)
      const logged = since === undefined ? counterLines : counterLines.filter(({ time }) => Date.parse(time) >= since)
      const lines = tailLines === undefined ? logged : logged.slice(-tailLines)
      const text = lines.map(({ time, text }) => `${timestamps ? `${time} ` : ''}${text}\n`).join('')
      if (limitBytes === undefined) return text
      // Whole lines, overshooting the limit to the end of the line it falls in.
      const end = text.indexOf('\n', limitBytes - 1)
      return end < 0 ? text : text.slice(0, end + 1)
    },
    async followLog(path, { sinceTime }, onText) {
      await logStreamAt(path)
      let end!: () => void
      const ended = new Promise<void>((resolve) => (end = resolve))
      const connection = { end }
      connections.add(connection)
      const since = sinceTime === undefined ? undefined : Date.parse(sinceTime)
      const text = counterLines
        .filter(({ time }) => since === undefined || Date.parse(time) >= since)
        .map(({ time, text }) => `${time} ${text}\n`)
        .join('')
      setTimeout(() => connections.has(connection) && text && onText(text))
      const stop = () => {
        connections.delete(connection)
        end()
      }
      return { ended, stop } satisfies LogConnection
    },
    ...(capabilities.restarts && { currentRun: async () => ({ restarts: 0, state: 'running' as const, finished: false }) })
  }

  return {
    logSource,
    previousAsked,
    sinceAsked,
    /** Ends every stream being followed, as when the things logging stop. */
    endStreams() {
      for (const connection of connections) connection.end()
      connections.clear()
    }
  }
}
