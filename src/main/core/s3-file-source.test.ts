import { describe } from 'vitest'
import { describeFileSourceContract } from './file-source-contract'
import { createS3FileSource } from './s3-file-source'
import { hasTestStore, seedPrefix, testS3Source } from './s3-test-store'

describe.skipIf(!hasTestStore)('S3 against the test store', () => {
  describeFileSourceContract('S3', async (tree) => {
    const { prefix, remove } = await seedPrefix(tree)
    const { host, bucket, region = '', pathStyle = false, accessKeyId = '', secretAccessKey = '' } = testS3Source('Contract', prefix)
    const credentials = { accessKeyId, secretAccessKey }
    return {
      fileSource: createS3FileSource({ host, bucket, prefix, region, pathStyle, credentials, verifyTls: true, proxyUrl: '' }),
      dispose: remove
    }
  })
})
