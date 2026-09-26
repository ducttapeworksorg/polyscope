import { useEffect, useRef } from 'react'
import { editorFontFamily, languageFor, monaco } from '../monaco'
import type { OpenTab } from '../workspace'

interface Props {
  tabs: OpenTab[]
  activeTab: OpenTab | null
}

interface TabModel {
  model: monaco.editor.ITextModel
  /** The file the model holds; a reload brings a new one. */
  file: OpenTab['file']
  viewState: monaco.editor.ICodeEditorViewState | null
}

/** One read-only Monaco editor; each tab keeps its own model and scroll/cursor state. */
export function Viewer({ tabs, activeTab }: Props) {
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

    if (!activeTab) {
      editor.setModel(null)
      shownKeyRef.current = null
      return
    }

    let entry = models.get(activeTab.key)
    if (!entry) {
      const { source, file } = activeTab
      const uri = monaco.Uri.from({ scheme: 'polyscope', authority: source.id, path: `/${file.path}` })
      entry = { model: monaco.editor.createModel(file.content, languageFor(file.name).id, uri), file, viewState: null }
      models.set(activeTab.key, entry)
    }
    editor.setModel(entry.model)
    if (entry.file !== activeTab.file) {
      // Reloaded: new content, but the reader stays where they were.
      entry.model.setValue(activeTab.file.content)
      entry.file = activeTab.file
    }
    if (entry.viewState) editor.restoreViewState(entry.viewState)
    shownKeyRef.current = activeTab.key
  }, [tabs, activeTab])

  return <div ref={hostRef} className="viewer__editor" hidden={!activeTab} data-testid="editor" />
}
