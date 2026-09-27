import type { ComponentType } from 'react'
import type { NewSource, S3SourceInfo, SourceInfo, SourcePath, SourceTypeId } from '@shared/core-api'
import { BucketIcon, HardDriveIcon } from './components/icons'
import { t, type MessageKey } from './i18n'

export interface FieldsProps<S extends NewSource> {
  value: S
  onChange(value: S): void
  /** The Source being edited, if any, e.g. to tell whether a secret is already stored for it. */
  editing?: SourceInfo
}

/** What the renderer needs to show and configure one Source Type: `S` its settings, `I` its Sources. */
export interface SourceTypeUi<S extends NewSource, I extends SourceInfo> {
  label: MessageKey
  hint: MessageKey
  Icon: ComponentType
  /** Settings for a Source that hasn't been filled in yet. */
  blank(): S
  /** The editable settings of an existing Source. */
  settingsOf(source: I): S
  /** Where an entry really is, as the user would recognise it: a path on disk, an object key, and so on. */
  fullPath(source: I, path: SourcePath): string
  /** The fields specific to this Source Type; the Source's name is edited by the dialog itself. */
  Fields: ComponentType<FieldsProps<S>>
}

type SourceTypeUis = { [T in SourceTypeId]: SourceTypeUi<Extract<NewSource, { type: T }>, Extract<SourceInfo, { type: T }>> }

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** A Source path on disk under `rootPath`, written with the separator the root path uses. */
function pathOnDisk(rootPath: string, path: SourcePath) {
  if (!path) return rootPath
  const sep = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`
}

function LocalFields({ value, onChange }: FieldsProps<Extract<NewSource, { type: 'local' }>>) {
  const browse = async () => {
    const picked = await window.polyscope.pickFolder()
    if (!picked) return
    onChange({ ...value, rootPath: picked, name: value.name.trim() ? value.name : lastSegment(picked) })
  }

  return (
    <>
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
      <label className="field field--check">
        <input
          type="checkbox"
          checked={value.showHidden ?? true}
          onChange={(e) => onChange({ ...value, showHidden: e.target.checked })}
        />
        <span className="field__label">{t('localSource.showHidden')}</span>
        <span className="field__hint">{t('localSource.showHidden.hint')}</span>
      </label>
    </>
  )
}

type S3Settings = Extract<NewSource, { type: 's3' }>

function S3Fields({ value, onChange, editing }: FieldsProps<S3Settings>) {
  const text = (key: keyof S3Settings, label: MessageKey, { hint, mono = false }: { hint?: MessageKey; mono?: boolean } = {}) => (
    <label className="field">
      <span className="field__label">{t(label)}</span>
      <input
        className={`field__input ${mono ? 'field__input--path' : ''}`}
        value={String(value[key] ?? '')}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        spellCheck={false}
      />
      {hint && <span className="field__hint">{t(hint)}</span>}
    </label>
  )
  const stored = editing?.type === 's3' ? editing.secretKeySet : undefined

  return (
    <>
      {text('host', 's3Source.host', { hint: 's3Source.host.hint', mono: true })}
      <div className="field-pair">
        {text('bucket', 's3Source.bucket', { mono: true })}
        {text('region', 's3Source.region', { mono: true })}
      </div>
      {text('prefix', 's3Source.prefix', { hint: 's3Source.prefix.hint', mono: true })}
      <label className="field field--check">
        <input type="checkbox" checked={value.pathStyle ?? false} onChange={(e) => onChange({ ...value, pathStyle: e.target.checked })} />
        <span className="field__label">{t('s3Source.pathStyle')}</span>
        <span className="field__hint">{t('s3Source.pathStyle.hint')}</span>
      </label>
      {text('accessKeyId', 's3Source.accessKey', { mono: true })}
      <label className="field">
        <span className="field__label">{t('s3Source.secretKey')}</span>
        {/* Typed in, sent to the core once, and never shown again: the core only says whether one is stored. */}
        <input
          type="password"
          className="field__input field__input--path"
          value={value.secretAccessKey ?? ''}
          onChange={(e) => onChange({ ...value, secretAccessKey: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
        {stored !== undefined && <span className="field__hint">{t(stored ? 's3Source.secretKey.stored' : 's3Source.secretKey.missing')}</span>}
      </label>
    </>
  )
}

/** Where a Source path is in its bucket, as an `s3://` URL. */
function objectUrl({ bucket, prefix }: S3SourceInfo, path: SourcePath) {
  return `s3://${bucket}/${[prefix, path].filter(Boolean).join('/')}`
}

export const sourceTypeUi: SourceTypeUis = {
  local: {
    label: 'sourceType.local',
    hint: 'sourceType.local.hint',
    Icon: HardDriveIcon,
    blank: () => ({ type: 'local', name: '', rootPath: '', showHidden: true }),
    settingsOf: (source) => ({ type: 'local', name: source.name, rootPath: source.rootPath, showHidden: source.showHidden }),
    fullPath: (source, path) => pathOnDisk(source.rootPath, path),
    Fields: LocalFields
  },
  s3: {
    label: 'sourceType.s3',
    hint: 'sourceType.s3.hint',
    Icon: BucketIcon,
    blank: () => ({ type: 's3', name: '', host: '', bucket: '', prefix: '', region: '', pathStyle: false, accessKeyId: '', secretAccessKey: '' }),
    // Everything but the secret key, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ id: _, environmentId: __, secretKeySet: ___, ...settings }) => ({ ...settings, secretAccessKey: '' }),
    fullPath: objectUrl,
    Fields: S3Fields
  }
}

/**
 * Where a Source points, as a string that changes whenever anything but its name, label or secrets does:
 * a Source whose target changed is a different place, with nothing loaded from the old one carrying over.
 */
export function targetOf(source: SourceInfo) {
  const { id: _, name: __, environmentId: ___, ...settings } = source
  const { secretKeySet: ____, ...target } = settings as typeof settings & { secretKeySet?: boolean }
  return JSON.stringify(Object.entries(target).sort())
}

/** Looks up a Source Type's UI without narrowing on the type first. */
export const uiFor = (type: SourceTypeId) => sourceTypeUi[type] as unknown as SourceTypeUi<NewSource, SourceInfo>
