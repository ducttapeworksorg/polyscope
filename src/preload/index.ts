import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FollowEvent } from '@shared/core-api'
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
  }
}

contextBridge.exposeInMainWorld('polyscope', bridge)
