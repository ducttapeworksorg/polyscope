import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { Environment } from '@shared/core-api'
import { environmentOf, environmentStyle } from '../environments'
import { canFollowFile, isLog, tabName, type OpenTab } from '../workspace'
import { t } from '../i18n'
import { uiFor } from '../source-types'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { CloseIcon, FileIcon, LogIcon, MinimapIcon, ReloadIcon } from './icons'

interface Props {
  tabs: OpenTab[]
  activeKey: string | null
  /** Every Environment; a tab's top border takes the colour of its Source's. */
  environments: Environment[]
  onActivate(key: string): void
  /** Activates the tab `delta` places on from the active one, wrapping around. */
  onCycle(delta: number): void
  onPin(key: string): void
  onReload(key: string): void
  /** Follows a tab's file in a log view. */
  onFollow(key: string): void
  onClose(key: string): void
  onCloseOthers(key: string): void
  onCloseAll(): void
  /** Whether viewers show a minimap; a setting, the same for every tab, open now or later. */
  minimap: boolean
  onToggleMinimap(): void
  /** The id of the panel showing the active tab. */
  panelId: string
  /** Whether its Pane is the active one, whose tabs the keyboard shortcuts act on; by default it is. */
  paneActive?: boolean
  /** Moves a tab to the other Pane; without it, tabs offer no Move to Other Pane. */
  onMoveToOtherPane?(key: string): void
  /** Whether a tab can move to the other Pane, which it's offered only if it can. */
  canMoveToOtherPane?(key: string): boolean
  /** Moves the active tab into a new Pane, for Ctrl+\. */
  onMoveToNewPane?(key: string): void
  /**
   * Moves a tab dragged from another Pane's tabs into these, at `at` among them; without it, these tabs can neither be
   * dragged nor have tabs dropped on them.
   */
  onDropTab?(key: string, at: number): void
}

/** The type a dragged tab's key is carried as. */
const tabDragType = 'application/x-polyscope-tab'

/** The tabs a tab is being dragged from, which it can't be dropped back onto. */
let draggedFrom: HTMLElement | null = null

/**
 * Ctrl+Tab and Ctrl+PageDown go to the next tab, with Shift or PageUp to the previous; Ctrl+W and Ctrl+F4 close it, and
 * Ctrl+\ moves it into a new Pane.
 */
function tabShortcut(event: globalThis.KeyboardEvent): 'next' | 'previous' | 'close' | 'toNewPane' | null {
  if (event.altKey) return null
  const key = event.key.toLowerCase()
  if (event.ctrlKey && !event.metaKey && key === 'tab') return event.shiftKey ? 'previous' : 'next'
  if (event.shiftKey) return null
  if (event.ctrlKey && !event.metaKey && (key === 'pagedown' || key === 'pageup')) return key === 'pagedown' ? 'next' : 'previous'
  if ((event.ctrlKey || event.metaKey) && (key === 'w' || key === 'f4')) return 'close'
  if ((event.ctrlKey || event.metaKey) && (key === '\\' || event.code === 'Backslash')) return 'toNewPane'
  return null
}

export function Tabs(props: Props) {
  const { tabs, activeKey, environments, onActivate, onCycle, onPin, onReload, onFollow, onClose, onCloseOthers, onCloseAll, minimap, onToggleMinimap } = props
  const { panelId, paneActive = true, onMoveToOtherPane, canMoveToOtherPane, onMoveToNewPane, onDropTab } = props
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<{ tab: OpenTab }>()
  const listRef = useRef<HTMLDivElement>(null)
  // Set when the keyboard changes the active tab from within the tabs, so it goes on to whichever is active next.
  const refocus = useRef(false)
  // Where a tab dragged over from another Pane would be dropped among these: before the tab at that index.
  const [dropAt, setDropAt] = useState<number | null>(null)

  // A drag cancelled over these tabs, say with Escape, may not leave them, so the marker goes when any drag ends.
  useEffect(() => {
    const onDragEnd = () => setDropAt(null)
    document.addEventListener('dragend', onDragEnd)
    return () => document.removeEventListener('dragend', onDragEnd)
  }, [])

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // Shown focused even after Ctrl+W or Ctrl+Tab, which by themselves wouldn't show it.
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ focusVisible: true })
  }, [activeKey, tabs])

  // The latest of each, for the shortcuts, which are listened for once.
  const latest = useRef({ activeKey, onClose, onCycle, onMoveToNewPane, paneActive })
  latest.current = { activeKey, onClose, onCycle, onMoveToNewPane, paneActive }

  // Taken ahead of the editor, which would otherwise have Ctrl+Tab and the like for itself; not from a dialog.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcut = tabShortcut(event)
      const { activeKey, onClose, onCycle, onMoveToNewPane, paneActive } = latest.current
      // Only the active Pane's tabs take them; every Pane's tabs listen.
      if (!shortcut || !paneActive || document.querySelector('dialog:modal')) return
      // Even with no tab to close, Ctrl+W isn't left to close the window.
      event.preventDefault()
      event.stopPropagation()
      if (!activeKey) return
      refocus.current = Boolean(listRef.current?.contains(document.activeElement))
      if (shortcut === 'close') onClose(activeKey)
      else if (shortcut === 'toNewPane') onMoveToNewPane?.(activeKey)
      else onCycle(shortcut === 'next' ? 1 : -1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (tabs.length === 0) return null

  /** Left and Right go to the tab before or after, Home and End to the first or last; Delete closes it and Enter pins it. */
  const onTabKeyDown = (event: KeyboardEvent, tab: OpenTab) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const actions: Record<string, (() => void) | undefined> = {
      ArrowRight: () => onCycle(1),
      ArrowLeft: () => onCycle(-1),
      Home: () => onActivate(tabs[0]!.key),
      End: () => onActivate(tabs.at(-1)!.key),
      Delete: () => onClose(tab.key),
      Enter: () => onPin(tab.key)
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    refocus.current = true
    action()
  }

  const menuItems = (tab: OpenTab): MenuItem[] => [
    { label: t('tabs.reload'), onSelect: () => onReload(tab.key) },
    ...(canFollowFile(tab) ? [{ label: t('tabs.follow'), onSelect: () => onFollow(tab.key) }] : []),
    ...(onMoveToOtherPane && canMoveToOtherPane?.(tab.key) ? [{ label: t('tabs.moveToOtherPane'), onSelect: () => onMoveToOtherPane(tab.key) }] : []),
    ...closeItems(tab)
  ]

  /** Whether a drag over these tabs is of a tab from another Pane's, which can be dropped here. */
  const droppable = (event: DragEvent) => Boolean(onDropTab) && draggedFrom !== null && draggedFrom !== listRef.current && event.dataTransfer.types.includes(tabDragType)

  /** Where among these tabs a tab dropped at the pointer goes: before the first whose middle is past it, or else at the end. */
  const dropIndexAt = (clientX: number) => {
    const shown = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    const before = shown.findIndex((element) => {
      const { left, width } = element.getBoundingClientRect()
      return clientX < left + width / 2
    })
    return before < 0 ? shown.length : before
  }

  const onDragOver = (event: DragEvent) => {
    if (!droppable(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropAt(dropIndexAt(event.clientX))
  }

  const onDragLeave = (event: DragEvent) => {
    if (!listRef.current?.contains(event.relatedTarget as Node | null)) setDropAt(null)
  }

  const onDrop = (event: DragEvent) => {
    setDropAt(null)
    if (!droppable(event)) return
    event.preventDefault()
    onDropTab?.(event.dataTransfer.getData(tabDragType), dropIndexAt(event.clientX))
  }

  const closeItems = ({ key }: OpenTab): MenuItem[] => [
    { label: t('tabs.closeTab'), onSelect: () => onClose(key) },
    ...(tabs.length > 1 ? [{ label: t('tabs.closeOthers'), onSelect: () => onCloseOthers(key) }] : []),
    { label: t('tabs.closeAll'), onSelect: onCloseAll }
  ]

  return (
    <div className="tabs">
      <div
        ref={listRef}
        className={`tabs__list ${dropAt === tabs.length ? 'is-drop-end' : ''}`}
        role="tablist"
        aria-label={t('tabs.label')}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {tabs.map((tab, index) => {
          const active = tab.key === activeKey
          const environment = environmentOf(environments, tab.source)
          return (
            <div
              key={tab.key}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              aria-description={tab.pinned ? undefined : t('tabs.preview')}
              title={`${tab.source.name}: ${uiFor(tab.source.type).fullPath(tab.source, tab.file.path)}`}
              className={`tab ${active ? 'is-active' : ''} ${tab.pinned ? '' : 'is-preview'} ${environment ? 'has-environment' : ''} ${dropAt === index ? 'is-drop-before' : ''}`}
              style={environment && environmentStyle(environment)}
              draggable={Boolean(onDropTab)}
              onDragStart={(e) => {
                draggedFrom = listRef.current
                e.dataTransfer.setData(tabDragType, tab.key)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                draggedFrom = null
              }}
              onClick={() => onActivate(tab.key)}
              onDoubleClick={() => onPin(tab.key)}
              // A middle press on the scrolling tab list would start autoscrolling instead, and never click.
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
              onContextMenu={(e) => openMenu(e, { tab })}
              onKeyDown={(e) => onTabKeyDown(e, tab)}
            >
              <span className="tab__icon">{isLog(tab.file) ? <LogIcon /> : <FileIcon />}</span>
              <span className="tab__label">{tabName(tab)}</span>
              {/* Delete closes the tab from the keyboard, so the button isn't a stop for Tab of its own. */}
              <button
                type="button"
                tabIndex={-1}
                className="tab__close"
                aria-label={t('tabs.close', { name: tabName(tab) })}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.key)
                }}
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
      </div>
      {activeKey && (
        <div className="tabs__actions">
          <button
            type="button"
            className="icon-button icon-button--toggle"
            aria-label={t('tabs.minimap')}
            aria-pressed={minimap}
            title={t('tabs.minimap')}
            onClick={onToggleMinimap}
          >
            <MinimapIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('tabs.reload')}
            title={t('tabs.reload')}
            onClick={() => onReload(activeKey)}
          >
            <ReloadIcon />
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu
          label={t('tabs.menuLabel', { name: tabName(menu.tab) })}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={menuItems(menu.tab)}
        />
      )}
    </div>
  )
}
