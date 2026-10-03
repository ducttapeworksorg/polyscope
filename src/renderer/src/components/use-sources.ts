import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState, Environment, SourceInfo, TreeNode } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import { core } from '../core-client'
import { useSettings, type SettingsModel } from './use-settings'

interface Options {
  /** The Sources were read again, e.g. after one was edited or deleted, for whatever shows them to catch up. */
  onSourcesReloaded?(sources: SourceInfo[]): void
}

/** The Sources, their Environments and connection states, the settings, and which of their dialogs is open. */
export interface SourcesModel extends SettingsModel {
  sources: SourceInfo[]
  environments: Environment[]
  /** Mirrors the core's per-Source connection state; a Source with no entry is Disconnected. */
  connections: ReadonlyMap<string, ConnectionState>
  /** Connects a Source; resolves to its root's children, or null if it couldn't connect. */
  connect(source: SourceInfo): Promise<TreeNode[] | null>
  disconnect(source: SourceInfo): Promise<void>
  reloadSources(): Promise<void>
  reloadEnvironments(): Promise<void>
  toggleTreeDetails(): Promise<void>
  toggleMinimap(): Promise<void>
  toggleTheme(): Promise<void>
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  environmentsOpen: boolean
  setEnvironmentsOpen(open: boolean): void
}

/**
 * Loads the Sources, Environments and settings, keeps them and each Source's connection state current,
 * and tracks the Settings and Environments dialogs.
 */
export function useSources({ onSourcesReloaded }: Options = {}): SourcesModel {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [connections, setConnections] = useState<ReadonlyMap<string, ConnectionState>>(new Map())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const shownSettings = useSettings()
  const { settings } = shownSettings
  // The latest callback, so reloading needn't change when it does.
  const sourcesReloaded = useRef(onSourcesReloaded)
  sourcesReloaded.current = onSourcesReloaded

  const setConnection = (sourceId: string, state: ConnectionState) =>
    setConnections((prev) => new Map(prev).set(sourceId, state))

  /** Takes the core's word for a Source's state, e.g. after a call that may have changed it. */
  const syncConnection = async (sourceId: string) => {
    const state = await core.connectionState(sourceId).catch(() => null)
    if (state) setConnection(sourceId, state)
  }

  const connect = async (source: SourceInfo): Promise<TreeNode[] | null> => {
    setConnection(source.id, { state: 'connecting' })
    try {
      return await core.connect(source.id)
    } catch {
      return null
    } finally {
      await syncConnection(source.id)
    }
  }

  const disconnect = async (source: SourceInfo) => {
    await core.disconnect(source.id).catch(() => undefined)
    await syncConnection(source.id)
  }

  const reloadSources = useCallback(async () => {
    const latest = await core.listSources()
    setSources(latest)
    // The core disconnects a Source that now points somewhere else or signs in anew, and forgets a deleted one.
    const states = await Promise.all(latest.map((s) => core.connectionState(s.id).catch(() => null)))
    setConnections(new Map(latest.flatMap((s, i) => (states[i] ? [[s.id, states[i]] as const] : []))))
    sourcesReloaded.current?.(latest)
  }, [])

  const reloadEnvironments = useCallback(async () => setEnvironments(await core.listEnvironments()), [])

  useEffect(() => {
    void reloadSources()
    void reloadEnvironments()
  }, [reloadSources, reloadEnvironments])

  // The new value arrives through onSettingsChanged; if it can't be saved, the toggle stays as it was.
  const toggleTreeDetails = async () => {
    if (settings) await core.updateSettings({ showTreeDetails: !settings.showTreeDetails }).catch(() => undefined)
  }

  // Like the tree details: the new value arrives through onSettingsChanged.
  const toggleMinimap = async () => {
    if (settings) await core.updateSettings({ showMinimap: !settings.showMinimap }).catch(() => undefined)
  }

  // Saved like any setting, so it lasts; the new theme arrives through onSettingsChanged.
  const toggleTheme = async () => {
    if (settings) await core.updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' }).catch(() => undefined)
  }

  // Saving closes the dialog too.
  const settingsSaved = (saved: Settings) => {
    shownSettings.settingsSaved(saved)
    setSettingsOpen(false)
  }

  return {
    ...shownSettings,
    sources,
    environments,
    connections,
    connect,
    disconnect,
    reloadSources,
    reloadEnvironments,
    settingsSaved,
    toggleTreeDetails,
    toggleMinimap,
    toggleTheme,
    settingsOpen,
    setSettingsOpen,
    environmentsOpen,
    setEnvironmentsOpen
  }
}
