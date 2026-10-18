import type { CoreApi, CoreEvents, SaveCopyEvent, SaveCopyStatus } from '@shared/core-api'
import { t } from '../renderer/src/i18n'
import { formatSize } from '../renderer/src/i18n/format'

/** How a save of a copy ended. */
export type SaveEnded = Exclude<SaveCopyStatus, { state: 'saving' }>

/** A notification showing a save, as VS Code's progress notifications are. */
export interface SaveNotification {
  /** Tells how much is saved: `increment` is how much more of it, in percent, since last told. */
  report(update: { increment?: number; message: string }): void
  /** Hears its Cancel clicked. */
  onCancel(listener: () => void): void
}

/**
 * Watches for a save of a copy about to start, hearing the core's save events from now on so none of its own is
 * missed while it starts. Follow it once it has its id, or stop if it never started.
 */
export function watchSave(core: Pick<CoreEvents, 'onSaveCopyEvent'> & Pick<CoreApi, 'cancelSaveCopy'>) {
  const heard: SaveCopyEvent[] = []
  let hear: (event: SaveCopyEvent) => void = (event) => void heard.push(event)
  const stop = core.onSaveCopyEvent((event) => hear(event))

  return {
    /** Shows save `saveId` in `notification`, its Cancel cancelling it, until it ends; resolves to how. */
    follow(saveId: string, notification: SaveNotification): Promise<SaveEnded> {
      notification.onCancel(() => void core.cancelSaveCopy(saveId).catch(() => undefined))
      let percent = 0
      return new Promise((resolve) => {
        hear = ({ saveId: id, ...status }) => {
          if (id !== saveId) return
          if (status.state !== 'saving') {
            stop()
            return resolve(status)
          }
          const { savedBytes, totalBytes } = status
          const message = t('saveCopy.progress', { saved: formatSize(savedBytes), total: formatSize(totalBytes) })
          // Its size unknown, it can't be told how far along it is.
          if (totalBytes <= 0) return notification.report({ message })
          const now = Math.min(100, (savedBytes / totalBytes) * 100)
          notification.report({ increment: now - percent, message })
          percent = now
        }
        heard.splice(0).forEach(hear)
      })
    },
    /** Stops watching, as the save never started. */
    stop
  }
}
