import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import type { LargeFile, LargeFileStatus } from '@shared/core-api'
import { core, describeFailure } from '../core-client'
import { t } from '../i18n'
import { formatCount, formatSize } from '../i18n/format'

/** Where a Large File's view was, kept while its tab is in the background. */
export interface LargeFilePlace {
  /** The first line shown, fractional when scrolled partway into it; Infinity at the end. */
  top: number
  /** Whether `top` counts lines of the whole file, or of its last lines, as before it was indexed. */
  indexed: boolean
  status: LargeFileStatus
}

interface Props {
  file: LargeFile
  /** Where it was last left, if it was shown before. */
  place?: LargeFilePlace
  /** Told where it's left, as it's scrolled. */
  onPlace(place: LargeFilePlace): void
}

/** Matches the editor's line height, so switching views keeps the text where the eye expects it. */
const rowHeight = 21
/** Browsers stop laying out elements somewhere past 16M pixels; beyond this height, scrolling is scaled. */
const maxScrollHeight = 8_000_000
/** Lines are fetched a page at a time; only the pages in view, and one either side, are kept. */
const pageSize = 256

/** Whether `next` says more than `prev`: a finished status is final, and progress only goes forward. */
function newer(prev: LargeFileStatus, next: LargeFileStatus) {
  if (prev.state !== 'caching') return false
  return next.state !== 'caching' || next.loadedBytes >= prev.loadedBytes
}

const percent = (loaded: number, total: number) => `${total ? Math.floor((loaded / total) * 100) : 100}%`

/**
 * The Large File Viewer: a virtualised, read-only view of a file of any size. It opens on the file's last
 * lines, then, once the core has cached and indexed it, scrolls through all of it, fetching only the lines
 * in view. Scrolling is scaled when the file is too tall to lay out, with the wheel and keys still moving
 * line by line.
 */
export function LargeFileViewer({ file, place, onPlace }: Props) {
  const { largeFileId, lastLines } = file
  const scrollerRef = useRef<HTMLDivElement>(null)
  const goToRef = useRef<HTMLInputElement>(null)
  const goToId = useId()
  const [height, setHeight] = useState(0)
  const [status, setStatus] = useState<LargeFileStatus>(place?.status ?? { state: 'caching', loadedBytes: 0, totalBytes: file.size })
  const [position, setPosition] = useState({ top: place?.top ?? Infinity, indexed: place?.indexed ?? false })
  const [pages, setPages] = useState<ReadonlyMap<number, string[]>>(new Map())
  const [marked, setMarked] = useState<number | null>(null)
  const [goTo, setGoTo] = useState('')
  const fetching = useRef(new Set<number>())
  // Bumped to fetch again after a fetch failed.
  const [retries, setRetries] = useState(0)
  // The scrollTop last set here, whose scroll event isn't the user's.
  const settingScroll = useRef<number | null>(null)

  const ready = status.state === 'ready'
  const lineCount = ready ? status.lineCount : lastLines.length
  const visible = height / rowHeight
  const maxTop = Math.max(0, lineCount - visible)
  // A place in the last lines, before indexing, is shown at its place in the whole file.
  const top = ready && !position.indexed && Number.isFinite(position.top) ? position.top + lineCount - lastLines.length : position.top
  const shownTop = Math.min(Math.max(0, top), maxTop)
  const scrollHeight = Math.max(height, Math.min(lineCount * rowHeight, maxScrollHeight))
  const scrollRange = scrollHeight - height

  const metrics = useRef({ maxTop, visible, shownTop })
  metrics.current = { maxTop, visible, shownTop }

  useEffect(() => {
    const unsubscribe = core.onLargeFileEvent(({ largeFileId: id, ...next }) => {
      if (id === largeFileId) setStatus((prev) => (newer(prev, next) ? next : prev))
    })
    void core.largeFileStatus(largeFileId).then(
      (next) => setStatus((prev) => (newer(prev, next) ? next : prev)),
      () => undefined
    )
    return unsubscribe
  }, [largeFileId])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current!
    const observer = new ResizeObserver(() => setHeight(scroller.clientHeight))
    observer.observe(scroller)
    setHeight(scroller.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Once indexed, a place in the last lines becomes a place in the whole file.
  useLayoutEffect(() => {
    if (ready && !position.indexed) setPosition({ top, indexed: true })
  }, [ready, position.indexed, top])

  useEffect(() => onPlace({ top: position.top, indexed: position.indexed, status }), [position, status, onPlace])

  /** Moves to a first line, Infinity (or anywhere past the last) staying at the end. */
  const moveTo = (next: number) => setPosition((prev) => ({ ...prev, top: next >= metrics.current.maxTop ? Infinity : Math.max(0, next) }))

  // The scrollbar follows the lines shown, however they were moved.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current!
    const wanted = maxTop > 0 ? (shownTop / maxTop) * scrollRange : 0
    if (Math.abs(scroller.scrollTop - wanted) < 1) return
    settingScroll.current = wanted
    scroller.scrollTop = wanted
  }, [shownTop, maxTop, scrollRange])

  const onScroll = () => {
    const { scrollTop } = scrollerRef.current!
    const expected = settingScroll.current
    settingScroll.current = null
    if (expected !== null && Math.abs(scrollTop - expected) < 1) return
    moveTo(scrollTop >= scrollRange - 1 ? Infinity : scrollRange > 0 ? (scrollTop / scrollRange) * maxTop : 0)
  }

  // The wheel moves by lines, not by pixels of a scaled scrollbar, however tall the file.
  useEffect(() => {
    const scroller = scrollerRef.current!
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      const { visible, shownTop } = metrics.current
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * visible : event.deltaY / rowHeight
      moveTo(shownTop + lines)
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  // Fetches the pages in view, and one either side, dropping the rest.
  useEffect(() => {
    if (!ready) return
    const lastPage = Math.ceil(lineCount / pageSize) - 1
    const from = Math.max(0, Math.floor(shownTop / pageSize) - 1)
    const to = Math.min(lastPage, Math.floor((shownTop + visible) / pageSize) + 1)
    const wanted = (page: number) => page >= from && page <= to
    setPages((prev) => ([...prev.keys()].every(wanted) ? prev : new Map([...prev].filter(([page]) => wanted(page)))))
    for (let page = from; page <= to; page++) {
      if (pages.has(page) || fetching.current.has(page)) continue
      fetching.current.add(page)
      void core
        .readLargeFileLines(largeFileId, page * pageSize, pageSize)
        .then(
          ({ lines }) => setPages((prev) => new Map(prev).set(page, lines)),
          // Tried again a moment later, rather than leaving the rows blank until the view moves.
          () => setTimeout(() => setRetries((n) => n + 1), 1_000)
        )
        .finally(() => fetching.current.delete(page))
    }
  }, [ready, largeFileId, lineCount, shownTop, visible, pages, retries])

  const lineAt = (line: number) => (ready ? pages.get(Math.floor(line / pageSize))?.[line % pageSize] : lastLines[line])

  const jumpTo = (line: number) => {
    setMarked(line)
    moveTo(line - Math.floor(visible / 3))
    scrollerRef.current?.focus()
  }

  const submitGoTo = (event: FormEvent) => {
    event.preventDefault()
    const line = Number(goTo)
    if (ready && Number.isSafeInteger(line) && line > 0) jumpTo(Math.min(line, lineCount) - 1)
  }

  // Ctrl+G goes to a line, as in the editor.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        goToRef.current?.focus()
        goToRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(visible) - 1)
    const moves: Record<string, number | undefined> = {
      ArrowDown: shownTop + 1,
      ArrowUp: shownTop - 1,
      PageDown: shownTop + page,
      PageUp: shownTop - page,
      Home: event.ctrlKey || event.metaKey ? 0 : undefined,
      End: event.ctrlKey || event.metaKey ? Infinity : undefined
    }
    const next = moves[event.key]
    if (next === undefined) return
    event.preventDefault()
    moveTo(next)
  }

  const first = Math.floor(shownTop)
  const rows = Array.from({ length: Math.min(Math.ceil(visible) + 1, lineCount - first) }, (_, i) => first + i)
  const gutter = { '--gutter': `${ready ? String(lineCount).length : 0}ch` } as CSSProperties

  return (
    <div className="large-file">
      <div className="log-toolbar large-file__toolbar">
        <Progress status={status} compressed={Boolean(file.compression)} />
        <form className="log-toolbar__lines large-file__go-to" onSubmit={submitGoTo}>
          <label className="log-toolbar__label" htmlFor={goToId}>
            {t('largeFile.goToLine')}
          </label>
          <input
            id={goToId}
            ref={goToRef}
            className="field__input log-toolbar__input"
            inputMode="numeric"
            disabled={!ready}
            title={t(ready ? 'largeFile.goToLine.tooltip' : 'largeFile.goToLine.notReady')}
            placeholder={ready ? t('largeFile.goToLine.placeholder', { count: formatCount(lineCount) }) : ''}
            value={goTo}
            onChange={(event) => setGoTo(event.target.value.replace(/\D/g, ''))}
          />
        </form>
      </div>
      <div
        ref={scrollerRef}
        className="large-file__scroller"
        tabIndex={0}
        role="document"
        aria-label={file.name}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-testid="large-file"
      >
        <div className="large-file__spacer" style={{ height: scrollHeight }}>
          <div className="large-file__lines" style={{ ...gutter, height }}>
            <div style={{ transform: `translateY(${(first - shownTop) * rowHeight}px)` }}>
              {rows.map((line) => (
                <div key={line} className={`large-file__row${line === marked ? ' large-file__row--marked' : ''}`} style={{ height: rowHeight }}>
                  <span className="large-file__number">{ready ? line + 1 : ''}</span>
                  <span className="large-file__text">{lineAt(line) ?? ''}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {!ready && lineCount === 0 && status.state === 'caching' && (
          <div className="viewer__empty large-file__waiting">
            <p>{t('largeFile.decompressing')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** How far caching has got, or why it stopped. */
function Progress({ status, compressed }: { status: LargeFileStatus; compressed: boolean }) {
  if (status.state === 'ready') {
    return <span className="large-file__progress">{t(status.lineCount === 1 ? 'status.oneLine' : 'status.lines', { count: formatCount(status.lineCount) })}</span>
  }
  if (status.state === 'failed') {
    return (
      <span className="large-file__progress large-file__progress--failed" role="alert">
        {t('largeFile.failed', { reason: describeFailure(status) })}
      </span>
    )
  }
  const { loadedBytes, totalBytes } = status
  return (
    <span className="large-file__progress" role="status">
      <progress className="large-file__bar" max={totalBytes || 1} value={loadedBytes} aria-label={t('largeFile.caching.label')} />
      {t(compressed ? 'largeFile.decompressing.progress' : 'largeFile.caching', {
        percent: percent(loadedBytes, totalBytes),
        loaded: formatSize(loadedBytes),
        total: formatSize(totalBytes)
      })}
    </span>
  )
}
