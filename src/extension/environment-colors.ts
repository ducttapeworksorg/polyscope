// VS Code tints a tab only with a colour of its theme, by id, so it can't take an Environment's own colour: the
// extension contributes the colours offered for a new Environment (and a grey) to its theme, and tints a tab with
// whichever is nearest its Environment's. extension/package.json contributes each of these.

/** The colours `polyscope` tabs are tinted with, by the theme colour id the manifest contributes each as. */
export const environmentColors = [
  { id: 'polyscope.environment.purple', color: '#8e4ec6' },
  { id: 'polyscope.environment.blue', color: '#0090ff' },
  { id: 'polyscope.environment.teal', color: '#12a594' },
  { id: 'polyscope.environment.pink', color: '#d6409f' },
  { id: 'polyscope.environment.brown', color: '#978365' },
  { id: 'polyscope.environment.red', color: '#e5484d' },
  { id: 'polyscope.environment.orange', color: '#f76b15' },
  { id: 'polyscope.environment.yellow', color: '#ffc53d' },
  { id: 'polyscope.environment.green', color: '#30a46c' },
  { id: 'polyscope.environment.gray', color: '#8b8d98' }
] as const

const channels = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))

const distance = (a: string, b: string) => {
  const [x, y] = [channels(a), channels(b)]
  return x.reduce((sum, channel, i) => sum + (channel - y[i]!) ** 2, 0)
}

/** The theme colour id a tab of a Source labelled with an Environment of `color` (`#rrggbb`) is tinted with. */
export function environmentColorId(color: string): string {
  const [nearest] = [...environmentColors].sort((a, b) => distance(color, a.color) - distance(color, b.color))
  return nearest!.id
}
