import { redact } from './redact'

const osNames: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** The OS this runs on, as the report names it, e.g. `Windows 10.0.26200 (x64)` for its `version`. */
export const osDescription = (version: string) => `${osNames[process.platform] ?? process.platform} ${version} (${process.arch})`

interface Diagnostics {
  appVersion: string
  /** e.g. `Windows 10.0.26200 (x64)`. */
  os: string
  /** What this copy runs on, by name, in the order to list them: e.g. Electron's, Chromium's and Node.js's. */
  versions: Record<string, string>
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
    ...Object.entries(versions).map(([name, version]) => `- ${name}: ${version}`),
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
