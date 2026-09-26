import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// Mirrors the slate tokens in styles/app.css so the editor well is continuous with the chrome.
monaco.editor.defineTheme('polyscope-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1b2230',
    'editor.foreground': '#d5dce8',
    'editorLineNumber.foreground': '#4d5a70',
    'editorLineNumber.activeForeground': '#aab4c6',
    'editor.lineHighlightBackground': '#222a3a',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#3b4b68',
    'editor.inactiveSelectionBackground': '#303c52',
    'editorCursor.foreground': '#eef2f8',
    'editorIndentGuide.background1': '#2a3345',
    'editorWidget.background': '#212a3a',
    'editorWidget.border': '#323d52',
    'minimap.background': '#1b2230',
    'scrollbarSlider.background': '#8391a833',
    'scrollbarSlider.hoverBackground': '#8391a855',
    'scrollbarSlider.activeBackground': '#8391a877'
  }
})

export const editorFontFamily = "'Red Hat Mono Variable', ui-monospace, monospace"

export { monaco }
