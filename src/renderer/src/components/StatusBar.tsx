import type { ReactNode } from 'react'
import { t } from '../i18n'
import { formatDateTime, formatSize } from '../i18n/format'
import { languageFor } from '../monaco'
import { uiFor } from '../source-types'
import type { OpenTab } from '../workspace'

interface Props {
  activeTab: OpenTab | null
  /** The active tab's Environment segment, leading the bar when its Source has one. */
  environment?: ReactNode
}

/** Facts about the active tab: where it's from, then its size, modified time, encoding and language. */
export function StatusBar({ activeTab, environment }: Props) {
  if (!activeTab) {
    return (
      <footer className="statusbar">
        <span className="statusbar__item statusbar__item--end">{t('status.readOnly')}</span>
      </footer>
    )
  }
  const { source, file } = activeTab
  const { Icon } = uiFor(source.type)
  return (
    <footer className="statusbar">
      {environment}
      <span className="statusbar__item">
        <Icon />
        {source.name}
      </span>
      <span className="statusbar__item statusbar__item--path">{file.path}</span>
      <span className="statusbar__item statusbar__item--end" title={t('status.size')}>
        {formatSize(file.size)}
      </span>
      <span className="statusbar__item" title={t('status.modified')}>
        {formatDateTime(file.modifiedTime)}
      </span>
      <span className="statusbar__item" title={t('status.encoding')}>
        {file.encoding.toUpperCase()}
      </span>
      <span className="statusbar__item" title={t('status.language')}>
        {languageFor(file.name).name}
      </span>
      <span className="statusbar__item">{t('status.readOnly')}</span>
    </footer>
  )
}
