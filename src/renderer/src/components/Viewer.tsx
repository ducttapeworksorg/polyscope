import { useEffect, useRef } from 'react'
import { t } from '../i18n'
import { formatCount, formatSize } from '../i18n/format'
import { editorFontFamily, monaco } from '../monaco'
import type { OpenTab } from '../workspace'

interface Props {
  tabs: OpenTab[]
  activeTab: OpenTab | null
  onShowHex(key: string): void
  /** Fetches all of a Log Stream whose whole log is over the Large File threshold, the user having been warned. */
  onShowWholeLog(key: string): void
  /** In bytes, for the warning about a log larger than it. */
  largeFileThreshold: number
}

/** What the editor shows for a tab, or null when it shows a placeholder instead: a binary file, a log too large to show. */
function editorContent({ file, language }: OpenTab) {
  if (file.view === 'binary' || file.view === 'logTooLarge') return null
  if (file.view === 'log') return { text: file.content, language: 'log' }
  return { text: file.content, language: file.view === 'hex' ? 'plaintext' : (language ?? file.language) }
}

interface TabModel {
  model: monaco.editor.ITextModel
  /** The file the model holds; a reload brings a new one. */
  file: OpenTab['file']
  viewState: monaco.editor.ICodeEditorViewState | null
}

/**
 * One read-only Monaco editor; each tab keeps its own model and scroll/cursor state. Binary files, and logs
 * too large to show whole, get a placeholder.
 */
export function Viewer({ tabs, activeTab, onShowHex, onShowWholeLog, largeFileThreshold }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, TabModel>())
  const shownKeyRef = useRef<string | null>(null)

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
      minimap: { enabled: true, renderCharacters: false },
      stickyScroll: { enabled: false },
      model: null
    })
    editorRef.current = editor
    // Monaco measures glyphs once; re-measure after the bundled mono face finishes loading.
    void document.fonts.load(`13px ${editorFontFamily}`).then(() => monaco.editor.remeasureFonts())
    const models = modelsRef.current
    return () => {
      editor.dispose()
      for (const { model } of models.values()) model.dispose()
      models.clear()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current!
    const models = modelsRef.current

    const shown = shownKeyRef.current && models.get(shownKeyRef.current)
    if (shown) shown.viewState = editor.saveViewState()

    const open = new Set(tabs.map((tab) => tab.key))
    for (const [key, entry] of models) {
      if (open.has(key)) continue
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
    if (fresh) {
      // Reloaded or reopened: new content, but the reader stays where they were.
      entry.model.setValue(content.text)
      entry.file = activeTab.file
    }
    if (entry.model.getLanguageId() !== content.language) monaco.editor.setModelLanguage(entry.model, content.language)
    // A log's latest lines are at its end, so that's where it opens, and where new lines take the reader.
    if (activeTab.file.view === 'log' && (fresh || !entry.viewState)) editor.revealLine(entry.model.getLineCount())
    else if (entry.viewState) editor.restoreViewState(entry.viewState)
    shownKeyRef.current = activeTab.key
  }, [tabs, activeTab])

  const binary = activeTab?.file.view === 'binary' ? activeTab.file : null
  const tooLarge = activeTab?.file.view === 'logTooLarge'
  return (
    <>
      <div ref={hostRef} className="viewer__editor" hidden={!activeTab || !!binary || tooLarge} data-testid="editor" />
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
          <p>{t('viewer.binary', { bytes: formatCount(binary.contentLength) })}</p>
          <button type="button" className="button button--quiet" onClick={() => onShowHex(activeTab.key)}>
            {t('viewer.showAsHex')}
          </button>
        </div>
      )}
    </>
  )
}
