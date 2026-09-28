import { useCallback, useEffect, useRef } from 'react'
import type { LastNLines } from '@shared/core-api'
import type { FollowFeed } from '../follow-feed'
import { t } from '../i18n'
import { formatCount, formatSize } from '../i18n/format'
import { followLines, shownContent } from '../log-lines'
import { editorFontFamily, monaco } from '../monaco'
import { largeFileIdsOf, type OpenTab } from '../workspace'
import { LargeFileViewer, type LargeFilePlace } from './LargeFileViewer'

interface Props {
  tabs: OpenTab[]
  activeTab: OpenTab | null
  onShowHex(key: string): void
  /** Fetches all of a Log Stream whose whole log is over the Large File threshold, the user having been warned. */
  onShowWholeLog(key: string): void
  /** In bytes, for the warning about a log larger than it. */
  largeFileThreshold: number
  /** Where followed logs' new lines come from. */
  followFeed: FollowFeed
  /** Told how many lines a followed log's view holds after new ones are added, by Follow. */
  onLineCount(followId: string, count: number): void
  /** Whether the editor shows a minimap beside the text. */
  minimap: boolean
}

/** What the editor shows for a tab, or null when it shows something else: a binary file, a log too large to show, a Large File. */
function editorContent({ file, language, utc }: OpenTab) {
  if (file.view === 'binary' || file.view === 'logTooLarge' || file.view === 'large') return null
  if (file.view === 'log') return { text: shownContent(file, utc ?? false), language: 'log' }
  return { text: file.content, language: file.view === 'hex' ? 'plaintext' : (language ?? file.language) }
}

interface TabModel {
  model: monaco.editor.ITextModel
  /** The file the model holds; a reload brings a new one. */
  file: OpenTab['file']
  viewState: monaco.editor.ICodeEditorViewState | null
  /** Stops adding a Follow's lines to the model, if it's following one. */
  detach?: () => void
  /**
   * A log with timestamps: its lines as they came, marks included, capped like the model, so they can be
   * shown again in the other time without fetching them again; and whether they're shown in UTC.
   */
  timestamped?: { lines: string[]; utc: boolean }
}

/** Keeps the last `cap` of `lines`. */
const capped = (lines: string[], cap: LastNLines) => (cap === 'all' || lines.length <= cap ? lines : lines.slice(-cap))

/** Adds lines to the end of a log's model, then drops its first lines past `cap`. */
function appendLines(model: monaco.editor.ITextModel, lines: string[], cap: LastNLines) {
  const last = model.getLineCount()
  const end = model.getLineMaxColumn(last)
  const text = (model.getValueLength() === 0 ? '' : '\n') + lines.join('\n')
  model.applyEdits([{ range: new monaco.Range(last, end, last, end), text }])
  const excess = cap === 'all' ? 0 : model.getLineCount() - cap
  if (excess > 0) model.applyEdits([{ range: new monaco.Range(1, 1, excess + 1, 1), text: null }])
}

/**
 * One read-only Monaco editor; each tab keeps its own model and scroll/cursor state. Binary files, and logs
 * too large to show whole, get a placeholder.
 */
export function Viewer({ tabs, activeTab, onShowHex, onShowWholeLog, largeFileThreshold, followFeed, onLineCount, minimap }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, TabModel>())
  const shownKeyRef = useRef<string | null>(null)
  // Where each Large File's view was left, by Large File, so switching tabs comes back to it.
  const largeFilePlaces = useRef(new Map<string, LargeFilePlace>())
  const keepPlace = useCallback((largeFileId: string, place: LargeFilePlace) => void largeFilePlaces.current.set(largeFileId, place), [])

  useEffect(() => {
    const editor = monaco.editor.create(hostRef.current!, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      fontFamily: editorFontFamily,
      fontSize: 13,
      lineHeight: 21,
      padding: { top: 10 },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      minimap: { enabled: minimap, renderCharacters: false },
      stickyScroll: { enabled: false },
      model: null
    })
    editorRef.current = editor
    // Monaco measures glyphs once; re-measure after the bundled mono face finishes loading.
    void document.fonts.load(`13px ${editorFontFamily}`).then(() => monaco.editor.remeasureFonts())
    const models = modelsRef.current
    return () => {
      editor.dispose()
      for (const { model, detach } of models.values()) {
        detach?.()
        model.dispose()
      }
      models.clear()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    editorRef.current!.updateOptions({ minimap: { enabled: minimap } })
  }, [minimap])

  useEffect(() => {
    const editor = editorRef.current!
    const models = modelsRef.current

    const shown = shownKeyRef.current && models.get(shownKeyRef.current)
    if (shown) shown.viewState = editor.saveViewState()

    const open = new Set(tabs.map((tab) => tab.key))
    const openLarge = largeFileIdsOf({ tabs, activeKey: null })
    for (const largeFileId of largeFilePlaces.current.keys()) if (!openLarge.has(largeFileId)) largeFilePlaces.current.delete(largeFileId)
    for (const [key, entry] of models) {
      if (open.has(key)) continue
      entry.detach?.()
      entry.model.dispose()
      models.delete(key)
    }

    const content = activeTab && editorContent(activeTab)
    if (!activeTab || !content) {
      editor.setModel(null)
      shownKeyRef.current = null
      // A tab reopened as binary drops the text it was showing.
      const stale = activeTab && models.get(activeTab.key)
      if (stale) {
        stale.detach?.()
        stale.model.dispose()
        models.delete(activeTab.key)
      }
      return
    }

    let entry = models.get(activeTab.key)
    if (!entry) {
      const { source, file } = activeTab
      const uri = monaco.Uri.from({ scheme: 'polyscope', authority: source.id, path: `/${file.path}` })
      entry = { model: monaco.editor.createModel(content.text, content.language, uri), file, viewState: null }
      models.set(activeTab.key, entry)
    }
    editor.setModel(entry.model)
    const fresh = entry.file !== activeTab.file
    const { file } = activeTab
    const utc = activeTab.utc ?? false
    if (fresh) {
      // Reloaded or reopened: new content, but the reader stays where they were.
      entry.model.setValue(content.text)
      entry.file = file
      entry.timestamped = file.view === 'log' && file.timestamps ? { lines: file.content ? file.content.split('\n') : [], utc } : undefined
    } else if (entry.timestamped && entry.timestamped.utc !== utc) {
      // The same lines, in the other time.
      entry.timestamped.utc = utc
      entry.model.setValue(shownContent({ content: entry.timestamped.lines.join('\n'), timestamps: true }, utc))
    }
    if (fresh || !entry.detach) followInto(entry, activeTab)
    // Hex dumps never wrap: their columns would break.
    const wraps = (activeTab.file.view === 'log' || activeTab.file.view === 'editor') && activeTab.wrap
    editor.updateOptions({ wordWrap: wraps ? 'on' : 'off' })
    if (entry.model.getLanguageId() !== content.language) monaco.editor.setModelLanguage(entry.model, content.language)
    // A log's latest lines are at its end, so that's where it opens, and where new lines take the reader.
    if (activeTab.file.view === 'log' && (fresh || !entry.viewState)) editor.revealLine(entry.model.getLineCount())
    else if (entry.viewState) editor.restoreViewState(entry.viewState)
    shownKeyRef.current = activeTab.key
  }, [tabs, activeTab])

  /** Adds the lines of the Follow a tab's content came with, if any, to its model as they come. */
  const followInto = (entry: TabModel, tab: OpenTab) => {
    entry.detach?.()
    entry.detach = undefined
    const { file } = tab
    if (file.view !== 'log' || !('followId' in file)) return
    const { followId, lastNLines } = file
    entry.detach = followFeed.attach(followId, (update) => {
      const editor = editorRef.current
      const { model, timestamped } = entry
      if (model.isDisposed()) return
      // A reader at the end is kept there as lines come; one who has scrolled up is left in peace.
      const shown = editor?.getModel() === model
      const atEnd = shown && (editor.getVisibleRanges().at(-1)?.endLineNumber ?? 0) >= model.getLineCount()
      if (timestamped) timestamped.lines = capped([...timestamped.lines, ...followLines(update, { timestamps: false, utc: false, of: file.of })], lastNLines)
      appendLines(model, followLines(update, { timestamps: file.timestamps, utc: timestamped?.utc ?? false, of: file.of }), lastNLines)
      if (atEnd) editor.revealLine(model.getLineCount())
      onLineCount(followId, model.getLineCount())
    })
  }

  const binary = activeTab?.file.view === 'binary' ? activeTab.file : null
  const tooLarge = activeTab?.file.view === 'logTooLarge'
  const large = activeTab?.file.view === 'large' ? activeTab.file : null
  return (
    <>
      <div ref={hostRef} className="viewer__editor" hidden={!activeTab || !!binary || tooLarge || !!large} data-testid="editor" />
      {large && (
        <LargeFileViewer
          key={large.largeFileId}
          file={large}
          place={largeFilePlaces.current.get(large.largeFileId)}
          onPlace={(place) => keepPlace(large.largeFileId, place)}
        />
      )}
      {activeTab && tooLarge && (
        <div className="viewer__empty viewer__binary" role="alert">
          <p>{t('logView.tooLarge', { size: formatSize(largeFileThreshold) })}</p>
          <button type="button" className="button button--quiet" onClick={() => onShowWholeLog(activeTab.key)}>
            {t('logView.showAll')}
          </button>
        </div>
      )}
      {activeTab && binary && (
        <div className="viewer__empty viewer__binary">
          <p>
            {binary.contentLength === undefined
              ? t('viewer.binaryCompressed', { size: formatSize(binary.size) })
              : t('viewer.binary', { bytes: formatCount(binary.contentLength) })}
          </p>
          <button type="button" className="button button--quiet" onClick={() => onShowHex(activeTab.key)}>
            {t('viewer.showAsHex')}
          </button>
        </div>
      )}
    </>
  )
}
