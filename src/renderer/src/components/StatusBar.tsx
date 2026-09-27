import { useState } from 'react'
import { textEncodings, type Environment, type LanguageId, type TextEncoding } from '@shared/core-api'
import { environmentStyle } from '../environments'
import { t } from '../i18n'
import { formatCount, formatDateTime, formatSize } from '../i18n/format'
import { allLanguages, languageName } from '../monaco'
import { uiFor } from '../source-types'
import { isLog, type OpenTab } from '../workspace'
import { QuickPick, type PickOption } from './QuickPick'

interface Props {
  activeTab: OpenTab | null
  /** The active tab's Source's Environment, leading the bar in its colour. */
  environment?: Environment
  /** Reopens the active tab's file in `encoding`, or as detected when null. */
  onPickEncoding(encoding: TextEncoding | null): void
  onPickLanguage(language: LanguageId): void
}

/** Picked in the encoding list to go back to whatever the core detects. */
const autoDetect = 'auto'

const encodingLabel = (encoding: TextEncoding) => t(`encoding.${encoding}`)

interface OpenPicker {
  kind: 'encoding' | 'language'
  /** The tab it was opened for; switching tabs leaves it behind. */
  tabKey: string
  /** The status bar item it was opened from, which gets focus back when it closes. */
  anchor: HTMLElement
}

/**
 * Facts about the active tab: its Environment and where it's from, then a file's size, modified time,
 * encoding and language, or how many lines of a Log Stream are shown.
 */
export function StatusBar({ activeTab, environment, onPickEncoding, onPickLanguage }: Props) {
  const [picker, setPicker] = useState<OpenPicker | null>(null)
  const closePicker = () => {
    setPicker(null)
    picker?.anchor.focus()
  }

  if (!activeTab) {
    return (
      <footer className="statusbar">
        <span className="statusbar__item statusbar__item--end">{t('status.readOnly')}</span>
      </footer>
    )
  }
  const { source, file, openAs } = activeTab
  const { Icon } = uiFor(source.type)
  const language = file.view === 'editor' ? (activeTab.language ?? file.language) : null
  const shownPicker = picker?.tabKey === activeTab.key ? picker : null

  const encodingOptions: PickOption[] = [
    { value: autoDetect, label: t('encoding.auto') },
    ...textEncodings.map((encoding) => ({
      value: encoding,
      label: encodingLabel(encoding),
      ...(file.view === 'editor' && file.encoding === encoding && { detail: t('encoding.current') })
    }))
  ]
  const languageOptions = (): PickOption[] =>
    allLanguages().map(({ id, name }) => ({
      value: id,
      label: name,
      ...(file.view === 'editor' && file.language === id && { detail: t('language.detected') })
    }))

  return (
    <footer className="statusbar">
      {environment && (
        <span className="statusbar__item statusbar__environment" style={environmentStyle(environment)} title={t('environments.status')}>
          {environment.name}
        </span>
      )}
      <span className="statusbar__item">
        <Icon />
        {source.name}
      </span>
      <span className="statusbar__item statusbar__item--path">{file.path}</span>
      {isLog(file) ? (
        <>
          <span className="statusbar__item statusbar__item--end">{file.view === 'log' && lineCount(file.content)}</span>
          <span className="statusbar__item">{languageName('log')}</span>
        </>
      ) : (
        <>
          <span className="statusbar__item statusbar__item--end" title={t('status.size')}>
            {formatSize(file.size)}
            {file.compression && ` (${t(`compression.${file.compression}`)})`}
          </span>
          <span className="statusbar__item" title={t('status.modified')}>
            {formatDateTime(file.modifiedTime)}
          </span>
          <button
            type="button"
            className="statusbar__item statusbar__button"
            title={t('status.reopenWithEncoding')}
            aria-label={t('status.encodingLabel', { encoding: statusEncoding(activeTab) })}
            onClick={(event) => setPicker({ kind: 'encoding', tabKey: activeTab.key, anchor: event.currentTarget })}
          >
            {statusEncoding(activeTab)}
          </button>
          {language && (
            <button
              type="button"
              className="statusbar__item statusbar__button"
              title={t('status.selectLanguage')}
              aria-label={t('status.languageLabel', { language: languageName(language) })}
              onClick={(event) => setPicker({ kind: 'language', tabKey: activeTab.key, anchor: event.currentTarget })}
            >
              {languageName(language)}
            </button>
          )}
        </>
      )}
      <span className="statusbar__item">{t('status.readOnly')}</span>

      {shownPicker?.kind === 'encoding' && (
        <QuickPick
          label={t('status.reopenWithEncoding')}
          placeholder={t('status.encodingPlaceholder')}
          options={encodingOptions}
          selected={openAs?.encoding ?? autoDetect}
          anchor={shownPicker.anchor}
          onPick={(value) => onPickEncoding(value === autoDetect ? null : (value as TextEncoding))}
          onClose={closePicker}
        />
      )}
      {shownPicker?.kind === 'language' && language && (
        <QuickPick
          label={t('status.selectLanguage')}
          placeholder={t('status.languagePlaceholder')}
          options={languageOptions()}
          selected={language}
          anchor={shownPicker.anchor}
          onPick={onPickLanguage}
          onClose={closePicker}
        />
      )}
    </footer>
  )
}

/** How many lines a Log Stream's snapshot shows. */
function lineCount(content: string) {
  const count = content ? content.split('\n').length : 0
  return count === 1 ? t('status.oneLine') : t('status.lines', { count: formatCount(count) })
}

/** What the encoding item says: the encoding text was decoded with, or how undecoded bytes are shown. */
function statusEncoding({ file }: OpenTab) {
  if (isLog(file)) return ''
  if (file.view === 'editor') return encodingLabel(file.encoding)
  if (file.view === 'binary') return t('encoding.binary')
  // A large file's dump stops short of its end, and says so.
  return file.shownLength < file.contentLength ? t('encoding.hexPartial', { size: formatSize(file.shownLength) }) : t('encoding.hex')
}
