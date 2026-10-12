import { describe } from 'vitest'
import { createAzureBlobFileSource } from './azure-blob-file-source'
import { hasTestAccount, seedPrefix, testAzureBlobSource } from './azure-blob-test-store'
import { describeFileSourceContract } from './file-source-contract'

describe.skipIf(!hasTestAccount)('Azure Blob Storage against the test account', () => {
  describeFileSourceContract('Azure Blob Storage', async (tree) => {
    const { prefix, remove } = await seedPrefix(tree)
    const { account, container, connectionString = '' } = testAzureBlobSource('Contract', prefix)
    return { fileSource: createAzureBlobFileSource({ account, container, prefix, signIn: { connectionString } }), dispose: remove }
  })
})
