import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionEvent, FollowEvent, LargeFileEvent, LargeFileSearchEvent, SaveCopyEvent } from '@shared/core-api'
import type { Settings } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { PolyscopeBridge } from './bridge'

const bridge: PolyscopeBridge = {
  copy: 'desktop',
  invokeCore: (method, args) => ipcRenderer.invoke('core', method, args),
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder'),
  pickFile: (filters) => ipcRenderer.invoke('shell:pickFile', filters),
  secretStorageIsWeak: () => ipcRenderer.invoke('shell:secretStorageIsWeak'),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),
  copyText: (text) => ipcRenderer.invoke('shell:copyText', text),
  saveCopy: (sourceId, path) => ipcRenderer.invoke('shell:saveCopy', sourceId, path),
  appVersion: () => ipcRenderer.invoke('updates:appVersion'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  applyUpdate: () => ipcRenderer.invoke('updates:apply'),
  onUpdateStatus: (listener) => {
    const forward = (_event: IpcRendererEvent, status: UpdateStatus) => listener(status)
    ipcRenderer.on('updates:status', forward)
    return () => ipcRenderer.off('updates:status', forward)
  },
  onSettingsChanged: (listener) => {
    const forward = (_event: IpcRendererEvent, settings: Settings) => listener(settings)
    ipcRenderer.on('core:settingsChanged', forward)
    return () => ipcRenderer.off('core:settingsChanged', forward)
  },
  onConnectionEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: ConnectionEvent) => listener(event)
    ipcRenderer.on('core:connectionEvent', forward)
    return () => ipcRenderer.off('core:connectionEvent', forward)
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
  },
  onSaveCopyEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: SaveCopyEvent) => listener(event)
    ipcRenderer.on('core:saveCopyEvent', forward)
    return () => ipcRenderer.off('core:saveCopyEvent', forward)
  }
}

contextBridge.exposeInMainWorld('polyscope', bridge)
