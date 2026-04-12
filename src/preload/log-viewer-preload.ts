import { contextBridge, ipcRenderer } from 'electron'

const logViewerApi = {
  /** Called by the viewer HTML when the DOM is ready */
  ready: (): void => {
    ipcRenderer.invoke('log-viewer:ready')
  },

  /** Subscribe to individual log entries (live stream) */
  onEntry: (cb: (entry: unknown) => void): void => {
    ipcRenderer.on('log-viewer:entry', (_, entry) => cb(entry))
  },

  /** Subscribe to batch of entries (initial catchup) */
  onBatch: (cb: (entries: unknown[]) => void): void => {
    ipcRenderer.on('log-viewer:batch', (_, entries) => cb(entries))
  },

  /** Get persisted theme preference */
  getTheme: (): Promise<string | null> => {
    return ipcRenderer.invoke('log-viewer:get-theme')
  },

  /** Persist theme preference */
  setTheme: (theme: string): void => {
    ipcRenderer.invoke('log-viewer:set-theme', theme)
  },

  /** Window controls */
  minimize: (): void => { ipcRenderer.invoke('log-viewer:minimize') },
  maximize: (): void => { ipcRenderer.invoke('log-viewer:maximize') },
  close: (): void => { ipcRenderer.invoke('log-viewer:close') },

  /** Platform info */
  platform: process.platform
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('logViewerApi', logViewerApi)
} else {
  // @ts-expect-error global augmentation
  window.logViewerApi = logViewerApi
}
