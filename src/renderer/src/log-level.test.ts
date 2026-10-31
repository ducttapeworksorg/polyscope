import { describe, expect, it } from 'vitest'
import { logLevelOf } from './log-level'

/** The line's Log Level and the text coloured as it, if any. */
const levelAndText = (line: string) => {
  const found = logLevelOf(line)
  return found && { level: found.level, text: found.span && line.slice(found.span.start, found.span.end) }
}

describe('a Log Level word', () => {
  it('is found in upper case anywhere near the start', () => {
    expect(levelAndText('12:00:00.123 [http-nio-8080-exec-10] INFO  c.f.Bar - started')).toEqual({ level: 'info', text: 'INFO' })
  })
})

describe('a line', () => {
  it('has the first level word in it, not one later in its message', () => {
    expect(levelAndText('INFO connecting, retrying after ERROR')).toEqual({ level: 'info', text: 'INFO' })
  })

  it('has no level from a word beyond its first 100 characters', () => {
    expect(levelAndText(`${'x'.repeat(100)} ERROR`)).toBeUndefined()
    expect(levelAndText(`${'x'.repeat(98)} ERROR`)).toEqual({ level: 'error', text: 'ERROR' })
  })

  it('has its level counted from after the timestamp and kubectl prefix shown before its own text', () => {
    const own = `${'x'.repeat(90)} ERROR`
    expect(levelAndText(`2026-10-29 12:00:00.123 ${own}`)).toEqual({ level: 'error', text: 'ERROR' })
    expect(levelAndText(`2026-10-29 12:00:00.123Z [pod/web-1/app] ${own}`)).toEqual({ level: 'error', text: 'ERROR' })
    expect(levelAndText(`[pod/web-1/app] 2026-10-29T12:00:00.123456789Z ${own}`)).toEqual({ level: 'error', text: 'ERROR' })
  })

  it('is read past ANSI escape sequences', () => {
    expect(levelAndText('\x1b[32mINF\x1b[0m started')).toEqual({ level: 'info', text: 'INF' })
    expect(levelAndText(`\x1b[2m${'\x1b[0m'.repeat(30)}${'x'.repeat(90)} ERROR`)).toEqual({ level: 'error', text: 'ERROR' })
  })

  it('has no level from a lone letter or a word of no level', () => {
    expect(levelAndText('E connected, ERRORS none, INFOS none')).toBeUndefined()
  })
})

describe('a Log Level word in lower or title case', () => {
  it.each([
    ['NLog', '2026-10-29 12:00:00.1234|Warn|App.Worker|disk low', 'warning', 'Warn'],
    ['NLog TriLetter', '[Inf] started', 'info', 'Inf'],
    ['Serilog w3', '[12:00:00 inf] started', 'info', 'inf'],
    ['Serilog', '2026-10-29 12:00:00.000 +02:00 [Information] started', 'info', 'Information'],
    ['MS.Extensions.Logging', 'fail: App.Worker[0]', 'error', 'fail'],
    ['MS.Extensions.Logging', 'dbug: App.Worker[0]', 'debug', 'dbug'],
    ['MS.Extensions.Logging', 'crit: App.Worker[0]', 'error', 'crit'],
    ['MS.Extensions.Logging', 'trce: App.Worker[0]', 'debug', 'trce'],
    ['structlog', '2026-10-29 12:00:00 [warning  ] disk low', 'warning', 'warning'],
    ['loguru', '2026-10-29 12:00:00.123 | success  | app:main:1 - done', 'info', 'success'],
    ['winston', 'error: connection refused', 'error', 'error'],
    ['winston', 'http: GET /health 200', 'info', 'http'],
    ['winston', 'silly: tick', 'debug', 'silly'],
    ['a bracketed upper-case MEL form', '[FAIL] App.Worker', 'error', 'FAIL']
  ])('is found when delimited, as %s writes it', (_logger, line, level, text) => {
    expect(levelAndText(line)).toEqual({ level, text })
  })

  it('is not found in a message', () => {
    expect(levelAndText('Connected to Info Service')).toBeUndefined()
    expect(levelAndText('an error, and a warning')).toBeUndefined()
    expect(levelAndText('GET http://example.com/ done')).toBeUndefined()
    expect(levelAndText('[http-nio-8080-exec-10] started')).toBeUndefined()
  })

  it('is not found in brackets with more of a message in them', () => {
    expect(levelAndText('see (the info) page')).toBeUndefined()
    expect(levelAndText('I said [hello info] ok')).toBeUndefined()
  })

  it('is not found in mixed case', () => {
    expect(levelAndText('[eRRor] x')).toBeUndefined()
  })

  it('in upper case is a MEL or winston form only when delimited', () => {
    expect(levelAndText('HTTP request FAIL counted')).toBeUndefined()
  })
})

describe('a klog line', () => {
  it.each([
    ['I1029 12:00:00.123456    1 controller.go:42] synced', 'info'],
    ['W1029 12:00:00.123456    1 controller.go:42] slow', 'warning'],
    ['E1029 12:00:00.123456    1 controller.go:42] failed', 'error'],
    ['F1029 12:00:00    1 controller.go:42] gave up', 'error']
  ])('has its level from its letter: %s', (line, level) => {
    expect(levelAndText(line)).toEqual({ level, text: line[0] })
  })

  it('has it at the start of its own text, after a shown timestamp', () => {
    expect(levelAndText('2026-10-29 12:00:00.123 E1029 12:00:00.123456 1 a.go:1] ERROR? no, E')).toEqual({ level: 'error', text: 'E' })
  })

  it('is only one starting so', () => {
    expect(levelAndText('job E1029 12:00:00.123456 done')).toBeUndefined()
  })
})

describe('a level field', () => {
  it.each([
    ['logfmt', 'time=2026-10-29T12:00:00Z level=warn msg="disk low"', 'warning', 'warn'],
    ['logfmt, quoted', 'time=2026-10-29T12:00:00Z level="ERROR" msg=x', 'error', 'ERROR'],
    ['JSON', '{"time":"2026-10-29T12:00:00Z","level":"info","msg":"up"}', 'info', 'info'],
    ['Serilog CLEF', '{"@t":"2026-10-29T12:00:00Z","@mt":"up","@l":"Warning"}', 'warning', 'Warning'],
    ['ECS', '{"@timestamp":"2026-10-29T12:00:00Z","log.level":"debug"}', 'debug', 'debug'],
    ['Python', '{"levelname": "CRITICAL", "message": "gone"}', 'error', 'CRITICAL'],
    ['GCP', '{"severity":"NOTICE","message":"x"}', 'info', 'NOTICE'],
    ['.NET', '{"LogLevel":"Information","Message":"x"}', 'info', 'Information'],
    ['lvl', 'ts=1 lvl=dbug msg=x', 'debug', 'dbug']
  ])('says the level, in any case, as in %s', (_format, line, level, text) => {
    expect(levelAndText(line)).toEqual({ level, text })
  })

  it.each([
    [10, 'debug'],
    [20, 'debug'],
    [30, 'info'],
    [40, 'warning'],
    [50, 'error'],
    [60, 'error']
  ])('says it as a pino or bunyan number: %i', (value, level) => {
    expect(levelAndText(`{"level":${value},"time":1,"msg":"x"}`)).toEqual({ level, text: String(value) })
    expect(levelAndText(`lvl=${value} msg=x`)).toEqual({ level, text: String(value) })
  })

  it('says it only by name when not level or lvl', () => {
    expect(levelAndText('{"severity":50,"msg":"x"}')).toBeUndefined()
  })

  it('wins over level words before it and in the message', () => {
    expect(levelAndText('{"msg":"ERROR in handler","level":"info"}')).toEqual({ level: 'info', text: 'info' })
  })

  it('says no level when its value is none, whatever words follow', () => {
    expect(levelAndText('level=custom msg="ERROR boom"')).toBeUndefined()
    expect(levelAndText('{"level":"I","msg":"ERROR"}')).toBeUndefined()
  })

  it('is not one quoted in a message', () => {
    expect(levelAndText('msg="set level=debug" level=info')).toEqual({ level: 'info', text: 'info' })
    expect(levelAndText('{"msg":"set level=debug","level":"info"}')).toEqual({ level: 'info', text: 'info' })
  })

  it('is found anywhere in the line', () => {
    expect(levelAndText(`{"msg":"${'x'.repeat(200)}","level":"warn"}`)).toEqual({ level: 'warning', text: 'warn' })
  })

  it('is only one with its own key', () => {
    expect(levelAndText('{"mylevel":"error","msg":"x"} INFO')).toEqual({ level: 'info', text: 'INFO' })
    expect(levelAndText('sublevel=error INFO')).toEqual({ level: 'info', text: 'INFO' })
  })

  it('makes a Serilog CLEF line without one info', () => {
    expect(logLevelOf('{"@t":"2026-10-29T12:00:00Z","@mt":"Disk {Disk} ERROR","Disk":"c"}')).toEqual({ level: 'info' })
    expect(logLevelOf('{"@t":"2026-10-29T12:00:00Z","@m":"Disk c"}')).toEqual({ level: 'info' })
  })
})

describe('popular loggers', () => {
  it.each([
    ['Serilog', '[12:00:00 INF] started', 'info', 'INF'],
    ['Serilog u4', '[12:00:00 EROR] failed', 'error', 'EROR'],
    ['Serilog', '2026-10-29 12:00:00 INFORMATION started', 'info', 'INFORMATION'],
    ['NLog', '2026-10-29 12:00:00.1234|INFO|App.Worker|started', 'info', 'INFO'],
    ['Spring Boot', '2026-10-29T12:00:00.123+02:00  WARN 1 --- [main] o.s.Boot : slow', 'warning', 'WARN'],
    ['java.util.logging', 'SEVERE: gone', 'error', 'SEVERE'],
    ['java.util.logging', 'FINE: detail', 'debug', 'FINE'],
    ['java.util.logging', 'CONFIG: loaded', 'info', 'CONFIG'],
    ['Python logging', 'WARNING:root:disk low', 'warning', 'WARNING'],
    ['loguru', '2026-10-29 12:00:00.123 | SUCCESS  | app:main:1 - done', 'info', 'SUCCESS'],
    ['Rust tracing', '2026-10-29T12:00:00.123456Z  INFO app::server: listening', 'info', 'INFO'],
    ['env_logger', '[2026-10-29T12:00:00Z WARN  app::db] slow query', 'warning', 'WARN'],
    ['the systemd Journal, as Polyscope shows it', '2026-10-29 12:00:00.123456Z CRIT kernel panic', 'error', 'CRIT'],
    ['a padded JSON value', '{"level":"info  ","msg":"x"}', 'info', 'info']
  ])('are read as %s writes them', (_logger, line, level, text) => {
    expect(levelAndText(line)).toEqual({ level, text })
  })
})
