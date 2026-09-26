import { useEffect, useState } from 'react'
import type { SourceInfo, TreeNode } from '@shared/core-api'
import { ApertureMark, HardDriveIcon } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { nodeKey } from './components/SourceTree'
import { Tabs } from './components/Tabs'
import { Viewer } from './components/Viewer'
import { core, describeError } from './core-client'
import { t } from './i18n'
import type { OpenTab } from './workspace'

export function App() {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    void core.listSources().then(setSources)
  }, [])

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null

  const openFile = async (source: SourceInfo, node: TreeNode) => {
    const key = nodeKey(source.id, node.path)
    setOpenError(null)
    if (tabs.some((tab) => tab.key === key)) return setActiveKey(key)
    setOpening(node.name)
    try {
      const file = await core.openFile(source.id, node.path)
      setTabs((prev) => (prev.some((tab) => tab.key === key) ? prev : [...prev, { key, sourceId: source.id, sourceName: source.name, file }]))
      setActiveKey(key)
    } catch (error) {
      setOpenError(describeError(error))
    } finally {
      setOpening(null)
    }
  }

  const closeTab = (key: string) => {
    const index = tabs.findIndex((tab) => tab.key === key)
    const remaining = tabs.filter((tab) => tab.key !== key)
    setTabs(remaining)
    if (key === activeKey) setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? null)
  }

  return (
    <div className="app">
      <Sidebar
        sources={sources}
        onSourceAdded={(source) => setSources((prev) => [...prev, source])}
        onOpenFile={openFile}
      />

      <main className="workbench">
        <Tabs tabs={tabs} activeKey={activeKey} onActivate={setActiveKey} onClose={closeTab} />
        {openError && (
          <p className="workbench__error" role="alert">
            {openError}
          </p>
        )}
        <div className="viewer">
          <Viewer tabs={tabs} activeTab={activeTab} />
          {!activeTab && (
            <div className="viewer__empty">
              <ApertureMark />
              <p>{opening ? t('viewer.opening', { name: opening }) : t(sources.length ? 'viewer.empty.noTabs' : 'viewer.empty.noSources')}</p>
            </div>
          )}
        </div>
      </main>

      <footer className="statusbar">
        {activeTab && (
          <>
            <span className="statusbar__item">
              <HardDriveIcon />
              {activeTab.sourceName}
            </span>
            <span className="statusbar__item statusbar__item--path">{activeTab.file.path}</span>
          </>
        )}
        <span className="statusbar__item statusbar__item--end">{t('status.readOnly')}</span>
      </footer>
    </div>
  )
}
