// Test support: a real S3-compatible store (RustFS in CI) to seed, named by POLYSCOPE_TEST_S3_ENDPOINT and signed
// into with POLYSCOPE_TEST_S3_ACCESS_KEY and POLYSCOPE_TEST_S3_SECRET_KEY. Tests that need it are skipped without it.

import { randomUUID } from 'node:crypto'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import type { NewS3Source } from '@shared/core-api'

const endpoint = process.env['POLYSCOPE_TEST_S3_ENDPOINT']

/** Whether a test store was given; S3 tests are skipped without one. */
export const hasTestStore = Boolean(endpoint)

export const testBucket = 'polyscope-test'

/** Settings of an S3 Source pointing at the test store; `prefix` roots it inside the test bucket. */
export const testS3Source = (name: string, prefix: string): NewS3Source => ({
  type: 's3',
  name,
  host: endpoint ?? '',
  bucket: testBucket,
  prefix,
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: process.env['POLYSCOPE_TEST_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: process.env['POLYSCOPE_TEST_S3_SECRET_KEY'] ?? ''
})

let client: S3Client | undefined
const testClient = () => {
  const settings = testS3Source('seeding', '')
  client ??= new S3Client({
    endpoint: settings.host,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId!, secretAccessKey: settings.secretAccessKey! }
  })
  return client
}

let bucketReady: Promise<unknown> | undefined
const ensureBucket = () =>
  (bucketReady ??= testClient()
    .send(new CreateBucketCommand({ Bucket: testBucket }))
    .catch((error: Error) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error
    }))

/** Objects by key under a prefix: content, or null for an empty folder (a zero-byte `key/` marker). */
export type SeedObjects = Record<string, string | Uint8Array | null>

/** A prefix of its own in the test bucket, seeded with `objects`; `remove` deletes everything under it. */
export async function seedPrefix(objects: SeedObjects) {
  await ensureBucket()
  const prefix = `run-${randomUUID()}`
  const entries = Object.entries(objects)
  // A few at a time: thousands of parallel requests overwhelm a local store.
  for (let i = 0; i < entries.length; i += 50) {
    await Promise.all(
      entries.slice(i, i + 50).map(([key, content]) =>
        testClient().send(
          new PutObjectCommand({ Bucket: testBucket, Key: `${prefix}/${key}${content === null ? '/' : ''}`, Body: content ?? '' })
        )
      )
    )
  }
  return { prefix, remove: () => removePrefix(prefix) }
}

async function removePrefix(prefix: string) {
  let token: string | undefined
  do {
    const page = await testClient().send(
      new ListObjectsV2Command({ Bucket: testBucket, Prefix: `${prefix}/`, ContinuationToken: token })
    )
    const keys = (page.Contents ?? []).map(({ Key }) => ({ Key }))
    if (keys.length) await testClient().send(new DeleteObjectsCommand({ Bucket: testBucket, Delete: { Objects: keys } }))
    token = page.NextContinuationToken
  } while (token)
}
