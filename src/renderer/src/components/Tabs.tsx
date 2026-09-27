import type { Environment } from '@shared/core-api'
import { environmentOf, environmentStyle } from '../environments'
import { isLog, type OpenTab } from '../workspace'
import { t } from '../i18n'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { CloseIcon, FileIcon, LogIcon, ReloadIcon } from './icons'

interface Props {
  tabs: OpenTab[]
  activeKey: string | null
  /** Every Environment; a tab's top border takes the colour of its Source's. */
  environments: Environment[]
  onActivate(key: string): void
  onPin(key: string): void
  onReload(key: string): void
  onClose(key: string): void
  onCloseOthers(key: string): void
  onCloseAll(): void
}

export function Tabs({ tabs, activeKey, environments, onActivate, onPin, onReload, onClose, onCloseOthers, onCloseAll }: Props) {
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<{ tab: OpenTab }>()

  if (tabs.length === 0) return null

  const menuItems = ({ key }: OpenTab): MenuItem[] => [
    { label: t('tabs.reload'), onSelect: () => onReload(key) },
    { label: t('tabs.closeTab'), onSelect: () => onClose(key) },
    ...(tabs.length > 1 ? [{ label: t('tabs.closeOthers'), onSelect: () => onCloseOthers(key) }] : []),
    { label: t('tabs.closeAll'), onSelect: onCloseAll }
  ]

  return (
    <div className="tabs">
      <div className="tabs__list" role="tablist">
        {tabs.map((tab) => {
          const active = tab.key === activeKey
          const environment = environmentOf(environments, tab.source)
          return (
            <div
              key={tab.key}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-description={tab.pinned ? undefined : t('tabs.preview')}
              title={`${tab.source.name}: ${tab.file.path}`}
              className={`tab ${active ? 'is-active' : ''} ${tab.pinned ? '' : 'is-preview'} ${environment ? 'has-environment' : ''}`}
              style={environment && environmentStyle(environment)}
              onClick={() => onActivate(tab.key)}
              onDoubleClick={() => onPin(tab.key)}
              onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
              onContextMenu={(e) => openMenu(e, { tab })}
            >
              <span className="tab__icon">{isLog(tab.file) ? <LogIcon /> : <FileIcon />}</span>
              <span className="tab__label">{tab.file.name}</span>
              <button
                type="button"
                className="tab__close"
                aria-label={t('tabs.close', { name: tab.file.name })}
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
          label={t('tabs.menuLabel', { name: menu.tab.file.name })}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={menuItems(menu.tab)}
        />
      )}
    </div>
  )
}
