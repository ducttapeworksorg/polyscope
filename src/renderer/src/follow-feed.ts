import type { FollowEvent, FollowUpdate } from '@shared/core-api'

/** Where a Follow's updates go: the log view showing it. */
export type FollowSink = (update: FollowUpdate) => void

export interface FollowFeed {
  /** Sends a Follow's updates to `sink`, those that came before it first; returns a function that detaches it. */
  attach(followId: string, sink: FollowSink): () => void
  /** Drops a Follow's updates, sent or waiting, for good. */
  forget(followId: string): void
}

/** The most updates kept for a Follow no view has attached to yet. */
const maxWaiting = 1_000

/**
 * Hands each Follow's updates to the log view showing it. Updates can arrive before the view has its
 * snapshot (the core starts following straight away), so those wait until it attaches.
 */
export function createFollowFeed(subscribe: (listener: (event: FollowEvent) => void) => () => void): FollowFeed {
  const sinks = new Map<string, FollowSink>()
  const waiting = new Map<string, FollowUpdate[]>()
  const forgotten = new Set<string>()

  subscribe(({ followId, ...update }) => {
    if (forgotten.has(followId)) return
    const sink = sinks.get(followId)
    if (sink) return sink(update)
    const queue = waiting.get(followId) ?? []
    queue.push(update)
    // A view slow to attach gets the latest; it keeps only its last lines anyway.
    if (queue.length > maxWaiting) queue.shift()
    waiting.set(followId, queue)
  })

  return {
    attach(followId, sink) {
      sinks.set(followId, sink)
      const queued = waiting.get(followId) ?? []
      waiting.delete(followId)
      for (const update of queued) sink(update)
      return () => {
        if (sinks.get(followId) === sink) sinks.delete(followId)
      }
    },
    forget(followId) {
      forgotten.add(followId)
      sinks.delete(followId)
      waiting.delete(followId)
    }
  }
}
