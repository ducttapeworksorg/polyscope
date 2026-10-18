import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '@shared/core-api'
import { logCopyName, logCopyText } from './log-copy'

const source = (type: SourceInfo['type']) => ({ type }) as SourceInfo
const at = new Date(2026, 9, 18, 9, 5, 7)

describe('the name a copy of a log is suggested', () => {
  it('says which container of which pod, and when it was saved', () => {
    const file = { of: 'logStream', path: 'shop/web-7d9f/nginx', name: 'nginx', previous: false } as const
    expect(logCopyName({ source: source('kubernetesLogs'), file }, at)).toBe('web-7d9f-nginx-2026-10-18-090507.log')
  })

  it('marks a Previous Log', () => {
    const file = { of: 'logStream', path: 'shop/web-7d9f/nginx', name: 'nginx', previous: true } as const
    expect(logCopyName({ source: source('kubernetesLogs'), file }, at)).toBe('web-7d9f-nginx-previous-2026-10-18-090507.log')
  })

  it('says which unit or container, whose names are their own', () => {
    expect(logCopyName({ source: source('systemdJournal'), file: { of: 'logStream', path: 'sshd.service', name: 'sshd.service', previous: false } }, at)).toBe(
      'sshd.service-2026-10-18-090507.log'
    )
    expect(logCopyName({ source: source('dockerLogs'), file: { of: 'logStream', path: 'shop/web/shop-web-1', name: 'shop-web-1', previous: false } }, at)).toBe(
      'shop-web-1-2026-10-18-090507.log'
    )
  })

  it('names a followed file’s copy after the file, not saying .log twice', () => {
    expect(logCopyName({ source: source('local'), file: { of: 'file', path: 'logs/app.log', name: 'app.log', previous: false } }, at)).toBe('app-2026-10-18-090507.log')
    expect(logCopyName({ source: source('sshFiles'), file: { of: 'file', path: 'var/syslog', name: 'syslog', previous: false } }, at)).toBe('syslog-2026-10-18-090507.log')
  })

  it('leaves out what can’t be in a file’s name', () => {
    const file = { of: 'logStream', path: '/aws/lambda/x/2026/10/18/[$LATEST]ab', name: '2026/10/18/[$LATEST]ab:c', previous: false } as const
    expect(logCopyName({ source: source('cloudwatchLogs'), file }, at)).toBe('2026_10_18_[$LATEST]ab_c-2026-10-18-090507.log')
  })
})

describe('the text of a copy of a log', () => {
  it('has the lines shown, in order, one per line', () => {
    expect(logCopyText(['2026-10-18T09:00:00Z INFO a', '2026-10-18T09:00:01Z INFO b'])).toBe('2026-10-18T09:00:00Z INFO a\n2026-10-18T09:00:01Z INFO b\n')
  })

  it('is empty for a log with no lines', () => {
    expect(logCopyText([''])).toBe('')
    expect(logCopyText([])).toBe('')
  })

  it('keeps a blank line among others', () => {
    expect(logCopyText(['a', '', 'b'])).toBe('a\n\nb\n')
  })
})
