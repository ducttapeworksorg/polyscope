import type { OpenTab } from '../workspace'
import { t } from '../i18n'
import { CloseIcon, FileIcon } from './icons'

interface Props {
  tabs: OpenTab[]
  activeKey: string | null
  onActivate(key: string): void
  onClose(key: string): void
}

export function Tabs({ tabs, activeKey, onActivate, onClose }: Props) {
  if (tabs.length === 0) return null
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        return (
          <div
            key={tab.key}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            title={`${tab.source.name}: ${tab.file.path}`}
            className={`tab ${active ? 'is-active' : ''}`}
            onClick={() => onActivate(tab.key)}
            onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
          >
            <span className="tab__icon">
              <FileIcon />
            </span>
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
  )
}
