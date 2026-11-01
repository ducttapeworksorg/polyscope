import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { LastNLines } from '@shared/core-api'
import { t } from '../i18n'
import { formatCount } from '../i18n/format'
import type { LevelCounts } from '../log-entries'
import type { LogLevel } from '../log-level'
import type { SinceChoice } from '../since'
import { canShowPrevious, earlierOf, hiddenLevelsOf, isLog, logShownBy, offersPodEvents, offersPrevious, sinceOffered, type OpenTab } from '../workspace'
import { SaveCopyButton } from './FileToolbar'
import { LastNLinesControl } from './LastNLinesControl'
import { LevelFilterControl } from './LevelFilterControl'
import { SinceControl } from './SinceControl'
import { useToolbarFold, type FoldableItem } from './use-toolbar-fold'

/**
 * The toolbar's items to fold into its "…" menu when it's narrow, least used first, so the most used stay longest. The
 * Level Filter, Follow and Pause never fold.
 */
type ControlKey = 'lastNLines' | 'since' | 'loadEarlier' | 'levels' | 'follow' | 'pause' | 'previous' | 'podEvents' | 'timestamps' | 'utc' | 'wrap' | 'saveCopy'

const foldOrder: ControlKey[] = ['saveCopy', 'utc', 'loadEarlier', 'since', 'lastNLines', 'timestamps', 'wrap', 'previous', 'podEvents']

interface Props {
  tab: OpenTab
  onChangeLastNLines(value: LastNLines): void
  onChangeSince(value: SinceChoice | undefined): void
  onToggleFollow(): void
  onTogglePause(): void
  onTogglePrevious(): void
  /** Switches a container's log view to its pod's Events, or back to its log. */
  onTogglePodEvents(): void
  onToggleTimestamps(): void
  onToggleUtc(): void
  onToggleWrap(): void
  /** How many Log Entries the log shown has of each Log Level, for its Level Filter. */
  levelCounts?: LevelCounts
  onToggleLevel(level: LogLevel): void
  /** Reads the lines before the first shown, from a Source Type that can read further back. */
  onLoadEarlier(): void
  /** Saves a copy of the lines shown, asking where; without it, the toolbar offers no "Save a copy…". */
  onSaveCopy?(): void
}

interface ToggleProps {
  pressed: boolean
  disabled?: boolean
  tooltip: string
  onToggle(): void
  children: ReactNode
}

export function Toggle({ pressed, disabled, tooltip, onToggle, children }: ToggleProps) {
  return (
    <button type="button" className="log-toolbar__toggle" aria-pressed={pressed} disabled={disabled} title={tooltip} onClick={onToggle}>
      {children}
    </button>
  )
}

/**
 * The controls at the top of every log view: its "Last N lines", its Since when its Source Type offers it, loading
 * the lines before those shown when its Source Type can, Follow (with pause and resume) for a Log Stream's current log or a file, switching a Log Stream to its Previous Log and back if its Source Type has
 * them, switching a Kubernetes container's to its pod's Events and back, its Level Filter, timestamps in local time or UTC for a Log Stream, wrapping, and saving a copy of the lines shown.
 * Kept on one line: when it's too narrow, the less used fold into a "…" menu at its end.
 */
export function LogToolbar({ tab, onChangeLastNLines, onChangeSince, onToggleFollow, onTogglePause, onTogglePrevious, onTogglePodEvents, onToggleTimestamps, onToggleUtc, onToggleWrap, levelCounts, onToggleLevel, onLoadEarlier, onSaveCopy }: Props) {
  const { file, follow } = tab
  const log = file.view === 'log' ? file : null
  // Kept by a log that failed to read, for reading it again.
  const timestamps = file.view === 'log' || file.view === 'logFailed' ? file.timestamps : false
  // A file's lines come as they are, with no timestamps to add, and it has no Previous Log.
  const ofFile = isLog(file) && file.of === 'file'
  // A Previous Log has ended: there's nothing to Follow.
  const previous = isLog(file) && file.previous
  const lastNLines = file.view === 'log' || file.view === 'logFailed' ? file.lastNLines : 'all'
  // Every control the toolbar has, in order, whether this log offers it or not.
  const controls: (FoldableItem<ControlKey> & { offered: boolean; node: ReactNode })[] = [
    { key: 'lastNLines', group: 'start', offered: true, node: <LastNLinesControl value={lastNLines} onChange={onChangeLastNLines} /> },
    { key: 'since', group: 'start', offered: sinceOffered(tab), node: <SinceControl value={tab.since} utc={tab.utc ?? false} onChange={onChangeSince} /> },
    {
      key: 'loadEarlier',
      group: 'start',
      offered: earlierOf(tab) !== undefined && lastNLines !== 'all',
      node: (
        <button type="button" className="button button--quiet" title={lastNLines === 1 ? t('logView.loadEarlier.tooltip.one') : t('logView.loadEarlier.tooltip', { count: lastNLines === 'all' ? '' : formatCount(lastNLines) })} onClick={onLoadEarlier}>
          {t('logView.loadEarlier')}
        </button>
      )
    },
    {
      key: 'levels',
      group: 'start',
      offered: true,
      node: <LevelFilterControl hidden={hiddenLevelsOf(tab)} {...(log && levelCounts && { counts: levelCounts })} disabled={!log} onToggle={onToggleLevel} />
    },
    {
      key: 'follow',
      group: 'toggles',
      offered: true,
      node: (
        <Toggle
          pressed={Boolean(follow)}
          disabled={!log || previous}
          tooltip={t(ofFile ? 'logView.follow.file.tooltip' : previous ? 'logView.follow.previous.tooltip' : 'logView.follow.tooltip')}
          onToggle={onToggleFollow}
        >
          {t('logView.follow')}
        </Toggle>
      )
    },
    {
      key: 'pause',
      group: 'toggles',
      offered: true,
      node: (
        <Toggle pressed={follow?.paused ?? false} disabled={!follow} tooltip={t('logView.pause.tooltip')} onToggle={onTogglePause}>
          {t(follow?.paused ? 'logView.resume' : 'logView.pause')}
        </Toggle>
      )
    },
    {
      key: 'previous',
      group: 'toggles',
      offered: offersPrevious(tab),
      node: (
        <Toggle
          pressed={previous}
          disabled={!canShowPrevious(tab)}
          tooltip={t(canShowPrevious(tab) ? 'logView.previousLog.tooltip' : 'logView.previousLog.unavailable')}
          onToggle={onTogglePrevious}
        >
          {t('logView.previousLog')}
        </Toggle>
      )
    },
    {
      key: 'podEvents',
      group: 'toggles',
      offered: offersPodEvents(tab),
      node: (
        <Toggle pressed={logShownBy(tab) === 'podEvents'} tooltip={t('logView.podEvents.tooltip')} onToggle={onTogglePodEvents}>
          {t('logView.podEvents')}
        </Toggle>
      )
    },
    {
      key: 'timestamps',
      group: 'toggles',
      offered: !ofFile,
      node: (
        <Toggle pressed={timestamps} disabled={!log} tooltip={t('logView.timestamps.tooltip')} onToggle={onToggleTimestamps}>
          {t('logView.timestamps')}
        </Toggle>
      )
    },
    {
      key: 'utc',
      group: 'toggles',
      offered: !ofFile,
      node: (
        <Toggle pressed={tab.utc ?? false} disabled={!timestamps} tooltip={t('logView.utc.tooltip')} onToggle={onToggleUtc}>
          {t('logView.utc')}
        </Toggle>
      )
    },
    {
      key: 'wrap',
      group: 'toggles',
      offered: true,
      node: (
        <Toggle pressed={tab.wrap ?? false} disabled={!log} tooltip={t('logView.wrap.tooltip')} onToggle={onToggleWrap}>
          {t('logView.wrap')}
        </Toggle>
      )
    },
    { key: 'saveCopy', group: 'toggles', offered: Boolean(onSaveCopy), node: onSaveCopy && <SaveCopyButton tooltip={t('saveCopy.log.tooltip')} disabled={!log} onSaveCopy={onSaveCopy} /> }
  ]
  const items = controls.filter((control) => control.offered)
  const { folded, barRef, togglesRef, moreRef } = useToolbarFold(items, foldOrder)
  const renderInToolbar = (group: FoldableItem['group']) =>
    items
      .filter((item) => item.group === group && !folded.includes(item.key))
      .map((item) => (
        <div key={item.key} className="log-toolbar__item" data-fold-key={item.key}>
          {item.node}
        </div>
      ))
  const inMenu = items.filter((item) => folded.includes(item.key))
  return (
    <div ref={barRef} className="log-toolbar log-toolbar--folding">
      {renderInToolbar('start')}
      <div ref={togglesRef} className="log-toolbar__toggles">
        {renderInToolbar('toggles')}
        {inMenu.length > 0 && <MoreMenu>{inMenu.map((item) => <div key={item.key} className="log-toolbar__more-item" data-menu-key={item.key}>{item.node}</div>)}</MoreMenu>}
      </div>
      {/* A copy of the "…" button, never seen, measured to know the room it takes. */}
      <div className="log-toolbar__measure" aria-hidden inert>
        <button ref={moreRef} type="button" className="log-toolbar__toggle" tabIndex={-1}>
          …
        </button>
      </div>
    </div>
  )
}

/**
 * The "…" button at the end of a narrow log view's toolbar, and the controls folded into it, shown below it while it's
 * pressed. They work as they do in the toolbar; it closes on Escape or on any press or focus outside it.
 */
function MoreMenu({ children }: { children: ReactNode }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Placed below the button, its right edge in line with the button's, but kept in the window. It's fixed, not held in
  // the toolbar, which scrolls across when narrower than all it never folds.
  const place = useCallback(() => {
    const button = buttonRef.current
    const popup = popupRef.current
    if (!button || !popup) return
    const buttonBox = button.getBoundingClientRect()
    popup.style.top = `${buttonBox.bottom + 4}px`
    popup.style.left = `${Math.max(8, buttonBox.right - popup.getBoundingClientRect().width)}px`
  }, [])
  useLayoutEffect(() => {
    if (open) place()
  })

  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', place)
    // The toolbar scrolling across, below the narrowest it's meant for, moves the button.
    document.addEventListener('scroll', place, true)
    const closeOutside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', closeOutside, true)
    }
  }, [open, place])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    buttonRef.current?.focus()
  }

  const onBlur = (event: FocusEvent) => {
    // Focus moving elsewhere in the window, not to the window losing it.
    if (event.relatedTarget && !menuRef.current?.contains(event.relatedTarget as Node)) setOpen(false)
  }

  return (
    <div ref={menuRef} className="log-toolbar__item" onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        className="log-toolbar__toggle"
        aria-label={t('logView.more')}
        aria-expanded={open}
        aria-controls={id}
        title={t('logView.more.tooltip')}
        onClick={() => setOpen((was) => !was)}
      >
        …
      </button>
      <div ref={popupRef} id={id} className="log-toolbar__more" role="group" aria-label={t('logView.more')} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
