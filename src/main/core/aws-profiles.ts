import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Where the AWS CLI and SDKs look for them, unless told otherwise.
const configFile = () => process.env['AWS_CONFIG_FILE'] || join(homedir(), '.aws', 'config')
const credentialsFile = () => process.env['AWS_SHARED_CREDENTIALS_FILE'] || join(homedir(), '.aws', 'credentials')

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** An INI file's section names, spaces tidied: `[ profile  work ]` is `profile work`. */
const sectionsIn = (text: string) => [...text.matchAll(/^\s*\[([^\]\r\n]*)\]/gm)].map(([, name = '']) => name.trim().replace(/\s+/g, ' '))

const readIfThere = (file: string) => readFile(file, 'utf8').catch(() => '')

/** The profiles in the local AWS config and credentials files, by name, `default` first. */
export async function listAwsProfiles(): Promise<string[]> {
  const [config, credentials] = await Promise.all([readIfThere(configFile()), readIfThere(credentialsFile())])
  // The config file names its profiles `profile <name>` (bar `default`), among other kinds of section like
  // `sso-session <name>`; the credentials file holds nothing but profiles, named plainly.
  const fromConfig = sectionsIn(config).flatMap((section) =>
    section === 'default' ? [section] : section.startsWith('profile ') ? [section.slice('profile '.length)] : []
  )
  const names = new Set([...fromConfig, ...sectionsIn(credentials)].filter(Boolean))
  return [...names].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : byName.compare(a, b)))
}

/** The `key = value` settings of an INI file's section, by section name (spaces tidied, as sectionsIn tidies them). */
function settingsIn(text: string) {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line)
    if (section) {
      const name = section[1]!.trim().replace(/\s+/g, ' ')
      if (!sections.has(name)) sections.set(name, new Map())
      current = sections.get(name)
      continue
    }
    // Indented lines carry on a nested setting (an `s3 =` block's), not one of the profile's own.
    const setting = /^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (setting && current) current.set(setting[1]!.toLowerCase(), setting[2]!)
  }
  return sections
}

/**
 * The region a profile names in the local AWS config (or, failing that, credentials) file; for blank, AWS_REGION's or
 * AWS_DEFAULT_REGION's, or else AWS_PROFILE's or the default profile's, as the AWS CLI goes about it. Blank if none does.
 */
export async function awsProfileRegion(profile: string): Promise<string> {
  const fromEnv = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION']
  if (!profile && fromEnv) return fromEnv
  const name = profile || process.env['AWS_PROFILE'] || 'default'
  const [config, credentials] = await Promise.all([readIfThere(configFile()), readIfThere(credentialsFile())])
  const inConfig = settingsIn(config).get(name === 'default' ? name : `profile ${name}`)?.get('region')
  return inConfig ?? settingsIn(credentials).get(name)?.get('region') ?? ''
}
