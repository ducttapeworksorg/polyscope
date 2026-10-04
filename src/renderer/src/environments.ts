import type { CSSProperties } from 'react'
import type { Environment, SourceInfo } from '@shared/core-api'

/** The Environment a Source is labelled with, if it has one that still exists. */
export const environmentOf = (environments: Environment[], { environmentId }: Pick<SourceInfo, 'environmentId'>) =>
  environments.find((e) => e.id === environmentId)

/** Colours offered for a new Environment, picked in order skipping those already used. */
export const suggestedColors = ['#8e4ec6', '#0090ff', '#12a594', '#d6409f', '#978365', '#e5484d', '#f76b15', '#ffc53d', '#30a46c']

export const nextColor = (environments: Environment[]) =>
  suggestedColors.find((color) => !environments.some((e) => e.color === color)) ?? suggestedColors[0]!

/** Relative luminance of a `#rrggbb` colour, per WCAG. */
function luminance(color: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/**
 * CSS variables carrying an Environment's colour (`--env`) and a text colour that reads on it
 * (`--env-text`), for badges, tab borders and the status bar to use.
 */
export const environmentStyle = ({ color }: Environment) =>
  ({ '--env': color, '--env-text': luminance(color) > 0.179 ? '#141a25' : '#ffffff' }) as CSSProperties
