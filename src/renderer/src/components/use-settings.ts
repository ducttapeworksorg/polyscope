import { useEffect, useState } from 'react'
import type { Settings, Theme } from '@shared/settings'
import { isExtensionCopy } from '../copy'
import { core } from '../core-client'
import { applyTheme, followVsCodeTheme } from '../theme'

/** The settings, kept current as they change, and the theme they pick applied. */
export interface SettingsModel {
  /** Null until loaded; nothing is shown before then, so a saved theme never flashes the other one first. */
  settings: Settings | null
  settingsSaved(settings: Settings): void
  /** The theme shown: one being tried out in the Settings dialog, or else the saved one; in an Extension Copy, VS Code's. */
  theme: Theme | undefined
  /** Shows a theme being tried out instead of the saved one, or the saved one again when null. */
  setPreviewTheme(theme: Theme | null): void
}

/**
 * Loads the settings, keeps them current, and applies their theme, or one being tried out instead. An Extension Copy
 * shows VS Code's theme instead.
 */
export function useSettings(): SettingsModel {
  const [settings, setSettings] = useState<Settings | null>(null)
  // A theme being tried out in the Settings dialog, shown instead of the saved one until it closes.
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null)
  const followsVsCode = isExtensionCopy()
  const [vsCodeTheme, setVsCodeTheme] = useState<Theme>()

  useEffect(() => {
    const unsubscribe = core.onSettingsChanged(setSettings)
    void core.getSettings().then(setSettings)
    return unsubscribe
  }, [])

  useEffect(() => (followsVsCode ? followVsCodeTheme(setVsCodeTheme) : undefined), [followsVsCode])

  const theme = followsVsCode ? vsCodeTheme : (previewTheme ?? settings?.theme)
  useEffect(() => {
    if (theme && !followsVsCode) applyTheme(theme)
  }, [theme, followsVsCode])

  const settingsSaved = (saved: Settings) => {
    setSettings(saved)
    setPreviewTheme(null)
  }

  return { settings, settingsSaved, theme, setPreviewTheme }
}
