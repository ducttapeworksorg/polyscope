import { useEffect, useId, useState, type ComponentType } from 'react'
import {
  cloudWatchNameOf,
  defaultAwsAuth,
  defaultDockerContext,
  dockerStandaloneGroup,
  filesWorkloadKinds,
  type AwsAuth,
  type AzureBlobAuth,
  type AzureBlobSourceInfo,
  type CloudWatchLogsSourceInfo,
  type DockerLogsSourceInfo,
  type FilesWorkloadKind,
  type KubeContext,
  type KubernetesFilesSourceInfo,
  type NewSource,
  type S3SourceInfo,
  type SourceInfo,
  type SourcePath,
  type SourceTypeId,
  type SshAuth,
  type SshFilesSourceInfo,
  type SystemdJournalSourceInfo
} from '@shared/core-api'
import { awsRegions } from '@shared/aws-regions'
import { parseSas } from '@shared/azure-sas'
import { ComboBox } from './components/ComboBox'
import {
  BlobStorageIcon,
  BucketIcon,
  CloudWatchLogsIcon,
  DockerLogsIcon,
  HardDriveIcon,
  KubernetesFilesIcon,
  KubernetesLogsIcon,
  SystemdJournalIcon,
  TerminalIcon
} from './components/icons'
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

/**
 * A Source's name as the setting it's named after changes `from` one value `to` another: filled in while it's blank,
 * kept in step while it's still what was filled in, and left alone once typed.
 */
const nameFollowing = (name: string, from: string, to: string) => (!name.trim() || name === from ? to : name)

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

type SshSettings = Extract<NewSource, { type: 'sshFiles' }>

/** The name an SSH Files Source is given from its host and path, like `web-1:/var/log`. */
const sshName = ({ host, path }: Pick<SshSettings, 'host' | 'path'>) => [host.trim(), path.trim()].filter(Boolean).join(':')

function SshFields({ value, onChange, editing }: FieldsProps<SshSettings>) {
  // A new Source is named after its host and path.
  const set = (changes: Partial<SshSettings>) => {
    const next = { ...value, ...changes }
    onChange({ ...next, name: nameFollowing(value.name, sshName(value), sshName(next)) })
  }
  const text = (key: 'user' | 'path', label: MessageKey, hint?: MessageKey, placeholder?: string) => (
    <label className="field">
      <span className="field__label">{t(label)}</span>
      <input
        className="field__input field__input--path"
        value={value[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        placeholder={placeholder}
        spellCheck={false}
      />
      {hint && <span className="field__hint">{t(hint)}</span>}
    </label>
  )
  // Only suggestions: any host can be typed in. What ~/.ssh/config says about an alias shows where it's left blank.
  const sshHosts = useListing(() => core.listSshHosts(), [])
  const configured = sshHosts.items?.find((h) => h.alias === value.host.trim())
  const hostId = useId()

  return (
    <>
      <div className="field-pair">
        <div className="field">
          <label className="field__label" htmlFor={hostId}>
            {t('sshSource.host')}
          </label>
          <ComboBox
            id={hostId}
            className="field__input--path"
            value={value.host}
            options={sshHosts.items?.map((h) => h.alias) ?? []}
            onChange={(host) => set({ host })}
          />
          <span className="field__hint">{t('sshSource.host.hint')}</span>
        </div>
        <label className="field">
          <span className="field__label">{t('sshSource.port')}</span>
          {/* Blank is the SSH config's port, or 22; anything that isn't a port is the core's to refuse. */}
          <input
            className="field__input field__input--path"
            inputMode="numeric"
            placeholder={String(configured?.port ?? 22)}
            value={value.port === undefined ? '' : String(value.port)}
            onChange={(e) => onChange({ ...value, ...(e.target.value.trim() ? { port: Number(e.target.value) } : { port: undefined }) })}
            spellCheck={false}
          />
        </label>
      </div>
      {text('user', 'sshSource.user', 'sshSource.user.hint', configured?.user)}
      {text('path', 'sshSource.path', 'sshSource.path.hint')}
      <SshSignInFields value={value} onChange={onChange} editing={editing} />
    </>
  )
}

/** How a Source signs in over SSH, as an SSH Files Source does, or a Docker Logs Source to an `ssh://` context's host. */
type SshSignInSettings = Extract<NewSource, { type: 'sshFiles' | 'dockerLogs' }>

/** The way a Source signs in over SSH: through the agent, with a key file and its passphrase, or with a password. */
function SshSignInFields<S extends SshSignInSettings>({ value, onChange, editing }: FieldsProps<S>) {
  const auth = value.auth ?? (value.type === 'sshFiles' ? 'keyFile' : 'agent')
  // Only a secret stored for the way it signs in counts.
  const signsInSame = (editing?.type === 'sshFiles' || editing?.type === 'dockerLogs') && editing.auth === auth
  const stored = signsInSame && (auth === 'password' ? editing.passwordSet : editing.passphraseSet)
  const [weakSecrets, setWeakSecrets] = useState(false)

  useEffect(() => {
    void window.polyscope.secretStorageIsWeak().then(setWeakSecrets)
  }, [])

  return (
    <>
      <div className="field">
        <span className="field__label" id="ssh-auth-label">
          {t('sshSource.auth')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="ssh-auth-label">
          {(['agent', 'keyFile', 'password'] as const satisfies SshAuth[]).map((option) => (
            <label key={option} className="segmented__option">
              <input type="radio" name="ssh-auth" value={option} checked={auth === option} onChange={() => onChange({ ...value, auth: option })} />
              {t(`sshSource.auth.${option}`)}
            </label>
          ))}
        </div>
        {auth === 'agent' && <span className="field__hint">{t('sshSource.agent.hint')}</span>}
      </div>
      {auth === 'keyFile' && <KeyFileFields value={value} onChange={onChange} stored={stored} weakSecrets={weakSecrets} />}
      {auth === 'password' && (
        <label className="field">
          <span className="field__label">{t('sshSource.password')}</span>
          {/* Typed in, sent to the core once, and never shown again: the core only says whether one is stored. */}
          <input
            type="password"
            className="field__input field__input--path"
            value={value.password ?? ''}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          {editing && <span className="field__hint">{t(stored ? 'sshSource.password.stored' : 'sshSource.password.missing')}</span>}
          {weakSecrets && <span className="field__problem">{t('sshSource.password.weak')}</span>}
        </label>
      )}
    </>
  )
}

/** The key file that signs in, and its passphrase if it's encrypted. */
function KeyFileFields<S extends SshSignInSettings>({
  value,
  onChange,
  stored,
  weakSecrets
}: {
  value: S
  onChange(value: S): void
  stored: boolean
  weakSecrets: boolean
}) {
  const browseKeyFile = async () => {
    // Key files have no extension of their own to filter by.
    const picked = await window.polyscope.pickFile([{ name: t('sshSource.keyFile.allFiles'), extensions: ['*'] }])
    if (picked) onChange({ ...value, keyFile: picked })
  }

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="ssh-key-file">
          {t('sshSource.keyFile')}
        </label>
        <div className="field__row">
          <input
            id="ssh-key-file"
            className="field__input field__input--path"
            value={value.keyFile ?? ''}
            onChange={(e) => onChange({ ...value, keyFile: e.target.value })}
            spellCheck={false}
          />
          <button type="button" className="button button--quiet" onClick={browseKeyFile}>
            {t('sshSource.browse')}
          </button>
        </div>
        <span className="field__hint">{t('sshSource.keyFile.hint')}</span>
      </div>
      <label className="field">
        <span className="field__label">{t('sshSource.passphrase')}</span>
        {/* Typed in, sent to the core once, and never shown again: the core only says whether one is stored. */}
        <input
          type="password"
          className="field__input field__input--path"
          value={value.passphrase ?? ''}
          onChange={(e) => onChange({ ...value, passphrase: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">{t(stored ? 'sshSource.passphrase.stored' : 'sshSource.passphrase.hint')}</span>
        {weakSecrets && <span className="field__problem">{t('sshSource.passphrase.weak')}</span>}
      </label>
    </>
  )
}

/** Where a Source path is on its server, as scp would put it: `user@host:/path`, or `host:/path` if the user is the SSH config's. */
function remotePath({ user, host, path: folder }: SshFilesSourceInfo, path: SourcePath) {
  return `${user ? `${user}@` : ''}${host}:${path ? `${folder === '/' ? '' : folder}/${path}` : folder}`
}

/** A PEM file of CA certificates for a Source to trust as well as the OS's own, typed or picked. */
function CaBundleField({ value, onChange }: { value: string; onChange(path: string): void }) {
  const id = useId()
  const browse = async () => {
    const picked = await window.polyscope.pickFile([
      { name: t('network.caBundle.filter'), extensions: ['pem', 'crt', 'cer'] },
      { name: t('network.caBundle.allFiles'), extensions: ['*'] }
    ])
    if (picked) onChange(picked)
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t('network.caBundle')}
      </label>
      <div className="field__row">
        <input id={id} className="field__input field__input--path" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        <button type="button" className="button button--quiet" onClick={browse}>
          {t('network.browse')}
        </button>
      </div>
      <span className="field__hint">{t('network.caBundle.hint')}</span>
    </div>
  )
}

/** A proxy for a Source's requests alone; blank for HTTPS_PROXY and NO_PROXY to decide. */
function ProxyField({ value, onChange }: { value: string; onChange(proxyUrl: string): void }) {
  return (
    <label className="field">
      <span className="field__label">{t('network.proxy')}</span>
      <input className="field__input field__input--path" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <span className="field__hint">{t('network.proxy.hint')}</span>
    </label>
  )
}

type S3Settings = Extract<NewSource, { type: 's3' }>

function S3Fields({ value, onChange, editing }: FieldsProps<S3Settings>) {
  // A new Source is named after its bucket.
  const set = (key: keyof S3Settings, input: string) =>
    onChange(key === 'bucket' ? { ...value, bucket: input, name: nameFollowing(value.name, value.bucket, input) } : { ...value, [key]: input })
  const text = (key: keyof S3Settings, label: MessageKey, { hint, mono = false }: { hint?: MessageKey; mono?: boolean } = {}) => (
    <label className="field">
      <span className="field__label">{t(label)}</span>
      <input
        className={`field__input ${mono ? 'field__input--path' : ''}`}
        value={String(value[key] ?? '')}
        onChange={(e) => set(key, e.target.value)}
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
  return (
    <>
      {text('host', 's3Source.host', { hint: 's3Source.host.hint', mono: true })}
      <div className="field-pair">
        {text('bucket', 's3Source.bucket', { mono: true })}
        {text('region', 's3Source.region', { mono: true })}
      </div>
      {text('prefix', 's3Source.prefix', { hint: 's3Source.prefix.hint', mono: true })}
      {check('pathStyle', 's3Source.pathStyle', 's3Source.pathStyle.hint', false)}

      <AwsSignInFields value={value} onChange={onChange} editing={editing} />

      <CaBundleField value={value.caBundlePath ?? ''} onChange={(caBundlePath) => onChange({ ...value, caBundlePath })} />
      {check('verifyTls', 's3Source.verifyTls', 's3Source.verifyTls.hint', true)}
      <ProxyField value={value.proxyUrl ?? ''} onChange={(proxyUrl) => onChange({ ...value, proxyUrl })} />
    </>
  )
}

/** The settings of a Source on AWS, which signs in as an S3 Source does. */
type AwsSettings = Extract<NewSource, { type: 's3' | 'cloudwatchLogs' }>

/** How a Source on AWS signs in. */
const awsAuthOf = (value: AwsSettings): AwsAuth => value.auth ?? defaultAwsAuth(value.type)

/** The way a Source on AWS signs in: typed keys, the secret one kept in the OS's secure storage, or an AWS profile. */
function AwsSignInFields<S extends AwsSettings>({ value, onChange, editing }: FieldsProps<S>) {
  const auth = awsAuthOf(value)
  // Only a secret stored for keys counts: one signing in with a profile has none.
  const stored = (editing?.type === 's3' || editing?.type === 'cloudwatchLogs') && editing.auth === 'keys' ? editing.secretKeySet : undefined
  const [weakSecrets, setWeakSecrets] = useState(false)

  useEffect(() => {
    void window.polyscope.secretStorageIsWeak().then(setWeakSecrets)
  }, [])

  return (
    <>
      <div className="field">
        <span className="field__label" id="aws-auth-label">
          {t('awsSource.auth')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="aws-auth-label">
          {(['keys', 'profile'] as const satisfies AwsAuth[]).map((option) => (
            <label key={option} className="segmented__option">
              <input type="radio" name="aws-auth" value={option} checked={auth === option} onChange={() => onChange({ ...value, auth: option })} />
              {t(`awsSource.auth.${option}`)}
            </label>
          ))}
        </div>
      </div>
      {auth === 'keys' ? (
        <>
          <label className="field">
            <span className="field__label">{t('awsSource.accessKey')}</span>
            <input
              className="field__input field__input--path"
              value={value.accessKeyId ?? ''}
              onChange={(e) => onChange({ ...value, accessKeyId: e.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('awsSource.secretKey')}</span>
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
              <span className="field__hint">{t(stored ? 'awsSource.secretKey.stored' : 'awsSource.secretKey.missing')}</span>
            )}
            {weakSecrets && <span className="field__problem">{t('awsSource.secretKey.weak')}</span>}
          </label>
        </>
      ) : (
        <ProfileField value={value.profile ?? ''} onChange={(profile) => onChange({ ...value, profile })} />
      )}
    </>
  )
}

type CloudWatchLogsSettings = Extract<NewSource, { type: 'cloudwatchLogs' }>

/** The name a CloudWatch Logs Source is given from its region and prefix, like `eu-west-1 /aws/lambda/orders-`. */
const cloudWatchName = ({ region, prefix }: Pick<CloudWatchLogsSettings, 'region' | 'prefix'>) =>
  [region.trim(), prefix?.trim() ?? ''].filter(Boolean).join(' ')

function CloudWatchLogsFields({ value, onChange, editing }: FieldsProps<CloudWatchLogsSettings>) {
  // A new Source is named after its region and prefix.
  const set = (changes: Partial<CloudWatchLogsSettings>) => {
    const next = { ...value, ...changes }
    onChange({ ...next, name: nameFollowing(value.name, cloudWatchName(value), cloudWatchName(next)) })
  }
  // The region the profile names: signing in with keys, the default credential chain's.
  const signInProfile = awsAuthOf(value) === 'profile' ? (value.profile ?? '') : ''
  const profileRegion = useListing(() => core.awsProfileRegion(signInProfile), [signInProfile])
  // The region last filled in from a profile: until another is chosen, the region follows the profile.
  const [filledIn, setFilledIn] = useState<string>()
  useEffect(() => {
    const region = profileRegion.items
    if (region === null) return
    if (region && (!value.region || value.region === filledIn)) set({ region })
    setFilledIn(region)
    // Filled in whenever the profile's region is read, from the settings as they are then.
  }, [profileRegion.items])
  const regionId = useId()

  return (
    <>
      <AwsSignInFields value={value} onChange={onChange} editing={editing} />
      <div className="field">
        <label className="field__label" htmlFor={regionId}>
          {t('cloudwatchSource.region')}
        </label>
        <select id={regionId} className="field__input field__select" value={value.region} onChange={(e) => set({ region: e.target.value })}>
          {!value.region && <option value="">{t('cloudwatchSource.region.choose')}</option>}
          {choicesOf([...awsRegions], value.region).map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
        {profileRegion.items !== null && (
          <span className="field__hint">
            {profileRegion.items ? t('cloudwatchSource.region.hint', { region: profileRegion.items }) : t('cloudwatchSource.region.none')}
          </span>
        )}
      </div>
      <label className="field">
        <span className="field__label">{t('cloudwatchSource.prefix')}</span>
        <input
          className="field__input field__input--path"
          value={value.prefix ?? ''}
          placeholder="/aws/lambda/"
          onChange={(e) => set({ prefix: e.target.value })}
          spellCheck={false}
        />
        <span className="field__hint">{t('cloudwatchSource.prefix.hint')}</span>
      </label>
      <label className="field">
        <span className="field__label">{t('cloudwatchSource.endpoint')}</span>
        <input
          className="field__input field__input--path"
          value={value.endpoint ?? ''}
          onChange={(e) => onChange({ ...value, endpoint: e.target.value })}
          spellCheck={false}
        />
        <span className="field__hint">{t('cloudwatchSource.endpoint.hint')}</span>
      </label>
      <CaBundleField value={value.caBundlePath ?? ''} onChange={(caBundlePath) => onChange({ ...value, caBundlePath })} />
      <ProxyField value={value.proxyUrl ?? ''} onChange={(proxyUrl) => onChange({ ...value, proxyUrl })} />
    </>
  )
}

/** Where a CloudWatch Logs Source's node is: its region, then its log group's name and its stream's. */
function regionPath({ region, prefix }: CloudWatchLogsSourceInfo, path: SourcePath) {
  const [group, stream] = path ? path.split('/').map(cloudWatchNameOf) : []
  if (!group) return prefix ? `${region}: ${prefix}…` : region
  return `${region}: ${group}${stream ? ` ${stream}` : ''}`
}

type AzureBlobSettings = Extract<NewSource, { type: 'azureBlob' }>

/** The name an Azure Blob Storage Source is given from its account and container, like `contosologs/app`. */
const azureBlobName = ({ account, container }: Pick<AzureBlobSettings, 'account' | 'container'>) =>
  [account.trim(), container.trim()].filter(Boolean).join('/')

function AzureBlobFields({ value, onChange, editing }: FieldsProps<AzureBlobSettings>) {
  // A new Source is named after its account and container.
  const set = (changes: Partial<AzureBlobSettings>) => {
    const next = { ...value, ...changes }
    onChange({ ...next, name: nameFollowing(value.name, azureBlobName(value), azureBlobName(next)) })
  }
  const text = (key: 'account' | 'container' | 'prefix' | 'endpoint', label: MessageKey, hint?: MessageKey) => (
    <label className="field">
      <span className="field__label">{t(label)}</span>
      <input className="field__input field__input--path" value={value[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} spellCheck={false} />
      {hint && <span className="field__hint">{t(hint)}</span>}
    </label>
  )
  const auth = value.auth ?? 'connectionString'
  // Only a secret stored for the way the Source signed in when it was saved counts.
  const storedFor = (way: AzureBlobAuth) => (editing?.type === 'azureBlob' && editing.auth === way ? editing[way === 'sas' ? 'sasSet' : 'connectionStringSet'] : undefined)
  const [weakSecrets, setWeakSecrets] = useState(false)

  useEffect(() => {
    void window.polyscope.secretStorageIsWeak().then(setWeakSecrets)
  }, [])

  // A pasted SAS URL says which account and container it's for, so they needn't be typed again.
  const setSas = (sas: string) => {
    const parsed = parseSas(sas)
    set({ sas, ...(parsed?.account && { account: parsed.account }), ...(parsed?.container && { container: parsed.container }) })
  }

  /** A secret's field: typed in, sent to the core once, and never shown again; the core only says whether one is stored. */
  const secret = (key: 'connectionString' | 'sas', onInput: (text: string) => void) => {
    const stored = storedFor(key)
    return (
      <label className="field">
        <span className="field__label">{t(`azureBlobSource.${key}`)}</span>
        <input
          type="password"
          className="field__input field__input--path"
          value={value[key] ?? ''}
          onChange={(e) => onInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">
          {t(stored === undefined ? `azureBlobSource.${key}.hint` : stored ? 'azureBlobSource.secret.stored' : `azureBlobSource.${key}.missing`)}
        </span>
        {weakSecrets && <span className="field__problem">{t('azureBlobSource.secret.weak')}</span>}
      </label>
    )
  }

  return (
    <>
      <div className="field">
        <span className="field__label" id="azure-blob-auth-label">
          {t('azureBlobSource.auth')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="azure-blob-auth-label">
          {(['connectionString', 'sas', 'azureCli'] as const satisfies AzureBlobAuth[]).map((option) => (
            <label key={option} className="segmented__option">
              <input type="radio" name="azure-blob-auth" value={option} checked={auth === option} onChange={() => onChange({ ...value, auth: option })} />
              {t(`azureBlobSource.auth.${option}`)}
            </label>
          ))}
        </div>
      </div>
      {auth === 'connectionString' && secret('connectionString', (connectionString) => onChange({ ...value, connectionString }))}
      {auth === 'sas' && secret('sas', setSas)}
      {auth === 'azureCli' && <p className="field__hint">{t('azureBlobSource.azureCli.hint')}</p>}
      <div className="field-pair">
        {text('account', 'azureBlobSource.account')}
        {text('container', 'azureBlobSource.container')}
      </div>
      {text('prefix', 'azureBlobSource.prefix', 'azureBlobSource.prefix.hint')}
      {/* A connection string says where the account's endpoint is itself. */}
      {auth !== 'connectionString' && text('endpoint', 'azureBlobSource.endpoint', 'azureBlobSource.endpoint.hint')}
      <CaBundleField value={value.caBundlePath ?? ''} onChange={(caBundlePath) => onChange({ ...value, caBundlePath })} />
      <ProxyField value={value.proxyUrl ?? ''} onChange={(proxyUrl) => onChange({ ...value, proxyUrl })} />
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
      <label className="field__label" htmlFor="aws-profile">
        {t('awsSource.profile')}
      </label>
      <select id="aws-profile" className="field__input field__select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('awsSource.profile.default')}</option>
        {choices.map((profile) => (
          <option key={profile} value={profile}>
            {profile}
          </option>
        ))}
      </select>
      <span className="field__hint">{t('awsSource.profile.hint')}</span>
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

  /** The namespace a context fills in: its own, or `default`. */
  const namespaceOf = (context: string, listed: KubeContext[]) => listed.find((c) => c.name === context)?.namespace ?? 'default'

  /** The settings with `namespace` in them: a new Log Source is named after its namespace, a Files Source after its Workload. */
  const withNamespace = (settings: S, namespace: string): S => ({
    ...settings,
    namespace,
    name: settings.type === 'kubernetesLogs' ? nameFollowing(settings.name, settings.namespace, namespace) : settings.name
  })

  /** Picks a context, filling in its namespace unless the one there was typed rather than filled in from the last context. */
  const pick = (context: string, listed = contexts ?? []) => {
    const typed = value.namespace.trim() && value.namespace !== namespaceOf(value.context, listed)
    onChange(withNamespace({ ...value, context }, typed ? value.namespace : namespaceOf(context, listed)))
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
          onChange={(namespace) => onChange(withNamespace(value, namespace))}
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
  // A new Source is named after its Workload.
  const withWorkload = (kind: FilesWorkloadKind, name: string) =>
    onChange({ ...value, workloadKind: kind, workloadName: name, name: nameFollowing(value.name, workloadName, name) })

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
              onChange={(e) => withWorkload(workloadKind, e.target.value)}
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
              if (workload) withWorkload(workload.kind, workload.name)
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

type DockerLogsSettings = Extract<NewSource, { type: 'dockerLogs' }>

/** The name a Docker Logs Source is given from its context: Docker, for the default one. */
const dockerName = (context: string) => (context === defaultDockerContext ? t('dockerSource.defaultName') : context)

function DockerLogsFields({ value, onChange, editing }: FieldsProps<DockerLogsSettings>) {
  const context = value.context || defaultDockerContext
  const contexts = useListing(() => core.listDockerContexts(), [])
  const listed = contexts.items ?? []
  // A context no longer in the CLI's config stays a choice, so opening the dialog doesn't quietly change it.
  const choices = choicesOf(
    listed.map((c) => c.name).filter((name) => name !== defaultDockerContext),
    context === defaultDockerContext ? '' : context
  )
  const chosen = listed.find((c) => c.name === context)
  const current = listed.find((c) => c.current)
  // Signing in only matters to an engine reached over SSH: the context's, or for the default, the current one's.
  const overSsh = (context === defaultDockerContext ? current : chosen)?.host.startsWith('ssh://') ?? false
  // A new Source is named after its context.
  useEffect(() => {
    if (!value.name.trim()) onChange({ ...value, name: dockerName(context) })
    // Named once, when the fields appear.
  }, [])

  const pick = (picked: string) => onChange({ ...value, context: picked, name: nameFollowing(value.name, dockerName(context), dockerName(picked)) })

  const hint =
    contexts.problem ??
    (context === defaultDockerContext
      ? t(current ? 'dockerSource.context.default.current' : 'dockerSource.context.hint', { context: current?.name ?? '' })
      : chosen
        ? t('dockerSource.context.host', { host: chosen.host })
        : contexts.items && t('dockerSource.context.missing'))

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="docker-context">
          {t('dockerSource.context')}
        </label>
        <select id="docker-context" className="field__input field__select" value={context} onChange={(e) => pick(e.target.value)}>
          <option value={defaultDockerContext}>{t('dockerSource.context.default')}</option>
          {choices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="field__hint">{hint}</span>
      </div>
      {overSsh && <SshSignInFields value={value} onChange={onChange} editing={editing} />}
    </>
  )
}

/** Where a Docker Logs Source's node is: its context, then its container's name, which is how `docker logs` knows it. */
function enginePath({ context }: DockerLogsSourceInfo, path: SourcePath) {
  if (!path) return context
  if (path === dockerStandaloneGroup) return `${context}: ${t('dockerGroup.standalone')}`
  const segments = path.split('/')
  return `${context}: ${segments[0] === dockerStandaloneGroup || segments.length === 3 ? segments.at(-1) : path}`
}

type SystemdJournalSettings = Extract<NewSource, { type: 'systemdJournal' }>

/** Whose journal a systemd Journal Source reads: so far only this machine's, which is only offered on Linux. */
function SystemdJournalFields({ value, onChange }: FieldsProps<SystemdJournalSettings>) {
  // A new Source is named after its target.
  useEffect(() => {
    if (!value.name.trim()) onChange({ ...value, name: t('journalSource.defaultName') })
    // Named once, when the fields appear.
  }, [])

  return (
    <div className="field">
      <span className="field__label" id="journal-target-label">
        {t('journalSource.target')}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby="journal-target-label">
        <label className="segmented__option">
          <input type="radio" name="journal-target" value="thisMachine" checked onChange={() => onChange({ ...value, target: 'thisMachine' })} />
          {t('journalSource.target.thisMachine')}
        </label>
      </div>
      <span className="field__hint">{t('journalSource.target.thisMachine.hint')}</span>
    </div>
  )
}

/** Where a systemd Journal Source's unit is: its machine, then the unit's name, which is how journalctl knows it. */
function unitPath(_source: SystemdJournalSourceInfo, path: SourcePath) {
  const machine = t('journalSource.target.thisMachine')
  return path ? `${machine}: ${path}` : machine
}

/** Where a Source path is in its bucket, as an `s3://` URL. */
function objectUrl({ bucket, prefix }: S3SourceInfo, path: SourcePath) {
  return `s3://${bucket}/${[prefix, path].filter(Boolean).join('/')}`
}

/** Where a Source path is: its account and container, then the blob's name. */
function blobPath({ account, container, prefix }: AzureBlobSourceInfo, path: SourcePath) {
  return [account, container, prefix, path].filter(Boolean).join('/')
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
  sshFiles: {
    label: 'sourceType.sshFiles',
    hint: 'sourceType.sshFiles.hint',
    Icon: TerminalIcon,
    // The agent first: it signs in without Polyscope holding a key or password.
    blank: () => ({ type: 'sshFiles', name: '', host: '', user: '', path: '', auth: 'agent', keyFile: '', passphrase: '', password: '' }),
    // Everything but the passphrase or password, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ name, host, port, user, path, auth, keyFile }) => ({
      type: 'sshFiles',
      name,
      host,
      ...(port !== undefined && { port }),
      user,
      path,
      auth,
      keyFile,
      passphrase: '',
      password: ''
    }),
    fullPath: remotePath,
    Fields: SshFields
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
  azureBlob: {
    label: 'sourceType.azureBlob',
    hint: 'sourceType.azureBlob.hint',
    Icon: BlobStorageIcon,
    blank: () => ({
      type: 'azureBlob',
      name: '',
      account: '',
      container: '',
      prefix: '',
      endpoint: '',
      auth: 'connectionString',
      connectionString: '',
      sas: '',
      caBundlePath: '',
      proxyUrl: ''
    }),
    // Everything but the connection string or SAS, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ name, account, container, prefix, endpoint, auth, caBundlePath, proxyUrl }) => ({
      type: 'azureBlob',
      name,
      account,
      container,
      prefix,
      endpoint,
      auth,
      connectionString: '',
      sas: '',
      caBundlePath,
      proxyUrl
    }),
    fullPath: blobPath,
    Fields: AzureBlobFields
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
  },
  dockerLogs: {
    label: 'sourceType.dockerLogs',
    hint: 'sourceType.dockerLogs.hint',
    Icon: DockerLogsIcon,
    // As for SSH Files, the agent first, for an ssh:// context.
    blank: () => ({ type: 'dockerLogs', name: '', context: defaultDockerContext, auth: 'agent', keyFile: '', passphrase: '', password: '' }),
    // Everything but the passphrase or password, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ name, context, auth, keyFile }) => ({ type: 'dockerLogs', name, context, auth, keyFile, passphrase: '', password: '' }),
    fullPath: enginePath,
    Fields: DockerLogsFields
  },
  cloudwatchLogs: {
    label: 'sourceType.cloudwatchLogs',
    hint: 'sourceType.cloudwatchLogs.hint',
    Icon: CloudWatchLogsIcon,
    // A profile first: most who read CloudWatch already sign in to AWS with one, SSO ones included.
    blank: () => ({
      type: 'cloudwatchLogs',
      name: '',
      region: '',
      prefix: '',
      auth: 'profile',
      accessKeyId: '',
      secretAccessKey: '',
      profile: '',
      endpoint: '',
      caBundlePath: '',
      proxyUrl: ''
    }),
    // Everything but the secret key, which the renderer never has: left blank, the stored one stays.
    settingsOf: ({ name, region, prefix, auth, accessKeyId, profile, endpoint, caBundlePath, proxyUrl }) => ({
      type: 'cloudwatchLogs',
      name,
      region,
      prefix,
      auth,
      accessKeyId,
      secretAccessKey: '',
      profile,
      endpoint,
      caBundlePath,
      proxyUrl
    }),
    fullPath: regionPath,
    Fields: CloudWatchLogsFields
  },
  systemdJournal: {
    label: 'sourceType.systemdJournal',
    hint: 'sourceType.systemdJournal.hint',
    Icon: SystemdJournalIcon,
    blank: () => ({ type: 'systemdJournal', name: '', target: 'thisMachine' }),
    settingsOf: ({ name, target }) => ({ type: 'systemdJournal', name, target }),
    fullPath: unitPath,
    Fields: SystemdJournalFields
  }
}

/**
 * Whether a Source Type can be added where the core runs (`platform`, as Node names it, or undefined while it isn't
 * known): systemd Journal only once it's known to be Linux.
 */
export const offeredOn = (type: SourceTypeId, platform: string | undefined) => type !== 'systemdJournal' || platform === 'linux'

/**
 * Where a Source points, as a string that changes whenever anything but its name, label, secrets or remembered
 * view choices does: a Source whose target changed is a different place, with nothing loaded from the old one carrying over.
 */
export function targetOf(source: SourceInfo) {
  const { id: _, name: __, environmentId: ___, lastNLines: _____, ...settings } = source
  // Whether a secret is stored (`secretKeySet`, `passwordSet`…) isn't where it points.
  return JSON.stringify(Object.entries(settings).filter(([key]) => !key.endsWith('Set')).sort())
}

/** Looks up a Source Type's UI without narrowing on the type first. */
export const uiFor = (type: SourceTypeId) => sourceTypeUi[type] as unknown as SourceTypeUi<NewSource, SourceInfo>
