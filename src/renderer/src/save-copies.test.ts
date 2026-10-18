import { describe, expect, it } from 'vitest'
import { dismissSave, noteSaveEvent, startSave, type SaveCopies } from './save-copies'

const none: SaveCopies = { shown: [], early: {} }
const started = (saves: SaveCopies, saveId = 's1') => startSave(saves, { saveId, name: 'app.log', target: '/home/me/app.log' })

describe('saves of copies', () => {
  it('shows a save as it starts, then how it goes', () => {
    let saves = started(none)
    expect(saves.shown).toEqual([{ saveId: 's1', name: 'app.log', target: '/home/me/app.log', status: { state: 'saving', savedBytes: 0, totalBytes: 0 } }])

    saves = noteSaveEvent(saves, { saveId: 's1', state: 'saving', savedBytes: 5, totalBytes: 10 })
    expect(saves.shown[0]?.status).toEqual({ state: 'saving', savedBytes: 5, totalBytes: 10 })

    saves = noteSaveEvent(saves, { saveId: 's1', state: 'saved', savedBytes: 10 })
    expect(saves.shown[0]?.status).toEqual({ state: 'saved', savedBytes: 10 })
  })

  it('keeps what comes of a save before it’s known to have started, showing it once it is', () => {
    let saves = noteSaveEvent(none, { saveId: 's1', state: 'saved', savedBytes: 3 })
    expect(saves.shown).toEqual([])

    saves = started(saves)
    expect(saves.shown[0]?.status).toEqual({ state: 'saved', savedBytes: 3 })
    expect(saves.early).toEqual({})
  })

  it('stops showing a save once it’s cancelled', () => {
    let saves = started(started(none, 's2'))
    saves = noteSaveEvent(saves, { saveId: 's1', state: 'cancelled' })
    expect(saves.shown.map((s) => s.saveId)).toEqual(['s2'])
  })

  it('stops showing a cancelled save that hadn’t been known to start', () => {
    const saves = started(noteSaveEvent(none, { saveId: 's1', state: 'cancelled' }))
    expect(saves.shown).toEqual([])
  })

  it('ignores progress that comes after a save is done', () => {
    let saves = noteSaveEvent(started(none), { saveId: 's1', state: 'failed', code: 'UNREACHABLE', message: 'Dropped' })
    saves = noteSaveEvent(saves, { saveId: 's1', state: 'saving', savedBytes: 5, totalBytes: 10 })
    expect(saves.shown[0]?.status).toMatchObject({ state: 'failed' })
  })

  it('stops showing a dismissed save', () => {
    expect(dismissSave(started(none), 's1').shown).toEqual([])
  })
})
