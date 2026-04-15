/**
 * Electron module mock for tests.
 *
 * Provides minimal stubs for app, dialog, shell, Menu, etc.
 * The ipcMain export is wired to a TestIpcBridge instance at runtime
 * via setIpcBridge().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { TestIpcBridge } from '../bridges/test-ipc-bridge'

let bridge: TestIpcBridge | null = null

/**
 * Wire the electron shim's ipcMain to a TestIpcBridge instance.
 * Must be called before importing any main-process modules.
 */
export function setIpcBridge(b: TestIpcBridge): void {
  bridge = b
}

export function getBridge(): TestIpcBridge | null {
  return bridge
}

// --- app ---
const appCallbacks = new Map<string, Function[]>()
export const app = {
  getAppPath: () => '/test/app',
  getPath: (name: string) => `/tmp/test-${name}`,
  getName: () => 'ClaudeUI-Test',
  getVersion: () => '0.0.0-test',
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  quit: () => {},
  on: (event: string, cb: Function) => {
    if (!appCallbacks.has(event)) appCallbacks.set(event, [])
    appCallbacks.get(event)!.push(cb)
    return app
  },
  once: (event: string, cb: Function) => {
    app.on(event, cb)
    return app
  },
  removeListener: () => app,
  removeAllListeners: () => app,
  emit: (event: string, ...args: any[]) => {
    appCallbacks.get(event)?.forEach((cb) => cb(...args))
  },
  isPackaged: false,
}

// --- ipcMain (delegates to bridge) ---
export const ipcMain = {
  handle: (channel: string, handler: any) => {
    if (!bridge) throw new Error('electron-shim: setIpcBridge() must be called before using ipcMain')
    bridge.ipcMain.handle(channel, handler)
  },
  removeHandler: (channel: string) => {
    bridge?.ipcMain.removeHandler(channel)
  },
  on: (channel: string, handler: any) => {
    if (!bridge) throw new Error('electron-shim: setIpcBridge() must be called before using ipcMain')
    bridge.ipcMain.on(channel, handler)
    return ipcMain
  },
  removeListener: (channel: string, handler: any) => {
    bridge?.ipcMain.removeListener(channel, handler)
    return ipcMain
  },
  removeAllListeners: () => ipcMain,
}

// --- ipcRenderer (delegates to bridge) ---
export const ipcRenderer = {
  invoke: async (channel: string, ...args: any[]) => {
    if (!bridge) throw new Error('electron-shim: setIpcBridge() must be called before using ipcRenderer')
    return bridge.ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, handler: any) => {
    if (!bridge) throw new Error('electron-shim: setIpcBridge() must be called before using ipcRenderer')
    bridge.ipcRenderer.on(channel, handler)
    return ipcRenderer
  },
  removeListener: (channel: string, handler: any) => {
    bridge?.ipcRenderer.removeListener(channel, handler)
    return ipcRenderer
  },
  send: (channel: string, ...args: any[]) => {
    bridge?.ipcRenderer.send(channel, ...args)
  },
}

// --- contextBridge ---
export const contextBridge = {
  exposeInMainWorld: (_key: string, _api: any) => {
    // No-op in tests — we assign window.api directly
  },
}

// --- BrowserWindow ---
export class BrowserWindow {
  webContents: any
  constructor(_opts?: any) {
    this.webContents = bridge?.webContents ?? {
      send: () => {},
      isDevToolsOpened: () => false,
      closeDevTools: () => {},
      openDevTools: () => {},
    }
  }
  isDestroyed() { return false }
  isMinimized() { return false }
  isMaximized() { return false }
  show() {}
  hide() {}
  focus() {}
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  on() { return this }
  once() { return this }
  removeListener() { return this }
  static getAllWindows() { return [] }
  static getFocusedWindow() { return null }
}

// --- dialog ---
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
}

// --- shell ---
export const shell = {
  openExternal: async () => {},
  openPath: async () => ({ error: '' }),
}

// --- Menu ---
export const Menu = {
  setApplicationMenu: () => {},
  buildFromTemplate: () => ({}),
  getApplicationMenu: () => null,
}

// --- nativeTheme ---
export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: true,
  on: () => {},
}

// --- screen ---
export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
}

// Default export matches Electron's module shape
export default {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  BrowserWindow,
  dialog,
  shell,
  Menu,
  nativeTheme,
  screen,
}
