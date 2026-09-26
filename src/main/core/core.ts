import { randomUUID } from 'node:crypto'
import type { CoreApi, SourceInfo, SourcePath, TreeNode } from '@shared/core-api'
import { CoreError } from './core-error'
import type { FileSource } from './file-source'
import { createLocalFileSource } from './local-file-source'

const utf8 = new TextDecoder()
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function createCore(): CoreApi {
  const sources: SourceInfo[] = []
  const fileSources = new Map<string, FileSource>()

  const fileSourceFor = (sourceId: string) => {
    const fileSource = fileSources.get(sourceId)
    if (!fileSource) throw new CoreError('SOURCE_NOT_FOUND', `No Source with id ${sourceId}`)
    return fileSource
  }

  const joinPath = (parent: SourcePath, name: string) => (parent ? `${parent}/${name}` : name)

  return {
    async listSources() {
      return sources.map((s) => ({ ...s }))
    },

    async addSource(input) {
      const name = input.name.trim()
      if (!name) throw new CoreError('NAME_REQUIRED', 'A Source needs a name')
      const fileSource = createLocalFileSource(input.rootPath)
      const root = await fileSource.stat('').catch(() => null)
      if (!root) throw new CoreError('ROOT_NOT_FOUND', `Root path does not exist: ${input.rootPath}`)
      if (root.kind !== 'folder') throw new CoreError('ROOT_NOT_A_FOLDER', `Root path is not a folder: ${input.rootPath}`)

      const source: SourceInfo = { id: randomUUID(), type: input.type, name, rootPath: input.rootPath }
      sources.push(source)
      fileSources.set(source.id, fileSource)
      return { ...source }
    },

    async expand(sourceId, path) {
      const entries = await fileSourceFor(sourceId).listChildren(path)
      return entries
        .map((e): TreeNode => ({ kind: e.kind, name: e.name, path: joinPath(path, e.name) }))
        .sort((a, b) => (a.kind === b.kind ? byName.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    },

    async openFile(sourceId, path) {
      const fileSource = fileSourceFor(sourceId)
      const info = await fileSource.stat(path)
      if (info.kind !== 'file') throw new CoreError('NOT_A_FILE', `Not a file: ${path}`)
      const bytes = await fileSource.read(path)
      return {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        content: utf8.decode(bytes),
        size: info.size,
        modifiedTime: info.modifiedTime
      }
    }
  }
}
