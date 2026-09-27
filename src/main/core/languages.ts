import type { LanguageId } from '@shared/core-api'

// Monaco's languages and the names they claim, kept here because the core can't load Monaco.
// 'log' isn't one of Monaco's; the renderer registers it. The picker offers every language
// Monaco has, so this only needs to cover what a name alone can settle.
const byExtension: Record<LanguageId, string[]> = {
  bat: ['bat', 'cmd'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  csharp: ['cs', 'csx', 'cake'],
  css: ['css'],
  dart: ['dart'],
  dockerfile: ['dockerfile'],
  elixir: ['ex', 'exs'],
  fsharp: ['fs', 'fsi', 'fsx', 'fsscript'],
  go: ['go'],
  graphql: ['graphql', 'gql'],
  handlebars: ['handlebars', 'hbs'],
  hcl: ['tf', 'tfvars', 'hcl'],
  html: ['html', 'htm', 'shtml', 'xhtml', 'jsp', 'asp', 'aspx'],
  ini: ['ini', 'properties', 'cfg', 'conf', 'gitconfig', 'env'],
  java: ['java'],
  javascript: ['js', 'es6', 'jsx', 'mjs', 'cjs'],
  json: ['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'har', 'webmanifest'],
  julia: ['jl'],
  kotlin: ['kt', 'kts'],
  less: ['less'],
  liquid: ['liquid', 'html.liquid'],
  log: ['log', 'out', 'err'],
  lua: ['lua'],
  markdown: ['md', 'markdown', 'mdown', 'mkdn', 'mkd'],
  mdx: ['mdx'],
  'objective-c': ['m'],
  pascal: ['pas'],
  perl: ['pl', 'pm'],
  php: ['php', 'phtml'],
  powershell: ['ps1', 'psm1', 'psd1'],
  proto: ['proto'],
  pug: ['pug', 'jade'],
  python: ['py', 'pyw', 'pyi'],
  r: ['r', 'rmd'],
  razor: ['cshtml'],
  restructuredtext: ['rst'],
  ruby: ['rb', 'gemspec', 'rake'],
  rust: ['rs'],
  scala: ['scala', 'sc', 'sbt'],
  scheme: ['scm', 'ss', 'rkt'],
  scss: ['scss'],
  shell: ['sh', 'bash', 'zsh', 'ksh'],
  sql: ['sql'],
  swift: ['swift'],
  tcl: ['tcl'],
  twig: ['twig'],
  typescript: ['ts', 'tsx', 'cts', 'mts'],
  vb: ['vb'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'dtd', 'csproj', 'fsproj', 'vbproj', 'config', 'props', 'targets', 'xaml', 'svg', 'plist', 'resx'],
  yaml: ['yaml', 'yml']
}

const byFileName: Record<string, LanguageId> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitconfig': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell'
}

const extensions = new Map(Object.entries(byExtension).flatMap(([id, exts]) => exts.map((ext) => [ext, id] as const)))

/** Every language the core can detect, for checking them against the editor's. */
export const languageIds: readonly LanguageId[] = [...new Set([...Object.keys(byExtension), ...Object.values(byFileName)])]

/**
 * A file's language: by its whole name, then its longest known extension ('html.liquid' before
 * 'liquid'), ignoring case and the number a rotated file ends in ('app.log.1').
 */
export function languageFor(fileName: string): LanguageId {
  const name = fileName.toLowerCase().replace(/(?<=.)\.\d+$/, '')
  const exact = byFileName[name]
  if (exact) return exact
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const id = extensions.get(name.slice(dot + 1))
    if (id) return id
  }
  return 'plaintext'
}
