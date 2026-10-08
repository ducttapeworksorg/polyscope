import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCore } from './core'
import { ignoreAmbientProxy, standInCluster, startTestApiServer } from './kubernetes-test-api-server'

// The OS's certificate store, which a company's own root CA is installed into.
const os = vi.hoisted(() => ({ cas: [] as string[] }))
vi.mock('node:tls', async (original) => {
  const tls = await original<typeof import('node:tls')>()
  const getCACertificates = (type?: 'default' | 'system' | 'bundled' | 'extra') => (type === 'system' ? os.cas : tls.getCACertificates(type))
  return { ...tls, getCACertificates, default: { ...tls, getCACertificates } }
})

let dir: string
let apiServer: Awaited<ReturnType<typeof startTestApiServer>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyscope-kube-'))
  apiServer = await startTestApiServer()
  ignoreAmbientProxy()
  os.cas = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await apiServer.close()
  await rm(dir, { recursive: true, force: true })
})

async function useKubeconfig(content: string) {
  const file = join(dir, 'kubeconfig')
  await writeFile(file, content)
  vi.stubEnv('KUBECONFIG', file)
}

describe('trusting a cluster', () => {
  it('trusts the CAs the OS does when the kubeconfig names none, as kubectl does', async () => {
    await useKubeconfig(standInCluster(apiServer.url, undefined))
    os.cas = [await readFile(apiServer.caPath, 'utf8')]

    expect(await createCore().listKubeWorkloads('fake', 'shop')).toEqual(expect.any(Array))
  })

  it('trusts the CAs the OS does as well as the one the kubeconfig names, which may be an issuing CA only the OS has the root of', async () => {
    await useKubeconfig(standInCluster(apiServer.url, apiServer.issuingCaPath))
    os.cas = [await readFile(apiServer.caPath, 'utf8')]

    expect(await createCore().listKubeWorkloads('fake', 'shop')).toEqual(expect.any(Array))
  })

  it('fails as untrusted, saying why, when neither the OS nor the kubeconfig trusts it', async () => {
    await useKubeconfig(standInCluster(apiServer.url, undefined))

    await expect(createCore().listKubeWorkloads('fake', 'shop')).rejects.toMatchObject({
      code: 'CERTIFICATE_UNTRUSTED',
      message: expect.stringContaining('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
    })
  })

  it('fails as untrusted when the kubeconfig names an issuing CA whose root nothing trusts', async () => {
    await useKubeconfig(standInCluster(apiServer.url, apiServer.issuingCaPath))

    await expect(createCore().listKubeWorkloads('fake', 'shop')).rejects.toMatchObject({ code: 'CERTIFICATE_UNTRUSTED' })
  })

  it('fails as unreadable when the kubeconfig names a CA file that isn’t there', async () => {
    await useKubeconfig(standInCluster(apiServer.url, join(dir, 'missing.pem')))

    await expect(createCore().listKubeWorkloads('fake', 'shop')).rejects.toMatchObject({ code: 'CA_BUNDLE_UNREADABLE' })
  })
})
