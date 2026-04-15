/**
 * TestIpcBridge — In-process replacement for Electron IPC transport.
 *
 * Faithfully implements the two Electron IPC patterns:
 * 1. Request-response: ipcRenderer.invoke() → ipcMain.handle() → return result
 * 2. Push events: webContents.send() → ipcRenderer.on() callbacks
 *
 * No behavior assumptions — just message passing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class TestIpcBridge {
  private handlers = new Map<string, (...args: any[]) => any>()
  private rendererListeners = new Map<string, Set<(...args: any[]) => void>>()
  private mainListeners = new Map<string, Set<(...args: any[]) => void>>()

  // --- Main-side API (replaces ipcMain) ---
  readonly ipcMain = {
    handle: (channel: string, handler: (event: any, ...args: any[]) => any): void => {
      this.handlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      this.handlers.delete(channel)
    },
    on: (channel: string, handler: (event: any, ...args: any[]) => void): void => {
      if (!this.mainListeners.has(channel)) this.mainListeners.set(channel, new Set())
      this.mainListeners.get(channel)!.add(handler)
    },
    removeListener: (channel: string, handler: (...args: any[]) => void): void => {
      this.mainListeners.get(channel)?.delete(handler)
    },
  }

  // --- Renderer-side API (replaces ipcRenderer) ---
  readonly ipcRenderer = {
    invoke: async (channel: string, ...args: any[]): Promise<any> => {
      const handler = this.handlers.get(channel)
      if (!handler) {
        throw new Error(`TestIpcBridge: No handler registered for channel "${channel}"`)
      }
      // Pass a fake IpcMainInvokeEvent as first arg (matches Electron convention)
      const fakeEvent = { sender: this.webContents }
      return handler(fakeEvent, ...args)
    },
    on: (channel: string, handler: (event: any, ...args: any[]) => void): this['ipcRenderer'] => {
      if (!this.rendererListeners.has(channel)) this.rendererListeners.set(channel, new Set())
      this.rendererListeners.get(channel)!.add(handler)
      return this.ipcRenderer
    },
    removeListener: (channel: string, handler: (...args: any[]) => void): this['ipcRenderer'] => {
      this.rendererListeners.get(channel)?.delete(handler)
      return this.ipcRenderer
    },
    send: (channel: string, ...args: any[]): void => {
      // Fire-and-forget from renderer to main (e.g., log:error, log:relay)
      const fakeEvent = { sender: this.webContents }
      this.mainListeners.get(channel)?.forEach((handler) => {
        try { handler(fakeEvent, ...args) } catch { /* ignore */ }
      })
    },
  }

  // --- Mock webContents (used by BrowserWindow.webContents.send) ---
  readonly webContents = {
    send: (channel: string, ...args: any[]): void => {
      // Push event from main to renderer
      // Electron passes IpcRendererEvent as first arg to on() callbacks
      const fakeEvent = {}
      this.rendererListeners.get(channel)?.forEach((handler) => {
        try { handler(fakeEvent, ...args) } catch { /* ignore */ }
      })
    },
    isDevToolsOpened: (): boolean => false,
    closeDevTools: (): void => {},
    openDevTools: (): void => {},
    id: 1,
  }

  /**
   * Create a mock BrowserWindow backed by this bridge.
   * ClaudeSession and IPC handlers receive this as `win`.
   */
  createBrowserWindow(): any {
    return {
      webContents: this.webContents,
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => false,
      isVisible: () => true,
      show: () => {},
      hide: () => {},
      focus: () => {},
      minimize: () => {},
      maximize: () => {},
      unmaximize: () => {},
      close: () => {},
      setTitle: () => {},
      getTitle: () => 'Test Window',
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      setBounds: () => {},
      on: () => {},
      once: () => {},
      removeListener: () => {},
      removeAllListeners: () => {},
    }
  }

  /** Remove all handlers and listeners. Call in afterEach(). */
  reset(): void {
    this.handlers.clear()
    this.rendererListeners.clear()
    this.mainListeners.clear()
  }
}
