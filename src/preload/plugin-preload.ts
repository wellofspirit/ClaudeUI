import { contextBridge, ipcRenderer } from 'electron'

// Capture pluginId at preload time (before any plugin JS runs).
// This value is frozen and cannot be changed by the webview's page scripts.
const pluginId = new URL(window.location.href).searchParams.get('pluginId') ?? 'unknown'

// Validate the pluginId: only allow IPC calls if the ID matches a registered plugin.
// This prevents a rogue webview from spoofing another plugin's namespace.
const PLUGIN_ID_RE = /^[a-zA-Z0-9_-]+$/
const isValidId = PLUGIN_ID_RE.test(pluginId) && pluginId !== 'unknown'

const pluginApi = {
  /** The plugin's ID (frozen at preload time) */
  pluginId,

  /** Invoke a plugin-namespaced IPC handler (plugin:<pluginId>:<channel>) */
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!isValidId) return Promise.reject(new Error('Invalid pluginId'))
    return ipcRenderer.invoke(`plugin:${pluginId}:${channel}`, ...args)
  },

  /** Listen to plugin-namespaced events (plugin:<pluginId>:<event>) */
  on: (event: string, cb: (...args: unknown[]) => void): (() => void) => {
    if (!isValidId) return () => {}
    const fullChannel = `plugin:${pluginId}:${event}`
    const handler = (_: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(fullChannel, handler)
    return () => ipcRenderer.removeListener(fullChannel, handler)
  },

  /** Send a one-way message to the main process (plugin:<pluginId>:<channel>) */
  send: (channel: string, ...args: unknown[]): void => {
    if (!isValidId) return
    ipcRenderer.send(`plugin:${pluginId}:${channel}`, ...args)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('pluginApi', Object.freeze(pluginApi))
} else {
  // @ts-expect-error global augmentation
  window.pluginApi = Object.freeze(pluginApi)
}
