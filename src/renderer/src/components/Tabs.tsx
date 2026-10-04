import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Environment } from '@shared/core-api'
import { environmentOf, environmentStyle } from '../environments'
import { canFollowFile, isLog, tabName, type OpenTab } from '../workspace'
import { t } from '../i18n'
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
}

/** Ctrl+Tab and Ctrl+PageDown go to the next tab, with Shift or PageUp to the previous; Ctrl+W and Ctrl+F4 close it. */
function tabShortcut(event: globalThis.KeyboardEvent): 'next' | 'previous' | 'close' | null {
  if (event.altKey) return null
  const key = event.key.toLowerCase()
  if (event.ctrlKey && !event.metaKey && key === 'tab') return event.shiftKey ? 'previous' : 'next'
  if (event.shiftKey) return null
  if (event.ctrlKey && !event.metaKey && (key === 'pagedown' || key === 'pageup')) return key === 'pagedown' ? 'next' : 'previous'
  if ((event.ctrlKey || event.metaKey) && (key === 'w' || key === 'f4')) return 'close'
  return null
}

export function Tabs(props: Props) {
  const { tabs, activeKey, environments, onActivate, onCycle, onPin, onReload, onFollow, onClose, onCloseOthers, onCloseAll, minimap, onToggleMinimap } = props
  const { panelId } = props
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<{ tab: OpenTab }>()
  const listRef = useRef<HTMLDivElement>(null)
  // Set when the keyboard changes the active tab from within the tabs, so it goes on to whichever is active next.
  const refocus = useRef(false)

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // Shown focused even after Ctrl+W or Ctrl+Tab, which by themselves wouldn't show it.
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ focusVisible: true })
  }, [activeKey, tabs])

  // The latest of each, for the shortcuts, which are listened for once.
  const latest = useRef({ activeKey, onClose, onCycle })
  latest.current = { activeKey, onClose, onCycle }

  // Taken ahead of the editor, which would otherwise have Ctrl+Tab and the like for itself; not from a dialog.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcut = tabShortcut(event)
      if (!shortcut || document.querySelector('dialog:modal')) return
      const { activeKey, onClose, onCycle } = latest.current
      // Even with no tab to close, Ctrl+W isn't left to close the window.
      event.preventDefault()
      event.stopPropagation()
      if (!activeKey) return
      refocus.current = Boolean(listRef.current?.contains(document.activeElement))
      if (shortcut === 'close') onClose(activeKey)
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
    ...closeItems(tab)
  ]

  const closeItems = ({ key }: OpenTab): MenuItem[] => [
    { label: t('tabs.closeTab'), onSelect: () => onClose(key) },
    ...(tabs.length > 1 ? [{ label: t('tabs.closeOthers'), onSelect: () => onCloseOthers(key) }] : []),
    { label: t('tabs.closeAll'), onSelect: onCloseAll }
  ]

  return (
    <div className="tabs">
      <div ref={listRef} className="tabs__list" role="tablist" aria-label={t('tabs.label')}>
        {tabs.map((tab) => {
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
              title={`${tab.source.name}: ${tab.file.path}`}
              className={`tab ${active ? 'is-active' : ''} ${tab.pinned ? '' : 'is-preview'} ${environment ? 'has-environment' : ''}`}
              style={environment && environmentStyle(environment)}
              onClick={() => onActivate(tab.key)}
              onDoubleClick={() => onPin(tab.key)}
              // A middle press on the scrolling tab list would start autoscrolling instead, and never click.
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
              onContextMenu={(e) => openMenu(e, { tab })}
              onKeyDown={(e) => onTabKeyDown(e, tab)}
            >
              <span className="tab__icon">{isLog(tab.file) ? <LogIcon /> : <FileIcon />}</span>
              <span className="tab__label">{tabName(tab.file)}</span>
              {/* Delete closes the tab from the keyboard, so the button isn't a stop for Tab of its own. */}
              <button
                type="button"
                tabIndex={-1}
                className="tab__close"
                aria-label={t('tabs.close', { name: tabName(tab.file) })}
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
          label={t('tabs.menuLabel', { name: tabName(menu.tab.file) })}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={menuItems(menu.tab)}
        />
      )}
    </div>
  )
}
