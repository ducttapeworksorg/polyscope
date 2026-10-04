import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { suggestedColors } from '../renderer/src/environments'
import { environmentColorId, environmentColors } from './environment-colors'

interface ContributedColor {
  id: string
  defaults: Record<string, string>
}

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'extension', 'package.json'), 'utf8')) as {
  contributes: { colors: ContributedColor[] }
}

describe('environmentColorId', () => {
  it('tints with each colour offered for a new Environment as it is', () => {
    for (const color of suggestedColors) {
      const id = environmentColorId(color)
      expect(environmentColors.find((c) => c.id === id)?.color).toBe(color)
    }
  })

  it('tints with the nearest of them for any other colour', () => {
    expect(environmentColorId('#ff0000')).toBe('polyscope.environment.red')
    expect(environmentColorId('#2e7d32')).toBe('polyscope.environment.green')
    expect(environmentColorId('#7f7f7f')).toBe('polyscope.environment.gray')
  })
})

describe('the extension’s manifest', () => {
  it('contributes each colour tabs are tinted with, the same in every kind of theme', () => {
    for (const { id, color } of environmentColors) {
      expect(manifest.contributes.colors).toContainEqual({
        id,
        description: expect.any(String),
        defaults: { dark: color, light: color, highContrast: color, highContrastLight: color }
      })
    }
    expect(manifest.contributes.colors.filter(({ id }) => id.startsWith('polyscope.environment.'))).toHaveLength(environmentColors.length)
  })
})
