import { useEffect, useId, useState, type ComponentType } from 'react'
import {
  filesWorkloadKinds,
  type FilesWorkloadKind,
  type KubeContext,
  type KubernetesFilesSourceInfo,
  type NewSource,
  type S3Auth,
  type S3SourceInfo,
  type SourceInfo,
  type SourcePath,
  type SourceTypeId
} from '@shared/core-api'
import { ComboBox } from './components/ComboBox'
import { BucketIcon, HardDriveIcon, KubernetesFilesIcon, KubernetesLogsIcon } from './components/icons'
import { core, describeError } from './core-client'
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
  const check = (key: 'pathStyle' | 'verifyTls', label: MessageKey, hint: MessageKey, fallback: boolean) => (
    <label className="field field--check">
      <input type="checkbox" checked={value[key] ?? fallback} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} />
      <span className="field__label">{t(label)}</span>
      <span className="field__hint">{t(hint)}</span>
    </label>
  )
  // Only a secret stored for keys counts: one signing in with a profile has none.
  const stored = editing?.type === 's3' && editing.auth === 'keys' ? editing.secretKeySet : undefined
  const auth = value.auth ?? 'keys'
  const [weakSecrets, setWeakSecrets] = useState(false)

  useEffect(() => {
    void window.polyscope.secretStorageIsWeak().then(setWeakSecrets)
  }, [])

  const browseCaBundle = async () => {
    const picked = await window.polyscope.pickFile([
      { name: t('s3Source.caBundle.filter'), extensions: ['pem', 'crt', 'cer'] },
      { name: t('s3Source.caBundle.allFiles'), extensions: ['*'] }
    ])
    if (picked) onChange({ ...value, caBundlePath: picked })
  }

  return (
    <>
      {text('host', 's3Source.host', { hint: 's3Source.host.hint', mono: true })}
      <div className="field-pair">
        {text('bucket', 's3Source.bucket', { mono: true })}
        {text('region', 's3Source.region', { mono: true })}
      </div>
      {text('prefix', 's3Source.prefix', { hint: 's3Source.prefix.hint', mono: true })}
      {check('pathStyle', 's3Source.pathStyle', 's3Source.pathStyle.hint', false)}

      <div className="field">
        <span className="field__label" id="s3-auth-label">
          {t('s3Source.auth')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="s3-auth-label">
          {(['keys', 'profile'] as const satisfies S3Auth[]).map((option) => (
            <label key={option} className="segmented__option">
              <input type="radio" name="s3-auth" value={option} checked={auth === option} onChange={() => onChange({ ...value, auth: option })} />
              {t(`s3Source.auth.${option}`)}
            </label>
          ))}
        </div>
      </div>
      {auth === 'keys' ? (
        <>
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
            {stored !== undefined && (
              <span className="field__hint">{t(stored ? 's3Source.secretKey.stored' : 's3Source.secretKey.missing')}</span>
            )}
            {weakSecrets && <span className="field__problem">{t('s3Source.secretKey.weak')}</span>}
          </label>
        </>
      ) : (
        <ProfileField value={value.profile ?? ''} onChange={(profile) => onChange({ ...value, profile })} />
      )}

      <div className="field">
        <label className="field__label" htmlFor="s3-ca-bundle">
          {t('s3Source.caBundle')}
        </label>
        <div className="field__row">
          <input
            id="s3-ca-bundle"
            className="field__input field__input--path"
            value={value.caBundlePath ?? ''}
            onChange={(e) => onChange({ ...value, caBundlePath: e.target.value })}
            spellCheck={false}
          />
          <button type="button" className="button button--quiet" onClick={browseCaBundle}>
            {t('s3Source.browse')}
          </button>
        </div>
        <span className="field__hint">{t('s3Source.caBundle.hint')}</span>
      </div>
      {check('verifyTls', 's3Source.verifyTls', 's3Source.verifyTls.hint', true)}
      {text('proxyUrl', 's3Source.proxy', { hint: 's3Source.proxy.hint', mono: true })}
    </>
  )
}

/** Picks one of the local AWS profiles, or the default credential chain. */
function ProfileField({ value, onChange }: { value: string; onChange(profile: string): void }) {
  const [profiles, setProfiles] = useState<string[]>([])
  useEffect(() => {
    let current = true
    core.listAwsProfiles().then(
      (listed) => current && setProfiles(listed),
      () => undefined
    )
    return () => {
      current = false
    }
  }, [])
  // A profile no longer in the files stays choosable, so opening the dialog doesn't quietly change it.
  const choices = value && !profiles.includes(value) ? [value, ...profiles] : profiles

  return (
    <div className="field">
      <label className="field__label" htmlFor="s3-profile">
        {t('s3Source.profile')}
      </label>
      <select id="s3-profile" className="field__input field__select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('s3Source.profile.default')}</option>
        {choices.map((profile) => (
          <option key={profile} value={profile}>
            {profile}
          </option>
        ))}
      </select>
      <span className="field__hint">{t('s3Source.profile.hint')}</span>
    </div>
  )
}

type KubernetesLogsSettings = Extract<NewSource, { type: 'kubernetesLogs' }>
type KubernetesFilesSettings = Extract<NewSource, { type: 'kubernetesFiles' }>

/** Calls `list` whenever `deps` change, giving what it last listed (null while listing, or with nothing to list) or why it couldn't. */
function useListing<T>(list: () => Promise<T> | null, deps: unknown[]) {
  const [listing, setListing] = useState<{ items: T | null; problem: string | null }>({ items: null, problem: null })
  useEffect(() => {
    const listed = list()
    setListing({ items: null, problem: null })
    if (!listed) return
    let current = true
    listed.then(
      (items) => current && setListing({ items, problem: null }),
      (error) => current && setListing({ items: null, problem: describeError(error) })
    )
    return () => {
      current = false
    }
  }, deps)
  return listing
}

/** A dropdown's choices: those listed, and the current value too if it isn't among them, so opening the dialog doesn't quietly change it. */
const choicesOf = (listed: string[], value: string) => (value && !listed.includes(value) ? [value, ...listed] : listed)

/** A kubeconfig context and a namespace in its cluster, as both Kubernetes Source Types have. */
function ClusterFields<S extends KubernetesLogsSettings | KubernetesFilesSettings>({ value, onChange }: FieldsProps<S>) {
  // Null until the kubeconfig has been read.
  const [contexts, setContexts] = useState<KubeContext[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Only suggestions: a user who may not list namespaces types one in.
  const namespaces = useListing(() => (value.context ? core.listKubeNamespaces(value.context) : null), [value.context])
  const namespaceId = useId()

  /** Picks a context, filling in its namespace (or `default`) unless one was typed already. */
  const pick = (context: string, listed = contexts ?? []) => {
    const namespace = value.namespace.trim() ? value.namespace : (listed.find((c) => c.name === context)?.namespace ?? 'default')
    onChange({ ...value, context, namespace })
  }

  useEffect(() => {
    let current = true
    core.listKubeContexts().then(
      (listed) => {
        if (!current) return
        setContexts(listed)
        // A new Source starts on the kubeconfig's current context, as kubectl would.
        const currentContext = listed.find((c) => c.current)
        if (currentContext && !value.context) pick(currentContext.name, listed)
      },
      (error) => {
        if (!current) return
        setContexts([])
        setProblem(describeError(error))
      }
    )
    return () => {
      current = false
    }
    // Read once, when the fields appear: the settings as they were then are the ones to fill in.
  }, [])

  const choices = choicesOf(contexts?.map((c) => c.name) ?? [], value.context)

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="kubernetes-context">
          {t('kubernetesSource.context')}
        </label>
        <select id="kubernetes-context" className="field__input field__select" value={value.context} onChange={(e) => pick(e.target.value)}>
          {!value.context && <option value="">{t('kubernetesSource.context.choose')}</option>}
          {choices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="field__hint">
          {problem ?? t(contexts?.length === 0 ? 'kubernetesSource.context.none' : 'kubernetesSource.context.hint')}
        </span>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={namespaceId}>
          {t('kubernetesSource.namespace')}
        </label>
        <ComboBox
          id={namespaceId}
          className="field__input--path"
          value={value.namespace}
          options={namespaces.items ?? []}
          onChange={(namespace) => onChange({ ...value, namespace })}
        />
        <span className="field__hint">
          {t(value.type === 'kubernetesFiles' ? 'kubernetesFilesSource.namespace.hint' : 'kubernetesSource.namespace.hint')}
        </span>
      </div>
    </>
  )
}

const KubernetesLogsFields = (props: FieldsProps<KubernetesLogsSettings>) => <ClusterFields {...props} />

/** A Workload's value in the Workload dropdown, which lists every kind: its kind and name. */
const workloadKey = ({ kind, name }: { kind: FilesWorkloadKind; name: string }) => `${kind}/${name}`

function KubernetesFilesFields({ value, onChange }: FieldsProps<KubernetesFilesSettings>) {
  const { context, namespace, workloadKind, workloadName } = value
  const workloads = useListing(() => (context && namespace.trim() ? core.listKubeWorkloads(context, namespace.trim()) : null), [context, namespace])
  const listed = workloads.items ?? []
  const selected = listed.find((workload) => workload.kind === workloadKind && workload.name === workloadName)
  // The chosen Workload stays a choice even when it isn't listed, so opening the dialog doesn't quietly change it.
  const choices = workloadName && !selected ? [{ kind: workloadKind, name: workloadName, mountPaths: [] }, ...listed] : listed
  const workloadHint = workloads.problem ?? (workloads.items?.length === 0 ? t('kubernetesFilesSource.workload.none', { namespace }) : null)
  const pathId = useId()

  return (
    <>
      <ClusterFields value={value} onChange={onChange} />
      {workloads.problem ? (
        // Can't be listed, say for lack of permission: its kind picked and its name typed in instead.
        <div className="field-pair">
          <div className="field">
            <label className="field__label" htmlFor="kubernetes-workload-kind">
              {t('kubernetesFilesSource.workloadKind')}
            </label>
            <select
              id="kubernetes-workload-kind"
              className="field__input field__select"
              value={workloadKind}
              onChange={(e) => onChange({ ...value, workloadKind: e.target.value as FilesWorkloadKind })}
            >
              {filesWorkloadKinds.map((option) => (
                <option key={option} value={option}>
                  {t(`workloadKind.${option}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="kubernetes-workload">
              {t('kubernetesFilesSource.workload')}
            </label>
            <input
              id="kubernetes-workload"
              className="field__input field__input--path"
              value={workloadName}
              onChange={(e) => onChange({ ...value, workloadName: e.target.value })}
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="field">
          <label className="field__label" htmlFor="kubernetes-workload">
            {t('kubernetesFilesSource.workload')}
          </label>
          <select
            id="kubernetes-workload"
            className="field__input field__select"
            value={workloadName ? workloadKey({ kind: workloadKind, name: workloadName }) : ''}
            onChange={(e) => {
              const workload = choices.find((choice) => workloadKey(choice) === e.target.value)
              if (workload) onChange({ ...value, workloadKind: workload.kind, workloadName: workload.name })
            }}
          >
            {!workloadName && (
              <option value="">{t(workloads.items ? 'kubernetesFilesSource.workload.choose' : 'kubernetesFilesSource.workload.loading')}</option>
            )}
            {filesWorkloadKinds.map((kind) => {
              const ofKind = choices.filter((choice) => choice.kind === kind)
              return (
                ofKind.length > 0 && (
                  <optgroup key={kind} label={t(`workloadGroup.${kind}`)}>
                    {ofKind.map((workload) => (
                      <option key={workloadKey(workload)} value={workloadKey(workload)}>
                        {workload.name}
                      </option>
                    ))}
                  </optgroup>
                )
              )
            })}
          </select>
        </div>
      )}
      {workloadHint && <span className="field__hint">{workloadHint}</span>}
      <div className="field">
        <label className="field__label" htmlFor={pathId}>
          {t('kubernetesFilesSource.path')}
        </label>
        {/* Only suggestions: where the Workload's volumes are mounted. Any folder can be typed in. */}
        <ComboBox
          id={pathId}
          className="field__input--path"
          value={value.path}
          placeholder="/var/log"
          options={selected?.mountPaths ?? []}
          onChange={(path) => onChange({ ...value, path })}
        />
        <span className="field__hint">{t('kubernetesFilesSource.path.hint')}</span>
      </div>
    </>
  )
}

/** Where a Source path is in its bucket, as an `s3://` URL. */
function objectUrl({ bucket, prefix }: S3SourceInfo, path: SourcePath) {
  return `s3://${bucket}/${[prefix, path].filter(Boolean).join('/')}`
}

/**
 * Where a Kubernetes Files entry is: its pod, then the rest of its path under the Source's folder. (With several
 * containers, the first segment after the pod is the container's name; the path alone doesn't say which it is.)
 */
function containerPath({ context, namespace, workloadName, path: folder }: KubernetesFilesSourceInfo, path: SourcePath) {
  const [pod, ...rest] = path ? path.split('/') : []
  if (!pod) return `${context}: ${namespace}/${workloadName} ${folder}`
  return `${context}: ${namespace}/${pod} ${[folder === '/' ? '' : folder, ...rest].join('/') || '/'}`
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
    blank: () => ({
      type: 's3',
      name: '',
      host: '',
      bucket: '',
      prefix: '',
      region: '',
      pathStyle: true,
      auth: 'keys',
      accessKeyId: '',
      secretAccessKey: '',
      profile: '',
      verifyTls: true,
      caBundlePath: '',
      proxyUrl: ''
    }),
    // Everything but the secret key, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ id: _, environmentId: __, secretKeySet: ___, ...settings }) => ({ ...settings, secretAccessKey: '' }),
    fullPath: objectUrl,
    Fields: S3Fields
  },
  kubernetesFiles: {
    label: 'sourceType.kubernetesFiles',
    hint: 'sourceType.kubernetesFiles.hint',
    Icon: KubernetesFilesIcon,
    blank: () => ({ type: 'kubernetesFiles', name: '', context: '', namespace: '', workloadKind: 'Deployment', workloadName: '', path: '' }),
    settingsOf: ({ name, context, namespace, workloadKind, workloadName, path }) => ({
      type: 'kubernetesFiles',
      name,
      context,
      namespace,
      workloadKind,
      workloadName,
      path
    }),
    fullPath: containerPath,
    Fields: KubernetesFilesFields
  },
  kubernetesLogs: {
    label: 'sourceType.kubernetesLogs',
    hint: 'sourceType.kubernetesLogs.hint',
    Icon: KubernetesLogsIcon,
    blank: () => ({ type: 'kubernetesLogs', name: '', context: '', namespace: '' }),
    settingsOf: ({ name, context, namespace }) => ({ type: 'kubernetesLogs', name, context, namespace }),
    fullPath: ({ context, namespace }, path) => `${context}: ${namespace}${path ? `/${path}` : ''}`,
    Fields: KubernetesLogsFields
  }
}

/**
 * Where a Source points, as a string that changes whenever anything but its name, label, secrets or remembered
 * view choices does: a Source whose target changed is a different place, with nothing loaded from the old one carrying over.
 */
export function targetOf(source: SourceInfo) {
  const { id: _, name: __, environmentId: ___, lastNLines: _____, ...settings } = source
  const { secretKeySet: ____, ...target } = settings as typeof settings & { secretKeySet?: boolean }
  return JSON.stringify(Object.entries(target).sort())
}

/** Looks up a Source Type's UI without narrowing on the type first. */
export const uiFor = (type: SourceTypeId) => sourceTypeUi[type] as unknown as SourceTypeUi<NewSource, SourceInfo>
