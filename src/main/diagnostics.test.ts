import { describe, expect, it } from 'vitest'
import { formatDiagnostics } from './diagnostics'

const environment = {
  appVersion: '0.1.0',
  os: 'Windows 10.0.26200 (x64)',
  versions: { electron: '44.4.5', chrome: '140.0.1', node: '24.1.0' },
  homeDir: 'C:\\Users\\alice'
}

describe('formatDiagnostics', () => {
  it('lists the versions and OS, then the recent log in a block ready to paste into a GitHub issue', () => {
    const log = '2026-09-28T10:00:00.000Z INFO  Polyscope 0.1.0 started\n'
    expect(formatDiagnostics({ ...environment, log })).toBe(
      [
        '### Polyscope diagnostics',
        '',
        '- Polyscope: 0.1.0',
        '- OS: Windows 10.0.26200 (x64)',
        '- Electron: 44.4.5',
        '- Chromium: 140.0.1',
        '- Node.js: 24.1.0',
        '',
        '<details><summary>Recent app log</summary>',
        '',
        '```',
        '2026-09-28T10:00:00.000Z INFO  Polyscope 0.1.0 started',
        '```',
        '',
        '</details>',
        ''
      ].join('\n')
    )
  })

  it('says so when the log is empty', () => {
    expect(formatDiagnostics({ ...environment, log: '' })).toContain('```\n(empty)\n```')
  })

  it('redacts the log, secrets and the home directory alike', () => {
    const log = 'WARN read C:\\Users\\alice\\app.log with password=hunter2\n'
    const report = formatDiagnostics({ ...environment, log })
    expect(report).toContain('WARN read ~\\app.log with password=[redacted]')
    expect(report).not.toContain('alice')
    expect(report).not.toContain('hunter2')
  })
})
