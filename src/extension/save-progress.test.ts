import { describe, expect, it } from 'vitest'
import type { SaveCopyEvent } from '@shared/core-api'
import { watchSave } from './save-progress'

/** The core's save events and Cancel, as the extension host has them, told by hand. */
function fakeCore() {
  const listeners = new Set<(event: SaveCopyEvent) => void>()
  const cancelled: string[] = []
  return {
    cancelled,
    tell: (event: SaveCopyEvent) => listeners.forEach((listener) => listener(event)),
    listening: () => listeners.size,
    onSaveCopyEvent(listener: (event: SaveCopyEvent) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async cancelSaveCopy(saveId: string) {
      cancelled.push(saveId)
    }
  }
}

/** A notification as VS Code's progress shows one: what it's told, and its Cancel. */
function fakeNotification() {
  const reports: { increment?: number; message: string }[] = []
  let cancel = () => {}
  return {
    reports,
    clickCancel: () => cancel(),
    report: (update: { increment?: number; message: string }) => void reports.push(update),
    onCancel: (listener: () => void) => void (cancel = listener)
  }
}

describe('a save shown in a notification', () => {
  it('reports how much is saved, as percentages more of it each time, and ends saved', async () => {
    const core = fakeCore()
    const notification = fakeNotification()
    const watching = watchSave(core)

    const ended = watching.follow('s1', notification)
    core.tell({ saveId: 's1', state: 'saving', savedBytes: 0, totalBytes: 4096 })
    core.tell({ saveId: 's1', state: 'saving', savedBytes: 1024, totalBytes: 4096 })
    core.tell({ saveId: 's1', state: 'saving', savedBytes: 4096, totalBytes: 4096 })
    core.tell({ saveId: 's1', state: 'saved', savedBytes: 4096 })

    expect(await ended).toEqual({ state: 'saved', savedBytes: 4096 })
    expect(notification.reports).toEqual([
      { increment: 0, message: '0 B of 4 KB' },
      { increment: 25, message: '1 KB of 4 KB' },
      { increment: 75, message: '4 KB of 4 KB' }
    ])
  })

  it('hears what the save told before it was followed, as one saved at once does', async () => {
    const core = fakeCore()
    const notification = fakeNotification()
    const watching = watchSave(core)

    core.tell({ saveId: 's1', state: 'saving', savedBytes: 0, totalBytes: 10 })
    core.tell({ saveId: 's1', state: 'saved', savedBytes: 10 })

    expect(await watching.follow('s1', notification)).toEqual({ state: 'saved', savedBytes: 10 })
  })

  it('leaves other saves’ events alone', async () => {
    const core = fakeCore()
    const notification = fakeNotification()
    const watching = watchSave(core)

    const ended = watching.follow('s1', notification)
    core.tell({ saveId: 's2', state: 'saving', savedBytes: 5, totalBytes: 10 })
    core.tell({ saveId: 's2', state: 'failed', code: 'UNREACHABLE', message: 'gone' })
    core.tell({ saveId: 's1', state: 'cancelled' })

    expect(await ended).toEqual({ state: 'cancelled' })
    expect(notification.reports).toEqual([])
  })

  it('cancels the save when the notification’s Cancel is clicked, ending as the core says', async () => {
    const core = fakeCore()
    const notification = fakeNotification()
    const watching = watchSave(core)

    const ended = watching.follow('s1', notification)
    notification.clickCancel()
    expect(core.cancelled).toEqual(['s1'])
    core.tell({ saveId: 's1', state: 'cancelled' })

    expect(await ended).toEqual({ state: 'cancelled' })
  })

  it('stops hearing the core once the save ends, or once it never started', async () => {
    const core = fakeCore()
    const watching = watchSave(core)
    const ended = watching.follow('s1', fakeNotification())
    core.tell({ saveId: 's1', state: 'failed', code: 'SAVE_UNWRITABLE', message: 'disk full' })
    await ended
    expect(core.listening()).toBe(0)

    watchSave(core).stop()
    expect(core.listening()).toBe(0)
  })
})
