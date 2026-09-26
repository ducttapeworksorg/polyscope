import type { IconKey } from '@shared/core-api'
import type { Theme } from '@shared/settings'

// Every Material Icon Theme icon, as a URL to its own file so only the icons on screen are ever loaded.
const urls = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?no-inline',
  import: 'default'
})
const byName = new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), url]))

/** The icon's URL: its open variant for an open folder, and its light variant, where it has one, in the light theme. */
function iconUrl(icon: IconKey, open: boolean, theme: Theme) {
  const name = open ? `${icon}-open` : icon
  const themed = theme === 'light' ? byName.get(`${name}_light`) : undefined
  return themed ?? byName.get(name)
}

interface Props {
  icon: IconKey
  theme: Theme
  /** For folders: whether to show the open icon. */
  open?: boolean
}

/** A file or folder icon from Material Icon Theme, as the core chose it for the entry. */
export const MaterialIcon = ({ icon, theme, open = false }: Props) => (
  <img className="material-icon" src={iconUrl(icon, open, theme)} alt="" width={16} height={16} draggable={false} />
)
