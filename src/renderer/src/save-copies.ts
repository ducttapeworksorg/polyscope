import type { SaveCopyEvent, SaveCopyStatus } from '@shared/core-api'

/** A save of a copy of a file, shown at the foot of the workbench while it goes on and once it's done. */
export interface ShownSave {
  saveId: string
  /** The file's name. */
  name: string
  /** Where the copy goes on this computer. */
  target: string
  status: SaveCopyStatus
}

/** The saves shown, oldest first, and how saves not yet known to have started are going, by id. */
export interface SaveCopies {
  shown: ShownSave[]
  /** A save's events can come before the reply saying it started: they wait here until it does. */
  early: Record<string, SaveCopyStatus>
}

export const noSaveCopies: SaveCopies = { shown: [], early: {} }

const statusOf = ({ saveId: _, ...status }: SaveCopyEvent): SaveCopyStatus => status

/** Shows a save that started, as it's going already if its events came first; one cancelled already isn't shown. */
export function startSave(saves: SaveCopies, save: Omit<ShownSave, 'status'>): SaveCopies {
  const starting: SaveCopyStatus = { state: 'saving', savedBytes: 0, totalBytes: 0 }
  const { [save.saveId]: status = starting, ...early } = saves.early
  if (status.state === 'cancelled') return { ...saves, early }
  return { shown: [...saves.shown, { ...save, status }], early }
}

/** Notes how a save is going: a cancelled one is no longer shown, and one that's done stays as it ended. */
export function noteSaveEvent(saves: SaveCopies, event: SaveCopyEvent): SaveCopies {
  const shown = saves.shown.find((s) => s.saveId === event.saveId)
  if (!shown) return { ...saves, early: { ...saves.early, [event.saveId]: statusOf(event) } }
  if (shown.status.state !== 'saving') return saves
  if (event.state === 'cancelled') return dismissSave(saves, event.saveId)
  return { ...saves, shown: saves.shown.map((s) => (s === shown ? { ...s, status: statusOf(event) } : s)) }
}

/** Stops showing a save. */
export const dismissSave = (saves: SaveCopies, saveId: string): SaveCopies => ({ ...saves, shown: saves.shown.filter((s) => s.saveId !== saveId) })
