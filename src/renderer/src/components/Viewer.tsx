import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { LastNLines } from '@shared/core-api'
import type { FollowFeed } from '../follow-feed'
import { t } from '../i18n'
import { formatCount, formatSize } from '../i18n/format'
import { LogEntries, type LevelCounts } from '../log-entries'
import { followLines, shownContent } from '../log-lines'
import { editorFontFamily, monaco } from '../monaco'
import { hiddenLevelsOf, joinLines, largeFileIdsOf, type OpenTab } from '../workspace'
import { LargeFileViewer, type LargeFilePlace } from './LargeFileViewer'

interface Props {
  tabs: OpenTab[]
  activeTab: OpenTab | null
  onShowHex(key: string): void
  /** Fetches all of a Log Stream whose whole log is over the Large File threshold, the user having been warned. */
  onShowWholeLog(key: string): void
  /** In bytes, for the warning about a log larger than it. */
  largeFileThreshold: number
  /** In bytes: a Large File no larger can be opened in the editor anyway. */
  openAnywayLimit: number
  /** Opens a Large File's tab in the editor instead. */
  onOpenAnyway(key: string): void
  /** Saves a copy of the active tab's Large File, asking where; without it, the Large File Viewer offers no "Save a copy…". */
  onSaveCopy?(): void
  /** Where followed logs' new lines come from. */
  followFeed: FollowFeed
  /** Told how many lines a followed log's view holds after new ones are added, by Follow. */
  onLineCount(followId: string, count: number): void
  /** Told, by tab, when a followed log's view drops its first lines to keep within its "Last N lines". */
  onDroppedLines(key: string): void
  /** Whether the editor shows a minimap beside the text. */
  minimap: boolean
  /** Set to a function reading the lines the editor shows for a tab, so its log can be saved as shown. */
  shownLinesRef?: RefObject<ShownLines | null>
  /** Told, by tab, how many Log Entries of each Log Level a log's lines have, as they change. */
  onLevelCounts?(key: string, counts: LevelCounts): void
}

/** The lines a tab's editor holds, as they're shown, by tab; null for a tab it holds none of. */
export type ShownLines = (key: string) => string[] | null

/**
 * What the editor shows for a tab, or null when it shows something else: a binary file, a log too large to show or
 * that couldn't be read, a Large File.
 */
function editorContent({ file, language, utc, loadedEarlier }: OpenTab) {
  if (file.view === 'binary' || file.view === 'logTooLarge' || file.view === 'logFailed' || file.view === 'large') return null
  if (file.view === 'log') return { text: joinLines(earlierShown(loadedEarlier?.content ?? '', file.timestamps, utc ?? false), shownContent(file, utc ?? false)), language: 'log' }
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
  /** The lines read further back the model holds, as they came, above the file's. */
  earlier: string
  /** A log's lines, as shown, in Log Entries: the model holds those its Level Filter shows. None for other text. */
  entries?: LogEntries
  /** The Log Levels the Level Filter hides, as the model shows them. */
  hidden: string
}

/** Lines read further back, as a log view shows them. */
const earlierShown = (content: string, timestamps: boolean, utc: boolean) => shownContent({ content, timestamps }, utc)

/** How many lines a log's text has; none if it's empty. */
const lineCount = (text: string) => (text ? text.split('\n').length : 0)

/** Keeps the last `cap` of `lines`. */
const capped = (lines: string[], cap: LastNLines) => (cap === 'all' || lines.length <= cap ? lines : lines.slice(-cap))

/**
 * How the editor numbers a tab's lines: a log's as they are in it, those its Level Filter hides counted too, with
 * room for the largest.
 */
function numbering(entry: TabModel): monaco.editor.IEditorOptions {
  if (!entry.entries) return { lineNumbers: 'on', lineNumbersMinChars: 5 }
  return { lineNumbers: (line) => String(entry.entries?.numberOf(line) ?? line), lineNumbersMinChars: Math.max(5, String(entry.entries.length).length) }
}

/** A text's lines; none if it's empty. */
const linesOf = (text: string) => (text ? text.split('\n') : [])

/** A tab's Log Entries, for a text highlighted as a log; none for other text. */
const entriesOf = (text: string, language: string, tab: OpenTab) =>
  language === 'log' ? new LogEntries(linesOf(text), hiddenLevelsOf(tab)) : undefined

/** The Log Levels a tab's Level Filter hides, to tell when they change. */
const hiddenKeyOf = (tab: OpenTab) => hiddenLevelsOf(tab).join()

/**
 * Adds lines to the end of a log, and those its Level Filter shows to its model, then drops its first lines past
 * `cap`, and those shown from its model; how many it dropped.
 */
function appendLines(model: monaco.editor.ITextModel, entries: LogEntries, lines: string[], cap: LastNLines) {
  const shownBefore = entries.shownCount
  const shown = entries.append(lines)
  if (shown.length > 0) {
    const last = model.getLineCount()
    const end = model.getLineMaxColumn(last)
    model.applyEdits([{ range: new monaco.Range(last, end, last, end), text: (shownBefore === 0 ? '' : '\n') + shown.join('\n') }])
  }
  const excess = cap === 'all' ? 0 : entries.length - cap
  const shownDropped = excess > 0 ? entries.dropFirst(excess) : 0
  if (shownDropped > 0) model.applyEdits([{ range: new monaco.Range(1, 1, shownDropped + 1, 1), text: null }])
  return Math.max(0, excess)
}

/**
 * One read-only Monaco editor; each tab keeps its own model and scroll/cursor state. Binary files, logs
 * too large to show whole, and logs that couldn't be read get a placeholder.
 */
export function Viewer({ tabs, activeTab, onShowHex, onShowWholeLog, largeFileThreshold, openAnywayLimit, onOpenAnyway, onSaveCopy, followFeed, onLineCount, onDroppedLines, minimap, shownLinesRef, onLevelCounts }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, TabModel>())
  const shownKeyRef = useRef<string | null>(null)
  // Where each Large File's view was left, by Large File, so switching tabs comes back to it.
  const largeFilePlaces = useRef(new Map<string, LargeFilePlace>())
  const keepPlace = useCallback((largeFileId: string, place: LargeFilePlace) => void largeFilePlaces.current.set(largeFileId, place), [])
  // The tabs whose Log Level counts are to be told, once per frame however many lines come.
  const countsDue = useRef(new Set<string>())
  const tellCounts = (key: string) => {
    if (!onLevelCounts) return
    const due = countsDue.current
    if (!due.size) {
      requestAnimationFrame(() => {
        for (const tabKey of countsDue.current) {
          const entries = modelsRef.current.get(tabKey)?.entries
          if (entries) onLevelCounts(tabKey, entries.counts)
        }
        countsDue.current.clear()
      })
    }
    due.add(key)
  }

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
    if (shownLinesRef) {
      shownLinesRef.current = (key) => {
        const model = models.get(key)?.model
        return model && !model.isDisposed() ? model.getLinesContent() : null
      }
    }
    return () => {
      if (shownLinesRef) shownLinesRef.current = null
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

    const hidden = hiddenKeyOf(activeTab)
    let entry = models.get(activeTab.key)
    if (!entry) {
      const { source, file } = activeTab
      const uri = monaco.Uri.from({ scheme: 'polyscope', authority: source.id, path: `/${file.path}` })
      const entries = entriesOf(content.text, content.language, activeTab)
      const text = entries ? entries.shown.join('\n') : content.text
      entry = { model: monaco.editor.createModel(text, content.language, uri), file, viewState: null, earlier: activeTab.loadedEarlier?.content ?? '', entries, hidden }
      models.set(activeTab.key, entry)
    }
    editor.setModel(entry.model)
    // Shows the lines of the log the model holds, as its Log Entries now are.
    const showEntries = (entries: LogEntries | undefined, text: string) => {
      entry.entries = entries
      entry.hidden = hidden
      entry.model.setValue(entries ? entries.shown.join('\n') : text)
    }
    const fresh = entry.file !== activeTab.file
    const { file } = activeTab
    const utc = activeTab.utc ?? false
    const earlier = activeTab.loadedEarlier?.content ?? ''
    if (fresh) {
      // Reloaded or reopened: new content, but the reader stays where they were.
      showEntries(entriesOf(content.text, content.language, activeTab), content.text)
      entry.file = file
      entry.earlier = earlier
      const lines = joinLines(earlier, file.view === 'log' ? file.content : '')
      entry.timestamped = file.view === 'log' && file.timestamps ? { lines: lines ? lines.split('\n') : [], utc } : undefined
    } else if (file.view === 'log' && earlier !== entry.earlier) {
      // Lines read further back go above those it holds, which may have had a Follow's added; the reader stays put.
      const added = earlier.slice(0, earlier.length - entry.earlier.length).replace(/\n$/, '')
      entry.earlier = earlier
      if (added && entry.entries) {
        if (entry.timestamped) entry.timestamped.lines = [...added.split('\n'), ...entry.timestamped.lines]
        if (entry.viewState) editor.restoreViewState(entry.viewState)
        const scrollTop = editor.getScrollTop()
        // Their last Log Entry may take in the first lines shown, hiding them.
        const { added: shown, removed } = entry.entries.prepend(earlierShown(added, file.timestamps, entry.timestamped?.utc ?? utc).split('\n'))
        const below = shown.length > 0 && entry.entries.shownCount > shown.length ? '\n' : ''
        const range = removed > 0 ? new monaco.Range(1, 1, removed + 1, 1) : new monaco.Range(1, 1, 1, 1)
        entry.model.applyEdits([{ range, text: shown.join('\n') + below }])
        editor.setScrollTop(scrollTop + (shown.length - removed) * editor.getOption(monaco.editor.EditorOption.lineHeight))
        entry.viewState = editor.saveViewState()
      }
    } else if (entry.timestamped && entry.timestamped.utc !== utc) {
      // The same lines, in the other time.
      entry.timestamped.utc = utc
      const text = shownContent({ content: entry.timestamped.lines.join('\n'), timestamps: true }, utc)
      showEntries(entriesOf(text, content.language, activeTab), text)
    } else if ((content.language === 'log') !== Boolean(entry.entries)) {
      // A file highlighted as a log, or no longer: only a log's lines are in Log Entries for its Level Filter.
      showEntries(entriesOf(content.text, content.language, activeTab), content.text)
    }
    if (entry.entries && entry.hidden !== hidden) {
      // The Level Filter changed: the reader stays at the line they were reading, or the first shown after it.
      const { entries } = entry
      const atEnd = (editor.getVisibleRanges().at(-1)?.endLineNumber ?? 0) >= entry.model.getLineCount()
      const reading = entries.numberOf(editor.getVisibleRanges()[0]?.startLineNumber ?? 1)
      entries.filter(hiddenLevelsOf(activeTab))
      showEntries(entries, content.text)
      const line = entries.lineAt(reading)
      if (atEnd) editor.revealLine(entry.model.getLineCount())
      else if (line) editor.setScrollTop(editor.getTopForLineNumber(line))
      entry.viewState = editor.saveViewState()
    }
    editor.updateOptions(numbering(entry))
    tellCounts(activeTab.key)
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
    // Lines read further back are kept on top of its "Last N lines".
    const cap = (): LastNLines => (lastNLines === 'all' ? 'all' : lastNLines + lineCount(entry.earlier))
    entry.detach = followFeed.attach(followId, (update) => {
      const editor = editorRef.current
      const { model, timestamped, entries } = entry
      if (model.isDisposed() || !entries) return
      // A reader at the end is kept there as lines come; one who has scrolled up is left in peace.
      const shown = editor?.getModel() === model
      const atEnd = shown && (editor.getVisibleRanges().at(-1)?.endLineNumber ?? 0) >= model.getLineCount()
      if (timestamped) timestamped.lines = capped([...timestamped.lines, ...followLines(update, { timestamps: false, utc: false, of: file.of, sourceType: tab.source.type })], cap())
      const dropped = appendLines(model, entries, followLines(update, { timestamps: file.timestamps, utc: timestamped?.utc ?? false, of: file.of, sourceType: tab.source.type }), cap())
      if (dropped) onDroppedLines(tab.key)
      if (atEnd) editor.revealLine(model.getLineCount())
      if (shown) editor.updateOptions(numbering(entry))
      onLineCount(followId, entries.length)
      tellCounts(tab.key)
    })
  }

  const binary = activeTab?.file.view === 'binary' ? activeTab.file : null
  const tooLarge = activeTab?.file.view === 'logTooLarge'
  const failed = activeTab?.file.view === 'logFailed' ? activeTab.file : null
  const large = activeTab?.file.view === 'large' ? activeTab.file : null
  return (
    <>
      <div ref={hostRef} className="viewer__editor" hidden={!activeTab || !!binary || tooLarge || !!failed || !!large} data-testid="editor" />
      {large && (
        <LargeFileViewer
          key={large.largeFileId}
          file={large}
          place={largeFilePlaces.current.get(large.largeFileId)}
          onPlace={(place) => keepPlace(large.largeFileId, place)}
          openAnywayLimit={openAnywayLimit}
          onOpenAnyway={() => activeTab && onOpenAnyway(activeTab.key)}
          {...(onSaveCopy && { onSaveCopy })}
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
      {failed && (
        <div className="viewer__empty viewer__binary" role="alert">
          <p>{failed.message}</p>
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
