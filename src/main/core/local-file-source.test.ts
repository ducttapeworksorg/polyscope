import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeFileSourceContract } from './file-source-contract'
import { createLocalFileSource } from './local-file-source'

describeFileSourceContract('Local Filesystem', async (tree) => {
  const root = await mkdtemp(join(tmpdir(), 'polyscope-contract-'))
  const entries = Object.entries(tree).map(([path, content]) => ({ absolute: join(root, path), content }))
  const folders = new Set(entries.map(({ absolute, content }) => (content === null ? absolute : dirname(absolute))))
  await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })))
  await Promise.all(entries.map(({ absolute, content }) => content !== null && writeFile(absolute, content)))
  return {
    fileSource: createLocalFileSource(root, { showHidden: true }),
    dispose: () => rm(root, { recursive: true, force: true })
  }
})
