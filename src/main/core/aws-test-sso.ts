// Test support: AWS profiles signing in through IAM Identity Center (SSO) whose sessions have ended, as they are once
// `aws sso login` was run too long ago, or never. The SDK fails them before asking AWS for anything.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const startUrl = 'https://example.awsapps.com/start'

/**
 * AWS config naming two SSO profiles: `expired`, whose cached session ended an hour ago, and `signed-out`, of an
 * `sso-session` with nothing cached. The cache is in `home`'s `.aws/sso/cache`, where the SDK looks once HOME is `home`.
 */
export async function ssoProfiles(home: string) {
  const cache = join(home, '.aws', 'sso', 'cache')
  await mkdir(cache, { recursive: true })
  // The SDK names a session's cache file after the SHA-1 of its start URL (or, for an sso-session, of its name).
  const cacheFile = join(cache, `${createHash('sha1').update(startUrl).digest('hex')}.json`)
  await writeFile(cacheFile, JSON.stringify({ startUrl, region: 'eu-west-1', accessToken: 'expired', expiresAt: new Date(Date.now() - 3_600_000).toISOString() }))
  const role = 'sso_account_id = 123456789012\nsso_role_name = ReadLogs\nregion = eu-west-1\n'
  return [
    `[profile expired]\nsso_start_url = ${startUrl}\nsso_region = eu-west-1\n${role}`,
    `[profile signed-out]\nsso_session = corp\n${role}`,
    `[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = eu-west-1\nsso_registration_scopes = sso:account:access\n`
  ].join('\n')
}
