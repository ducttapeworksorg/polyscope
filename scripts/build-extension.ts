// Builds the Extension Copy (ADR 0005) into extension/dist: the extension host's bundle and its webviews'.
// `--tests` also builds the VS Code integration tests, into extension/test-dist; `--package` then packages extension/
// as extension/polyscope-<version>.vsix. Neither lands where the desktop app's build or packaging would pick it up.

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build, type InlineConfig } from 'vite'

const root = resolve(import.meta.dirname, '..')
const extensionDir = join(root, 'extension')
const alias = { '@shared': join(root, 'src/shared') }
const options = new Set(process.argv.slice(2))

/** A Node bundle with everything in it, as the manifest has no dependencies to install; VS Code provides `vscode`. */
const nodeBundle = (entry: string, outDir: string, fileName: string): InlineConfig => ({
  configFile: false,
  root,
  resolve: { alias },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: entry,
    outDir,
    target: 'node20',
    rollupOptions: {
      // Besides `vscode`, the optional native add-ons of `ws` (used by @kubernetes/client-node), as in the app build:
      // `ws` requires them inside try/catch and falls back when they're absent; bundling turns that into a throw.
      external: ['vscode', 'bufferutil', 'utf-8-validate'],
      output: { format: 'cjs', entryFileNames: fileName }
    }
  }
})

await build(nodeBundle('src/extension/extension.ts', join(extensionDir, 'dist'), 'extension.js'))

// The sidebar's and the viewer tabs' pages, each as one script with a fixed name, sharing one stylesheet; the rest is
// found from them.
await build({
  configFile: false,
  root,
  base: './',
  plugins: [react()],
  resolve: { alias },
  build: {
    outDir: join(extensionDir, 'dist', 'webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: { sidebar: join(root, 'src/renderer/extension/sidebar.tsx'), viewer: join(root, 'src/renderer/extension/viewer.tsx') },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? 'webview.css' : 'assets/[name]-[hash][extname]')
      }
    }
  }
})

if (options.has('--tests')) await build(nodeBundle('tests/extension/suite.ts', join(extensionDir, 'test-dist'), 'suite.js'))

if (options.has('--package')) {
  // In lockstep with the desktop app, whatever the manifest says.
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  // Shared with the desktop app, so copied in rather than kept twice.
  const copies = { LICENSE: 'LICENSE', 'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md', 'build/icon.png': 'icon.png' }
  for (const [from, to] of Object.entries(copies)) copyFileSync(join(root, from), join(extensionDir, to))
  const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce')
  const out = join(extensionDir, `polyscope-${version}.vsix`)
  execFileSync(process.execPath, [vsce, 'package', version, '--no-update-package-json', '--no-git-tag-version', '--no-dependencies', '--out', out], {
    cwd: extensionDir,
    stdio: 'inherit'
  })
}
