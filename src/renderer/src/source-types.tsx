import type { ComponentType } from 'react'
import type { NewSource, SourceInfo, SourceTypeId } from '@shared/core-api'
import { HardDriveIcon } from './components/icons'
import { t, type MessageKey } from './i18n'

export interface FieldsProps<S extends NewSource> {
  value: S
  onChange(value: S): void
}

/** What the renderer needs to show and configure one Source Type. */
export interface SourceTypeUi<S extends NewSource> {
  label: MessageKey
  hint: MessageKey
  Icon: ComponentType
  /** Settings for a Source that hasn't been filled in yet. */
  blank(): S
  /** The editable settings of an existing Source. */
  settingsOf(source: SourceInfo): S
  /** The fields specific to this Source Type; the Source's name is edited by the dialog itself. */
  Fields: ComponentType<FieldsProps<S>>
}

type SourceTypeUis = { [T in SourceTypeId]: SourceTypeUi<Extract<NewSource, { type: T }>> }

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function LocalFields({ value, onChange }: FieldsProps<Extract<NewSource, { type: 'local' }>>) {
  const browse = async () => {
    const picked = await window.polyscope.pickFolder()
    if (!picked) return
    onChange({ ...value, rootPath: picked, name: value.name.trim() ? value.name : lastSegment(picked) })
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor="source-root-path">
        {t('localSource.rootPath')}
      </label>
      <div className="field__row">
        <input
          id="source-root-path"
          className="field__input field__input--path"
          value={value.rootPath}
          onChange={(e) => onChange({ ...value, rootPath: e.target.value })}
          spellCheck={false}
        />
        <button type="button" className="button button--quiet" onClick={browse}>
          {t('localSource.browse')}
        </button>
      </div>
    </div>
  )
}

export const sourceTypeUi: SourceTypeUis = {
  local: {
    label: 'sourceType.local',
    hint: 'sourceType.local.hint',
    Icon: HardDriveIcon,
    blank: () => ({ type: 'local', name: '', rootPath: '' }),
    settingsOf: (source) => ({ type: 'local', name: source.name, rootPath: source.rootPath }),
    Fields: LocalFields
  }
}

/** Looks up a Source Type's UI without narrowing on the type first. */
export const uiFor = (type: SourceTypeId) => sourceTypeUi[type] as unknown as SourceTypeUi<NewSource>
