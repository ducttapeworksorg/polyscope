import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FollowEvent, LargeFileEvent, LargeFileSearchEvent } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import type { PolyscopeBridge } from './bridge'

const bridge: PolyscopeBridge = {
  invokeCore: (method, args) => ipcRenderer.invoke('core', method, args),
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder'),
  pickFile: (filters) => ipcRenderer.invoke('shell:pickFile', filters),
  onSettingsChanged: (listener) => {
    const forward = (_event: IpcRendererEvent, settings: Settings) => listener(settings)
    ipcRenderer.on('core:settingsChanged', forward)
    return () => ipcRenderer.off('core:settingsChanged', forward)
  },
  onFollowEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: FollowEvent) => listener(event)
    ipcRenderer.on('core:followEvent', forward)
    return () => ipcRenderer.off('core:followEvent', forward)
  },
  onLargeFileEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: LargeFileEvent) => listener(event)
    ipcRenderer.on('core:largeFileEvent', forward)
    return () => ipcRenderer.off('core:largeFileEvent', forward)
  },
  onLargeFileSearchEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: LargeFileSearchEvent) => listener(event)
    ipcRenderer.on('core:largeFileSearchEvent', forward)
    return () => ipcRenderer.off('core:largeFileSearchEvent', forward)
  }
}

contextBridge.exposeInMainWorld('polyscope', bridge)
