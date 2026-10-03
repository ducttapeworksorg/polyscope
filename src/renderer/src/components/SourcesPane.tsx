import type { Ref } from 'react'
import type { ContainerNode, EntryNode, PreviousLogNode, SourceInfo } from '@shared/core-api'
import type { UpdateStatus } from '@shared/updates'
import { EnvironmentsDialog } from './EnvironmentsDialog'
import { SettingsDialog } from './SettingsDialog'
import { Sidebar } from './Sidebar'
import type { SourcesModel } from './use-sources'

interface Props {
  ref?: Ref<HTMLElement>
  /** From useSources, once its settings have loaded. */
  model: SourcesModel & { settings: NonNullable<SourcesModel['settings']> }
  update: UpdateStatus
  /** Opens a file in the preview tab, or in a tab of its own when pinned. */
  onOpenFile(source: SourceInfo, node: EntryNode, options?: { pinned: boolean }): void
  /** Opens a container's Log Stream, or its Previous Log, in the preview tab, or in a tab of its own when pinned. */
  onOpenLog(source: SourceInfo, node: ContainerNode | PreviousLogNode, options?: { pinned: boolean }): void
  /** Follows a file of a Local or Kubernetes Files Source in a log view. */
  onFollowFile(source: SourceInfo, node: EntryNode): void
}

/** The Sources sidebar, with the Settings and Environments dialogs it opens. */
export function SourcesPane({ ref, model, update, onOpenFile, onOpenLog, onFollowFile }: Props) {
  const { settings, sources, environments } = model
  return (
    <>
      <Sidebar
        ref={ref}
        sources={sources}
        environments={environments}
        onManageEnvironments={() => model.setEnvironmentsOpen(true)}
        connections={model.connections}
        onConnect={model.connect}
        onDisconnect={(source) => void model.disconnect(source)}
        onSourcesChanged={() => void model.reloadSources()}
        onOpenFile={onOpenFile}
        onOpenLog={onOpenLog}
        onFollowFile={onFollowFile}
        onOpenSettings={() => model.setSettingsOpen(true)}
        showDetails={settings.showTreeDetails}
        onToggleDetails={() => void model.toggleTreeDetails()}
        theme={model.theme ?? settings.theme}
        onToggleTheme={() => void model.toggleTheme()}
      />

      {model.settingsOpen && (
        <SettingsDialog
          settings={settings}
          update={update}
          onPreviewTheme={model.setPreviewTheme}
          onManageEnvironments={() => model.setEnvironmentsOpen(true)}
          onSaved={model.settingsSaved}
          onClose={() => model.setSettingsOpen(false)}
        />
      )}

      {model.environmentsOpen && (
        <EnvironmentsDialog
          environments={environments}
          sources={sources}
          onChanged={() => {
            // Deleting an Environment unlabels its Sources, so both are read again.
            void model.reloadEnvironments()
            void model.reloadSources()
          }}
          onClose={() => model.setEnvironmentsOpen(false)}
        />
      )}
    </>
  )
}
