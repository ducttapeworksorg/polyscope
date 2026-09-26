import { contextBridge, ipcRenderer } from 'electron'
import type { PolyscopeBridge } from './bridge'

const bridge: PolyscopeBridge = {
  invokeCore: (method, args) => ipcRenderer.invoke('core', method, args),
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder')
}

contextBridge.exposeInMainWorld('polyscope', bridge)
