import { useEffect, useRef, useState } from 'react'
import type { SourceInfo, SourcePath } from '@shared/core-api'
import { core } from '../core-client'
import { dismissSave, noSaveCopies, noteSaveEvent, startSave, type ShownSave } from '../save-copies'

/** How long a save that's done stays shown, in milliseconds; one that failed stays until dismissed. */
const savedShownFor = 6_000

export interface SaveCopiesModel {
  /** The saves shown, oldest first. */
  saves: ShownSave[]
  /** "Save a copy…" of a file, or undefined where files can't be saved: asks where, then saves it there. */
  saveCopy?(source: SourceInfo, path: SourcePath, name: string): Promise<void>
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

  const bridgeSave = window.polyscope.saveCopy
  const saveCopy =
    bridgeSave &&
    (async (source: SourceInfo, path: SourcePath, name: string) => {
      let result: Awaited<ReturnType<typeof bridgeSave>>
      try {
        result = await bridgeSave(source.id, path)
      } catch (error) {
        result = { ok: false, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok) {
        const started = result.value
        if (started) setSaves((current) => startSave(current, { ...started, name }))
        return
      }
      // It never started, so has no id of its own: shown as failed, to say why.
      const { code, message } = result
      const saveId = `unstarted-${crypto.randomUUID()}`
      setSaves((current) => noteSaveEvent(startSave(current, { saveId, name, target: '' }), { saveId, state: 'failed', code, message }))
    })

  return {
    saves: saves.shown,
    ...(saveCopy && { saveCopy }),
    cancel: (saveId) => void core.cancelSaveCopy(saveId).catch(() => undefined),
    dismiss: (saveId) => setSaves((current) => dismissSave(current, saveId))
  }
}
