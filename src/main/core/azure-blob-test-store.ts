// Test support: a real Azure Blob Storage account (Azurite in CI) to seed, named by its connection string in
// POLYSCOPE_TEST_AZURE_CONNECTION_STRING. Tests that need it are skipped without it.

import { randomUUID } from 'node:crypto'
import { BlobServiceClient, ContainerSASPermissions } from '@azure/storage-blob'
import type { NewAzureBlobSource } from '@shared/core-api'

const connectionString = process.env['POLYSCOPE_TEST_AZURE_CONNECTION_STRING']

/** Whether a test account was given; Azure Blob Storage tests are skipped without one. */
export const hasTestAccount = Boolean(connectionString)

export const testContainer = 'polyscope-test'

/** The test account's blob endpoint, as its connection string gives it. */
export const testEndpoint = /(?:^|;)\s*BlobEndpoint=([^;]+)/i.exec(connectionString ?? '')?.[1] ?? ''

/**
 * Whether the test account takes Microsoft Entra tokens, as Azurite does over https when run with `--oauth basic`:
 * tests signing in as the user are skipped without it.
 */
export const takesTokens = testEndpoint.startsWith('https://') && process.env['POLYSCOPE_TEST_AZURE_OAUTH'] === '1'

/** The test account's name, as its connection string gives it. */
export const testAccount = /(?:^|;)\s*AccountName=([^;]+)/i.exec(connectionString ?? '')?.[1] ?? ''

/** Settings of an Azure Blob Storage Source pointing at the test account; `prefix` roots it inside the test container. */
export const testAzureBlobSource = (name: string, prefix: string): NewAzureBlobSource => ({
  type: 'azureBlob',
  name,
  account: testAccount,
  container: testContainer,
  prefix,
  connectionString: connectionString ?? ''
})

let client: BlobServiceClient | undefined
const testClient = () => (client ??= BlobServiceClient.fromConnectionString(connectionString ?? '')).getContainerClient(testContainer)

/**
 * A SAS URL for the test container, signed with the test account's key: allowed to list and read unless `permissions`
 * says otherwise (as `ContainerSASPermissions.parse` reads them), and good for an hour unless it `expiresOn` sooner.
 */
export async function testSasUrl({ permissions = 'rl', expiresOn = new Date(Date.now() + 60 * 60_000) } = {}) {
  await ensureContainer()
  return testClient().generateSasUrl({ permissions: ContainerSASPermissions.parse(permissions), startsOn: new Date(Date.now() - 5 * 60_000), expiresOn })
}

let containerReady: Promise<unknown> | undefined
const ensureContainer = () => (containerReady ??= testClient().createIfNotExists())

/**
 * Blobs by name under a prefix: content, or null for an empty folder (a zero-byte `name/` marker), or a Data Lake
 * directory: a zero-byte blob named after it, marked as one, as an account with a hierarchical namespace lists it.
 */
export type SeedBlobs = Record<string, string | Uint8Array | null | { directory: true }>

/** A prefix of its own in the test container, seeded with `blobs`; `remove` deletes everything under it. */
export async function seedPrefix(blobs: SeedBlobs) {
  await ensureContainer()
  const prefix = `run-${randomUUID()}`
  const entries = Object.entries(blobs)
  // A few at a time: thousands of parallel requests overwhelm a local emulator.
  for (let i = 0; i < entries.length; i += 50) {
    await Promise.all(
      entries.slice(i, i + 50).map(([name, content]) => {
        if (content !== null && typeof content === 'object' && !(content instanceof Uint8Array)) {
          return testClient().getBlockBlobClient(`${prefix}/${name}`).upload('', 0, { metadata: { hdi_isfolder: 'true' } })
        }
        const body = typeof content === 'string' ? Buffer.from(content) : (content ?? new Uint8Array())
        return testClient().getBlockBlobClient(`${prefix}/${name}${content === null ? '/' : ''}`).upload(body, body.length)
      })
    )
  }
  return { prefix, remove: () => removePrefix(prefix) }
}

async function removePrefix(prefix: string) {
  const names: string[] = []
  for await (const blob of testClient().listBlobsFlat({ prefix: `${prefix}/` })) names.push(blob.name)
  for (let i = 0; i < names.length; i += 50) {
    await Promise.all(names.slice(i, i + 50).map((name) => testClient().deleteBlob(name)))
  }
}
