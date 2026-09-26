import type { IconKey } from '@shared/core-api'
import manifest from 'material-icon-theme/dist/material-icons.json'

type Associations = Record<string, string>

/** Looks a name up as written, then ignoring case, as VS Code does. */
function matcher(associations: Associations) {
  const lowered = new Map<string, string>()
  for (const [name, icon] of Object.entries(associations)) {
    if (!lowered.has(name.toLowerCase())) lowered.set(name.toLowerCase(), icon)
  }
  return (name: string) => associations[name] ?? lowered.get(name.toLowerCase())
}

const byFileName = matcher(manifest.fileNames)
const byExtension = matcher(manifest.fileExtensions)
const byFolderName = matcher(manifest.folderNames)

/** A file's icon: by its whole name first, then by its longest known extension ('d.ts' before 'ts'). */
export function fileIcon(name: string): IconKey {
  const exact = byFileName(name)
  if (exact) return exact
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const icon = byExtension(name.slice(dot + 1))
    if (icon) return icon
  }
  return manifest.file
}

/** A closed folder's icon; the open one is the same with '-open' added. */
export const folderIcon = (name: string): IconKey => byFolderName(name) ?? manifest.folder
