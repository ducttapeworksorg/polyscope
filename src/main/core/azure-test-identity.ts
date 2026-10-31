// Test support: stand-ins for what Azure's default credential chain signs in through. The managed identity endpoint App
// Service gives its apps, found through IDENTITY_ENDPOINT and IDENTITY_HEADER, issues tokens Azurite accepts when run
// with `--oauth basic`, which checks a token's audience, issuer and lifetime but not its signature, so it signs none.
// Microsoft Entra ID issues them to an app signing in with a client secret. An Azure CLI whose sign-in has expired says
// so. And Azure, refusing an identity it has a token for but no role on the account.

import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { startTlsFront } from './test-network'

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** An unsigned Microsoft Entra-shaped access token for Azure Storage, good for an hour. */
function storageToken() {
  const now = Math.floor(Date.now() / 1000)
  const claims = { aud: 'https://storage.azure.com', iss: `https://sts.windows.net/${randomUUID()}/`, iat: now, nbf: now - 60, exp: now + 3600, oid: randomUUID() }
  return `${base64url({ typ: 'JWT', alg: 'RS256' })}.${base64url(claims)}.c2lnbmF0dXJl`
}

// The endpoint, started when first wanted and kept for the rest of the process: MSAL keeps the first managed identity
// endpoint it's given (with its header and the network client it's reached through) for the whole process, so a
// second one would never be asked.
let endpoint: Promise<{ url: string; header: string }> | undefined

async function startEndpoint() {
  const header = randomUUID()
  const server = createServer((request, response) => {
    const resource = new URL(request.url ?? '', 'http://localhost').searchParams.get('resource') ?? ''
    if (request.headers['x-identity-header'] !== header) return response.writeHead(401).end()
    const expiresOn = Math.floor(Date.now() / 1000) + 3600
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: storageToken(), expires_on: String(expiresOn), resource, token_type: 'Bearer' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Nothing closes it, so it mustn't keep the process alive.
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Not listening on a port')
  return { url: `http://127.0.0.1:${address.port}/msi/token`, header }
}

/**
 * The managed identity endpoint, started if it isn't yet; `env` is what to set for Azure's default credential chain to
 * sign in through it, and nothing else. Each call is for an identity of its own, so it gets a token of its own: MSAL
 * keeps managed identity tokens for the whole process, by identity, and one got before would do without a request.
 */
export async function managedIdentity() {
  const { url, header } = await (endpoint ??= startEndpoint())
  return {
    env: {
      IDENTITY_ENDPOINT: url,
      IDENTITY_HEADER: header,
      AZURE_CLIENT_ID: randomUUID(),
      // Only the managed identity: not whatever else this machine signs in with.
      AZURE_TOKEN_CREDENTIALS: 'ManagedIdentityCredential'
    }
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

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const closing = (server: Server) => () => new Promise<void>((resolve) => server.close(() => resolve()))

/**
 * Starts Microsoft Entra ID, over TLS with a certificate from the private test CA for login.microsoftonline.com, where
 * Azure's SDK finds it for any tenant without asking: a test proxy given `hosts` reaches it by that name. `env` is what
 * to set for Azure's default credential chain to sign in through it as an app with a client secret, and nothing else;
 * `caPath` trusts it, and `tokens` counts the tokens it has issued.
 */
export async function startEntraId() {
  const tenant = randomUUID()
  const secret = randomUUID()
  let tokens = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      const form = new URLSearchParams(body)
      if (request.method !== 'POST' || request.url?.split('?')[0] !== `/${tenant}/oauth2/v2.0/token` || form.get('client_secret') !== secret) {
        return response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request' }))
      }
      tokens++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ token_type: 'Bearer', expires_in: 3600, ext_expires_in: 3600, access_token: storageToken() }))
    })
  })
  const front = await startTlsFront(await listen(server))
  return {
    env: {
      AZURE_TENANT_ID: tenant,
      AZURE_CLIENT_ID: randomUUID(),
      AZURE_CLIENT_SECRET: secret,
      AZURE_TOKEN_CREDENTIALS: 'EnvironmentCredential'
    },
    hosts: { 'login.microsoftonline.com': new URL(front.url).host },
    caPath: front.caPath,
    get tokens() {
      return tokens
    },
    close: async () => {
      await front.close()
      await closing(server)()
    }
  }
}

/**
 * Starts Azure, refusing an identity that has no data role on the account (Azurite gives every identity every role),
 * behind TLS with a certificate from the private test CA: its blob `endpoint`, a `caPath` trusting it, and its `host`,
 * as a proxy is asked to tunnel to it. Refusing a request means a token was got for it.
 */
export async function startRefusingAzure() {
  const server = createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/xml', 'x-ms-error-code': 'AuthorizationPermissionMismatch' })
    response.end(
      '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationPermissionMismatch</Code>' +
        '<Message>This request is not authorized to perform this operation using this permission.</Message></Error>'
    )
  })
  const front = await startTlsFront(await listen(server))
  return {
    endpoint: `${front.url}/contosologs`,
    caPath: front.caPath,
    host: new URL(front.url).host,
    close: async () => {
      await front.close()
      await closing(server)()
    }
  }
}
