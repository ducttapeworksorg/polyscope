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
