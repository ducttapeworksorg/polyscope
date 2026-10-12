// Test support: a Docker CLI config folder, as `docker context create` leaves it, for DOCKER_CONFIG to point at.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestDockerContext {
  name: string
  /** Its endpoint's `Host`, e.g. `tcp://127.0.0.1:2376` or `unix:///run/podman/podman.sock`. */
  host: string
  description?: string
  skipTlsVerify?: boolean
  /** Its TLS material, as PEM, kept beside its metadata as the CLI keeps it; any of them may be left out. */
  tls?: { ca?: string; cert?: string; key?: string }
}

/** Writes a Docker CLI config folder holding `contexts`, `currentContext` its current one if given; returns its path. */
export async function writeDockerConfig({ contexts = [], currentContext }: { contexts?: TestDockerContext[]; currentContext?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'polyscope-docker-config-'))
  await writeFile(join(dir, 'config.json'), JSON.stringify({ auths: {}, ...(currentContext && { currentContext }) }))
  for (const { name, host, description, skipTlsVerify = false, tls } of contexts) {
    // The CLI keeps each context in a folder named after its name's SHA-256.
    const id = createHash('sha256').update(name).digest('hex')
    await mkdir(join(dir, 'contexts', 'meta', id), { recursive: true })
    const meta = { Name: name, Metadata: description ? { Description: description } : {}, Endpoints: { docker: { Host: host, SkipTLSVerify: skipTlsVerify } } }
    await writeFile(join(dir, 'contexts', 'meta', id, 'meta.json'), JSON.stringify(meta))
    if (!tls) continue
    const tlsDir = join(dir, 'contexts', 'tls', id, 'docker')
    await mkdir(tlsDir, { recursive: true })
    for (const file of ['ca', 'cert', 'key'] as const) if (tls[file]) await writeFile(join(tlsDir, `${file}.pem`), tls[file])
  }
  return dir
}
