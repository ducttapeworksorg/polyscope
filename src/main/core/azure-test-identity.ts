// Test support: stand-ins for what Azure's default credential chain signs in through. The managed identity endpoint App
// Service gives its apps, found through IDENTITY_ENDPOINT and IDENTITY_HEADER, issues tokens Azurite accepts when run
// with `--oauth basic`, which checks a token's audience, issuer and lifetime but not its signature, so it signs none.
// An Azure CLI whose sign-in has expired says so.

import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** An unsigned Microsoft Entra-shaped access token for Azure Storage, good for an hour. */
function storageToken() {
  const now = Math.floor(Date.now() / 1000)
  const claims = { aud: 'https://storage.azure.com', iss: `https://sts.windows.net/${randomUUID()}/`, iat: now, nbf: now - 60, exp: now + 3600, oid: randomUUID() }
  return `${base64url({ typ: 'JWT', alg: 'RS256' })}.${base64url(claims)}.c2lnbmF0dXJl`
}

/**
 * Starts the managed identity endpoint; `env` is what to set for Azure's default credential chain to sign in through
 * it, and nothing else.
 */
export async function startManagedIdentity() {
  const header = randomUUID()
  const server = createServer((request, response) => {
    const resource = new URL(request.url ?? '', 'http://localhost').searchParams.get('resource') ?? ''
    if (request.headers['x-identity-header'] !== header) return response.writeHead(401).end()
    const expiresOn = Math.floor(Date.now() / 1000) + 3600
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: storageToken(), expires_on: String(expiresOn), resource, token_type: 'Bearer' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Not listening on a port')
  return {
    env: {
      IDENTITY_ENDPOINT: `http://127.0.0.1:${address.port}/msi/token`,
      IDENTITY_HEADER: header,
      // Only the managed identity: not whatever else this machine signs in with.
      AZURE_TOKEN_CREDENTIALS: 'ManagedIdentityCredential'
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// What Azure CLI says when its sign-in has expired.
const expiredLogin = [
  'ERROR: AADSTS700082: The refresh token has expired due to inactivity.',
  'Interactive authentication is needed. Please run:',
  'az login --scope https://storage.azure.com/.default'
]

/**
 * An `az` command, first on the PATH, whose sign-in has expired; `env` is what to set for Azure's default credential
 * chain to sign in through it, and nothing else.
 */
export async function expiredAzureCli() {
  const dir = await mkdtemp(join(tmpdir(), 'polyscope-az-'))
  await writeFile(join(dir, 'az'), ['#!/bin/sh', ...expiredLogin.map((line) => `echo '${line}' >&2`), 'exit 1', ''].join('\n'))
  await chmod(join(dir, 'az'), 0o755)
  await writeFile(join(dir, 'az.cmd'), ['@echo off', ...expiredLogin.map((line) => `echo ${line} 1>&2`), 'exit /b 1', ''].join('\r\n'))
  return {
    env: { PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`, AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential' },
    dispose: () => rm(dir, { recursive: true, force: true })
  }
}
