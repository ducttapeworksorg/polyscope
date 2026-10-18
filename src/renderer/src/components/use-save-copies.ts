import { useEffect, useRef, useState } from 'react'
import type { CoreResult, SaveCopyStarted, SourceInfo, SourcePath } from '@shared/core-api'
import { core } from '../core-client'
import { logCopyOf } from '../log-copy'
import { dismissSave, noSaveCopies, noteSaveEvent, startSave, type ShownSave } from '../save-copies'
import { tabName, type OpenTab } from '../workspace'

/** How long a save that's done stays shown, in milliseconds; one that failed stays until dismissed. */
const savedShownFor = 6_000

export interface SaveCopiesModel {
  /** The saves shown, oldest first. */
  saves: ShownSave[]
  /** "Save a copy…" of a file: asks where, then saves it there. */
  saveCopy(source: SourceInfo, path: SourcePath, name: string): Promise<void>
  /**
   * "Save a copy…" of a log tab's lines as its view shows them: asks where, suggesting a name that says what the log
   * is of and when, then saves them there one per line.
   */
  saveLogCopy(tab: OpenTab, lines: string[]): Promise<void>
  cancel(saveId: string): void
  dismiss(saveId: string): void
}

/** The copies of files being saved, and saving more: kept current as their SaveCopyEvents come. */
export function useSaveCopies(): SaveCopiesModel {
  const [saves, setSaves] = useState(noSaveCopies)

  useEffect(() => core.onSaveCopyEvent((event) => setSaves((current) => noteSaveEvent(current, event))), [])

  // A save that's done goes a while after it's done, each on its own time; one that failed stays to say why.
  const leaving = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    for (const { saveId, status } of saves.shown) {
      if (status.state !== 'saved' || leaving.current.has(saveId)) continue
      const timer = setTimeout(() => {
        leaving.current.delete(saveId)
        setSaves((current) => dismissSave(current, saveId))
      }, savedShownFor)
      leaving.current.set(saveId, timer)
    }
  }, [saves.shown])
  useEffect(() => () => leaving.current.forEach(clearTimeout), [])

  /** Starts a save through the bridge and shows it, or why it couldn't start; nothing if no place was picked. */
  const showSave = async (name: string, start: () => Promise<CoreResult<SaveCopyStarted | null>>) => {
    let result: CoreResult<SaveCopyStarted | null>
    try {
      result = await start()
    } catch (error) {
      result = { ok: false, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok) {
      const save = result.value
      if (save) setSaves((current) => startSave(current, { ...save, name }))
      return
    }
    // It never started, so has no id of its own: shown as failed, to say why.
    const { code, message } = result
    const saveId = `unstarted-${crypto.randomUUID()}`
    setSaves((current) => noteSaveEvent(startSave(current, { saveId, name, target: '' }), { saveId, state: 'failed', code, message }))
  }

  return {
    saves: saves.shown,
    saveCopy: (source: SourceInfo, path: SourcePath, name: string) => showSave(name, () => window.polyscope.saveCopy(source.id, path)),
    saveLogCopy: (tab: OpenTab, lines: string[]) => {
      const copy = logCopyOf(tab, lines, new Date())
      return copy ? showSave(tabName(tab.file), () => window.polyscope.saveLogCopy(copy.name, copy.text)) : Promise.resolve()
    },
    cancel: (saveId) => void core.cancelSaveCopy(saveId).catch(() => undefined),
    dismiss: (saveId) => setSaves((current) => dismissSave(current, saveId))
  }
}
