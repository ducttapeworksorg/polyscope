// Signing in through a managed identity, in a file of its own: MSAL keeps the first managed identity endpoint it's
// asked for a token through, and the network client it's reached with, for the rest of the process, so only the first
// sign-in in a process shows where its requests go.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { managedIdentity, startRefusingAzure } from './azure-test-identity'
import { createCore } from './core'
import { ignoreAmbientProxy, startProxy } from './test-network'

const disposals: (() => Promise<void>)[] = []

beforeEach(() => {
  ignoreAmbientProxy()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

it('reaches the managed identity endpoint directly, whatever the Source’s own proxy or ALL_PROXY say', async () => {
  // Told to use only the managed identity, as Azure's SDK builds it apart.
  const identity = await managedIdentity()
  expect(identity.env.AZURE_TOKEN_CREDENTIALS).toBe('ManagedIdentityCredential')
  for (const [name, value] of Object.entries(identity.env)) vi.stubEnv(name, value)
  // Gone: a request going through it fails.
  vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1')
  vi.stubEnv('all_proxy', 'http://127.0.0.1:1')
  const proxy = await startProxy()
  disposals.push(proxy.close)
  const azure = await startRefusingAzure()
  disposals.push(azure.close)

  await expect(
    createCore().testConnection({
      type: 'azureBlob',
      name: 'Logs',
      account: 'contosologs',
      container: 'logs',
      endpoint: azure.endpoint,
      auth: 'azureCli',
      caBundlePath: azure.caPath,
      proxyUrl: proxy.url
    })
  ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' })
  // The blob request went through the Source's proxy, the token request straight to the endpoint.
  expect(proxy.tunnels).toEqual([azure.host])
  expect(proxy.forwards).toEqual([])
})
