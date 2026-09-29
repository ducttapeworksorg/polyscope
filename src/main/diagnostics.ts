import { redact } from './redact'

interface Diagnostics {
  appVersion: string
  /** e.g. `Windows 10.0.26200 (x64)`. */
  os: string
  versions: { electron: string; chrome: string; node: string }
  /** Replaced by `~` in the log, keeping the user's name out. */
  homeDir: string
  /** The recent app log, as written. */
  log: string
}

/**
 * The report "Copy diagnostics" puts on the clipboard: Markdown for a GitHub issue, with the log folded away and
 * redacted once more (it was redacted when written, but this also hides the home directory, and catches anything
 * a newer rule knows about).
 */
export function formatDiagnostics({ appVersion, os, versions, homeDir, log }: Diagnostics): string {
  const redactedLog = redact(log, { homeDir }).trimEnd()
  return [
    '### Polyscope diagnostics',
    '',
    `- Polyscope: ${appVersion}`,
    `- OS: ${os}`,
    `- Electron: ${versions.electron}`,
    `- Chromium: ${versions.chrome}`,
    `- Node.js: ${versions.node}`,
    '',
    '<details><summary>Recent app log</summary>',
    '',
    '```',
    redactedLog || '(empty)',
    '```',
    '',
    '</details>',
    ''
  ].join('\n')
}
