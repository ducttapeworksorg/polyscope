import { useState } from 'react'
import type { SourceInfo, TreeNode } from '@shared/core-api'
import { t } from '../i18n'
import { AddSourceForm } from './AddSourceForm'
import { PlusIcon } from './icons'
import { SourceTree } from './SourceTree'

interface Props {
  sources: SourceInfo[]
  onSourceAdded(source: SourceInfo): void
  onOpenFile(source: SourceInfo, node: TreeNode): void
}

export function Sidebar({ sources, onSourceAdded, onOpenFile }: Props) {
  const [adding, setAdding] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const isEmpty = sources.length === 0

  return (
    <nav className="sidebar" aria-label={t('sidebar.heading')}>
      <header className="sidebar__header">
        <h2 className="sidebar__heading">{t('sidebar.heading')}</h2>
        {!isEmpty && !adding && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.add')}
            title={t('sidebar.add')}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
          </button>
        )}
      </header>

      {adding && (
        <AddSourceForm
          onCancel={() => setAdding(false)}
          onAdded={(source) => {
            setAdding(false)
            onSourceAdded(source)
          }}
        />
      )}

      {isEmpty && !adding && (
        <div className="sidebar__empty">
          <p className="sidebar__empty-title">{t('sidebar.empty.title')}</p>
          <p className="sidebar__empty-body">{t('sidebar.empty.body')}</p>
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            {t('sidebar.add')}
          </button>
        </div>
      )}

      <div className="sidebar__sources">
        {sources.map((source) => (
          <SourceTree
            key={source.id}
            source={source}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </nav>
  )
}
