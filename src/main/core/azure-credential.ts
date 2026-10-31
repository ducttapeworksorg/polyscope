// The credential an Azure Blob Storage Source signing in as the user gets its tokens with: Azure's default chain, its
// requests going out through the Source's agents rather than through the Azure SDK's own proxy handling, which reads
// ALL_PROXY and knows nothing of the Source's Proxy and CA bundle. Azure CLI's own requests are its own: `az` runs apart.

import { createDefaultHttpClient, type HttpClient } from '@azure/core-rest-pipeline'
import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential, type TokenCredentialOptions } from '@azure/identity'
import type { NetworkAgents } from './network-agents'

/** IMDS, where a VM's managed identity gets its tokens, on whatever port. */
const imds = '169.254.169.254'

/** A URL's origin (`http://127.0.0.1:41000`), or undefined for none at all. */
function originOf(url: string | undefined) {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * Whether a request is for a managed identity endpoint: IMDS, or where IDENTITY_ENDPOINT (App Service, Functions, Arc,
 * Service Fabric) or MSI_ENDPOINT (Cloud Shell, older App Service) point, as they are now. These are on the machine
 * or its host, so they're reached directly, as the AWS SDK reaches EC2's and ECS's metadata.
 */
function isManagedIdentityEndpoint(url: URL) {
  if (url.hostname === imds) return true
  return [process.env['IDENTITY_ENDPOINT'], process.env['MSI_ENDPOINT']].some((endpoint) => originOf(endpoint) === url.origin)
}

/**
 * An HTTP client sending each request through the agent for its scheme: one of `direct`'s for a managed identity
 * endpoint, one of `agents`' otherwise. The Azure SDK's proxy policy has given the request an agent of its own by then,
 * if the environment names a proxy, which this replaces.
 */
function httpClientThrough(agents: NetworkAgents, direct: NetworkAgents): HttpClient {
  const client = createDefaultHttpClient()
  return {
    sendRequest(request) {
      const url = new URL(request.url)
      const { httpAgent, httpsAgent } = isManagedIdentityEndpoint(url) ? direct : agents
      request.agent = url.protocol === 'http:' ? httpAgent : httpsAgent
      return client.sendRequest(request)
    }
  }
}

/**
 * Azure's default credential chain, its requests going through `agents`, bar managed identity endpoints, which go
 * through `direct`. MSAL keeps the HTTP client of the first managed identity token request for the rest of the process,
 * so every later Source's goes through the first Source's `direct` agents: straight there all the same, though trusting
 * that Source's CA bundle, which only an https managed identity endpoint (Service Fabric's) would notice.
 */
export function azureCredential(agents: NetworkAgents, direct: NetworkAgents): TokenCredential {
  const options: TokenCredentialOptions = { httpClient: httpClientThrough(agents, direct) }
  // Told to use only a managed identity, DefaultAzureCredential (as of @azure/identity 4.14) builds it without the
  // options it's given, so it's built here as DefaultAzureCredential would, with them: the retries it gives one, and
  // AZURE_CLIENT_ID's identity, which on AKS is also the one the credential exchanges AZURE_FEDERATED_TOKEN_FILE's
  // token for. Every other value of AZURE_TOKEN_CREDENTIALS hands its credentials the options.
  if (process.env['AZURE_TOKEN_CREDENTIALS']?.trim().toLowerCase() === 'managedidentitycredential') {
    const clientId = process.env['AZURE_CLIENT_ID']
    const retryOptions = { maxRetries: 5, retryDelayInMs: 800 }
    return new ManagedIdentityCredential({ ...options, retryOptions, ...(clientId && { clientId }) })
  }
  return new DefaultAzureCredential(options)
}
