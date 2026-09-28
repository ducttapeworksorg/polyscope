import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import type { LargeFile, LargeFileSearchEvent, LargeFileSearchQuery, LargeFileStatus } from '@shared/core-api'
import { searchRegExp } from '@shared/search'
import { core, describeError, describeFailure } from '../core-client'
import { t } from '../i18n'
import { formatCount, formatSize } from '../i18n/format'
import { highlightLine } from '../line-highlights'
import { applySearchUpdate, nextMatch, startedSearch, type SearchResults } from '../search-results'
import { ChevronIcon, CloseIcon } from './icons'

/** Where a Large File's view was, kept while its tab is in the background. */
export interface LargeFilePlace {
  /** The first line shown, fractional when scrolled partway into it; Infinity at the end. */
  top: number
  /** Whether `top` counts lines of the whole file, or of its last lines, as before it was indexed. */
  indexed: boolean
  status: LargeFileStatus
  /** What's typed in the search box, and whether it matches case. */
  query: string
  matchCase: boolean
  /** The last search, if any; one left unfinished is started again on coming back. */
  search: SearchResults | null
}

interface Props {
  file: LargeFile
  /** Where it was last left, if it was shown before. */
  place?: LargeFilePlace
  /** Told where it's left, as it's scrolled. */
  onPlace(place: LargeFilePlace): void
  /** In bytes: a file whose content is no larger can be opened in the editor anyway. */
  openAnywayLimit: number
  /** Opens the file in the editor instead. */
  onOpenAnyway(): void
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

const sameQuery = (a: LargeFileSearchQuery, b: LargeFileSearchQuery) => a.pattern === b.pattern && Boolean(a.matchCase) === Boolean(b.matchCase)

/**
 * The Large File Viewer: a virtualised, read-only view of a file of any size. It opens on the file's last
 * lines, then, once the core has cached and indexed it, scrolls through all of it, fetching only the lines
 * in view, and can be searched. Scrolling is scaled when the file is too tall to lay out, with the wheel and
 * keys still moving line by line. Log levels, timestamps and search matches are picked out in the lines.
 */
export function LargeFileViewer({ file, place, onPlace, openAnywayLimit, onOpenAnyway }: Props) {
  const { largeFileId, lastLines } = file
  const scrollerRef = useRef<HTMLDivElement>(null)
  const goToRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const goToId = useId()
  const [height, setHeight] = useState(0)
  const [status, setStatus] = useState<LargeFileStatus>(place?.status ?? { state: 'caching', loadedBytes: 0, totalBytes: file.size })
  const [position, setPosition] = useState({ top: place?.top ?? Infinity, indexed: place?.indexed ?? false })
  const [pages, setPages] = useState<ReadonlyMap<number, string[]>>(new Map())
  const [marked, setMarked] = useState<number | null>(null)
  const [goTo, setGoTo] = useState('')
  const [query, setQuery] = useState(place?.query ?? '')
  const [matchCase, setMatchCase] = useState(place?.matchCase ?? false)
  const [search, setSearch] = useState<SearchResults | null>(place?.search ?? null)
  const [searchProblem, setSearchProblem] = useState<string | null>(null)
  const searchRef = useRef(search)
  searchRef.current = search
  // Updates that came for a search being started, before its id was known.
  const earlyEvents = useRef<LargeFileSearchEvent[] | null>(null)
  // Counts searches started (and the view closing), so a search that finishes starting after another has started is let go.
  const starts = useRef(0)
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

  useEffect(() => {
    const unsubscribe = core.onLargeFileSearchEvent((event) => {
      if (earlyEvents.current) earlyEvents.current.push(event)
      else {
        const { searchId, ...update } = event
        setSearch((prev) => (prev?.searchId === searchId ? applySearchUpdate(prev, update) : prev))
      }
    })
    // A search left going is stopped; coming back starts it again.
    return () => {
      unsubscribe()
      starts.current++
      cancelRunning()
    }
  }, [])

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

  useEffect(
    () => onPlace({ top: position.top, indexed: position.indexed, status, query, matchCase, search }),
    [position, status, query, matchCase, search, onPlace]
  )

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

  /** Shows a line a third of the way down, marked; the lines take the keyboard unless `focus` says not to. */
  const jumpTo = (line: number, focus = true) => {
    setMarked(line)
    moveTo(line - Math.floor(visible / 3))
    if (focus) scrollerRef.current?.focus()
  }

  const submitGoTo = (event: FormEvent) => {
    event.preventDefault()
    const line = Number(goTo)
    if (ready && Number.isSafeInteger(line) && line > 0) jumpTo(Math.min(line, lineCount) - 1)
  }

  /** Stops the search shown, if it's still going. */
  function cancelRunning() {
    const running = searchRef.current
    if (running && !running.outcome) void core.cancelLargeFileSearch(running.searchId).catch(() => undefined)
  }

  /** Starts searching for `next`, stopping the search before it, if it's still going. */
  const startSearch = async (next: LargeFileSearchQuery) => {
    const pattern = searchRegExp(next)
    if (!(pattern instanceof RegExp)) return setSearchProblem(t('error.INVALID_PATTERN', { message: pattern.problem }))
    setSearchProblem(null)
    cancelRunning()
    const start = ++starts.current
    earlyEvents.current ??= []
    try {
      const { searchId } = await core.searchLargeFile(largeFileId, next)
      // Overtaken by a later search, or the view has gone: nobody wants this one.
      if (start !== starts.current) return void core.cancelLargeFileSearch(searchId).catch(() => undefined)
      let started = startedSearch(next, searchId)
      for (const { searchId: id, ...update } of earlyEvents.current ?? []) if (id === searchId) started = applySearchUpdate(started, update)
      setSearch(started)
    } catch (error) {
      if (start === starts.current) setSearchProblem(describeError(error))
    } finally {
      if (start === starts.current) earlyEvents.current = null
    }
  }

  // A search left unfinished when the tab was last shown is started again once the file is ready.
  const resumed = useRef(false)
  useEffect(() => {
    if (!ready || resumed.current) return
    resumed.current = true
    const left = place?.search
    if (left && !left.outcome) void startSearch(left.query)
  })

  /** Goes to the next match (1) or the one before (-1). */
  const step = (direction: 1 | -1) => {
    if (!search) return
    const index = nextMatch(search, direction, Math.floor(shownTop))
    if (index === null) return
    setSearch({ ...search, current: index })
    jumpTo(search.matches[index]!.line, false)
  }

  const pick = (index: number) => {
    if (!search) return
    setSearch({ ...search, current: index })
    jumpTo(search.matches[index]!.line)
  }

  const closeSearch = () => {
    starts.current++
    earlyEvents.current = null
    cancelRunning()
    setSearch(null)
    setSearchProblem(null)
    scrollerRef.current?.focus()
  }

  /** Enter searches for what's typed, or, once it's been searched for, goes to the next match (Shift+Enter, the one before). */
  const searchOrStep = (direction: 1 | -1) => {
    const next = { pattern: query, matchCase }
    if (search && sameQuery(search.query, next)) step(direction)
    else void startSearch(next)
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    searchOrStep(1)
  }

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      searchOrStep(-1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
    }
  }

  const toggleMatchCase = () => {
    setMatchCase(!matchCase)
    if (search && query) void startSearch({ pattern: query, matchCase: !matchCase })
  }

  const stepRef = useRef(step)
  stepRef.current = step

  // Ctrl+G goes to a line and Ctrl+F searches, as in the editor; F3 and Shift+F3 step through the matches.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const plain = !event.altKey && !event.shiftKey
      const control = (event.ctrlKey || event.metaKey) && plain
      const key = event.key.toLowerCase()
      const field = key === 'g' && control ? goToRef.current : key === 'f' && control ? searchInputRef.current : null
      if (field) {
        event.preventDefault()
        field.focus()
        field.select()
      } else if (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        stepRef.current(event.shiftKey ? -1 : 1)
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

  // Matches are marked in the lines shown with the same pattern the core searched for.
  const searchQuery = search?.query
  const highlight = useMemo(() => {
    const pattern = searchQuery && searchRegExp(searchQuery, true)
    return pattern instanceof RegExp ? pattern : null
  }, [searchQuery])

  // Uncompressed, its content is its size; compressed, it's known once it's been decompressed.
  const contentLength = file.compression ? (ready ? status.contentLength : undefined) : file.size
  const canOpenAnyway = contentLength !== undefined && contentLength <= openAnywayLimit

  const first = Math.floor(shownTop)
  const rows = Array.from({ length: Math.min(Math.ceil(visible) + 1, lineCount - first) }, (_, i) => first + i)
  const gutter = { '--gutter': `${ready ? String(lineCount).length : 0}ch` } as CSSProperties

  return (
    <div className="large-file">
      <div className="log-toolbar large-file__toolbar">
        <Progress status={status} compressed={Boolean(file.compression)} />
        <form className="large-file__search" role="search" onSubmit={submitSearch}>
          <input
            ref={searchInputRef}
            className="field__input log-toolbar__input large-file__search-input"
            type="search"
            aria-label={t('largeFile.search.label')}
            disabled={!ready}
            title={t(ready ? 'largeFile.search.tooltip' : 'largeFile.search.notReady')}
            placeholder={t('largeFile.search.placeholder')}
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button
            type="button"
            className="log-toolbar__toggle"
            aria-pressed={matchCase}
            disabled={!ready}
            title={t('largeFile.search.matchCase')}
            onClick={toggleMatchCase}
          >
            Aa
          </button>
          <button
            type="button"
            className="icon-button large-file__previous"
            disabled={!search?.matches.length}
            title={t('largeFile.search.previous')}
            aria-label={t('largeFile.search.previous')}
            onClick={() => step(-1)}
          >
            <ChevronIcon />
          </button>
          <button
            type="button"
            className="icon-button large-file__next"
            disabled={!search?.matches.length}
            title={t('largeFile.search.next')}
            aria-label={t('largeFile.search.next')}
            onClick={() => step(1)}
          >
            <ChevronIcon />
          </button>
          <SearchSummary search={search} problem={searchProblem} />
        </form>
        <form className="log-toolbar__lines" onSubmit={submitGoTo}>
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
        {canOpenAnyway && (
          <button
            type="button"
            className="log-toolbar__toggle"
            title={t('largeFile.openAnyway.tooltip', { size: formatSize(contentLength), limit: formatSize(openAnywayLimit) })}
            onClick={onOpenAnyway}
          >
            {t('largeFile.openAnyway')}
          </button>
        )}
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
                  <HighlightedLine text={lineAt(line) ?? ''} search={highlight} />
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
      {search && <MatchList search={search} onPick={pick} onClose={closeSearch} />}
    </div>
  )
}

/** A line with its log levels and timestamps picked out, and `search`'s matches marked. */
function HighlightedLine({ text, search }: { text: string; search: RegExp | null }) {
  return (
    <span className="large-file__text">
      {highlightLine(text, search).map((segment, i) => (
        <span
          key={i}
          className={[segment.highlight && `large-file__${segment.highlight}`, segment.match && 'large-file__match'].filter(Boolean).join(' ') || undefined}
        >
          {segment.text}
        </span>
      ))}
    </span>
  )
}

/** How a search is going, or went, in a few words. */
function SearchSummary({ search, problem }: { search: SearchResults | null; problem: string | null }) {
  if (problem) {
    return (
      <span className="large-file__search-summary large-file__progress--failed" role="alert">
        {problem}
      </span>
    )
  }
  if (!search) return null
  const { matches, current, outcome } = search
  const found = formatCount(matches.length)
  const text =
    outcome?.kind === 'failed'
      ? t('largeFile.search.failed', { reason: describeFailure(outcome) })
      : !outcome
        ? t('largeFile.search.searching', { percent: percent(search.scannedBytes, search.totalBytes), count: found })
        : !matches.length
          ? t('largeFile.search.none')
          : current === null
            ? t(outcome.matchedLines === 1 ? 'largeFile.search.oneMatch' : 'largeFile.search.matches', { count: formatCount(outcome.matchedLines) })
            : t('largeFile.search.position', { n: formatCount(current + 1), count: found })
  return (
    <span className={`large-file__search-summary${outcome?.kind === 'failed' ? ' large-file__progress--failed' : ''}`} role="status">
      {text}
    </span>
  )
}

/** A search's matching lines, a row each, only those in view laid out; picking one goes to it. */
function MatchList({ search, onPick, onClose }: { search: SearchResults; onPick(index: number): void; onClose(): void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const { matches, current, outcome } = search

  useLayoutEffect(() => {
    const list = listRef.current!
    const observer = new ResizeObserver(() => setHeight(list.clientHeight))
    observer.observe(list)
    setHeight(list.clientHeight)
    return () => observer.disconnect()
  }, [])

  // The current match stays in view as the matches are stepped through.
  useLayoutEffect(() => {
    const list = listRef.current!
    if (current === null) return
    const top = current * rowHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight
  }, [current])

  const first = Math.floor(scrollTop / rowHeight)
  const shown = Array.from({ length: Math.max(0, Math.min(Math.ceil(height / rowHeight) + 1, matches.length - first)) }, (_, i) => first + i)
  const digits = String((matches.at(-1)?.line ?? 0) + 1).length

  return (
    <section className="large-file__matches" aria-label={t('largeFile.search.results')}>
      <header className="large-file__matches-header">
        <span>
          {outcome?.kind === 'done' && outcome.limited
            ? t('largeFile.search.limited', { shown: formatCount(matches.length), count: formatCount(outcome.matchedLines) })
            : t('largeFile.search.results')}
        </span>
        <button type="button" className="icon-button" title={t('largeFile.search.close')} aria-label={t('largeFile.search.close')} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div ref={listRef} className="large-file__match-list" role="listbox" aria-label={t('largeFile.search.results')} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: matches.length * rowHeight, position: 'relative' }}>
          {shown.map((index) => {
            const { line, preview, start, end } = matches[index]!
            return (
              <div
                key={index}
                role="option"
                aria-selected={index === current}
                className="large-file__match-row"
                style={{ top: index * rowHeight, height: rowHeight, '--gutter': `${digits}ch` } as CSSProperties}
                onClick={() => onPick(index)}
              >
                <span className="large-file__number">{line + 1}</span>
                <span className="large-file__text">
                  {preview.slice(0, start)}
                  <mark className="large-file__match">{preview.slice(start, end)}</mark>
                  {preview.slice(end)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
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
