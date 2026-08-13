import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ipcMain, BrowserWindow } from 'electron'
import { query as sdkQuery } from '../sdk'
import { logger } from './logger'
import { SessionManager } from './session-manager'
import { AutomationManager } from './automation-manager'
import { RemoteDispatcher } from './remote-dispatcher'
import { commandRegistry, desktopConnection, registerCommand } from '../ipc/command-registry'
import { BaseSession } from '../providers/BaseSession'
import type {
  ClaudeUIPlugin,
  PluginContext,
  PluginInfo,
  PluginViewConfig,
  PluginViewWithOwner,
  Disposable
} from '../../shared/types'

const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'ui', 'plugins')
const ACTIVATION_TIMEOUT_MS = 10_000
const LOG_SOURCE = 'plugin-manager'

/**
 * Capability/kind for every `plugin:<id>:<channel>` a plugin registers.
 *
 * PARITY: plugin remote handlers are reachable from a remote client today (the
 * pre-registry dispatcher never denylisted them), so their capability has to be
 * one a remote connection is granted — hence `config`, the extension/config
 * bucket, and NOT `admin`, which would silently remove a working surface. The
 * honest caveat is that plugin code runs unsandboxed in the main process, so
 * `config` under-states the authority a plugin channel actually carries; making
 * plugins declare their own capability is a follow-up, not a phase-1 change.
 * `command` (never `query`) so every plugin invocation lands in the audit log.
 */
const PLUGIN_CHANNEL_DECLARATION = { capability: 'config', kind: 'command' } as const

// ---------------------------------------------------------------------------
// PluginBridge — virtual BrowserWindow that bridges session events to plugins
// ---------------------------------------------------------------------------

class PluginBridge {
  private destroyed = false
  private pushFn: ((channel: string, ...args: unknown[]) => void) | null = null

  onEvent(fn: (channel: string, ...args: unknown[]) => void): void {
    this.pushFn = fn
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  get webContents(): { send: (channel: string, ...args: unknown[]) => void } {
    return {
      send: (channel: string, ...args: unknown[]): void => {
        if (!this.destroyed && this.pushFn) {
          this.pushFn(channel, ...args)
        }
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.pushFn = null
  }
}

// ---------------------------------------------------------------------------
// LoadedPlugin — internal tracking
// ---------------------------------------------------------------------------

interface LoadedPlugin {
  id: string
  name: string
  version: string
  pluginDir: string
  module: ClaudeUIPlugin
  disposables: Disposable[]
  views: PluginViewConfig[]
  enabled: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private bridge: PluginBridge
  private win: BrowserWindow
  private sessionManager: SessionManager
  private automationManager: AutomationManager
  private remoteDispatcher: RemoteDispatcher
  private tracing = process.env.CLAUDEUI_PLUGIN_TRACE === '1'

  constructor(opts: {
    win: BrowserWindow
    sessionManager: SessionManager
    automationManager: AutomationManager
    remoteDispatcher: RemoteDispatcher
  }) {
    this.win = opts.win
    this.sessionManager = opts.sessionManager
    this.automationManager = opts.automationManager
    this.remoteDispatcher = opts.remoteDispatcher

    // Create bridge and wire it to the event bus.
    // Session events arrive as (channel, routingId, data) from BaseSession.send().
    // We wrap them into an object with { routingId, sessionId, ...data } so plugins
    // get a stable, self-documenting event shape (see ADR-005).
    this.bridge = new PluginBridge()
    this.bridge.onEvent((channel, ...args) => {
      if (this.tracing) {
        logger.debug(LOG_SOURCE, `[trace] ${channel} ${JSON.stringify(args).slice(0, 200)}`)
      }
      if (channel.startsWith('session:') && args.length >= 2) {
        const routingId = args[0] as string
        const data = args[1]
        const sessionId = this.sessionManager.getSessionId(routingId)
        this.fireEvent(channel, {
          routingId,
          sessionId,
          ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : { data })
        })
      } else {
        this.fireEvent(channel, ...args)
      }
    })
    BaseSession.addExtraWindow(this.bridge as unknown as BrowserWindow)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async loadAll(): Promise<void> {
    if (!fs.existsSync(PLUGINS_DIR)) {
      logger.debug(LOG_SOURCE, `No plugins directory at ${PLUGINS_DIR}`)
      return
    }

    const entries = fs
      .readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort()

    logger.info(LOG_SOURCE, `Scanning ${entries.length} plugin(s) in ${PLUGINS_DIR}`)

    for (const dirName of entries) {
      try {
        await this.loadPlugin(dirName)
      } catch (err) {
        logger.error(LOG_SOURCE, `Failed to load plugin "${dirName}"`, err)
      }
    }

    // Emit plugin:all-loaded event
    this.fireEvent('plugin:all-loaded')
    logger.info(LOG_SOURCE, `Loaded ${this.plugins.size} plugin(s)`)
  }

  async reloadPlugin(id: string): Promise<void> {
    const existing = this.plugins.get(id)
    if (existing) {
      await this.deactivatePlugin(id)
      this.clearRequireCache(existing.pluginDir)
    }
    await this.loadPlugin(id)
    this.notifyViewsChanged()
  }

  stopAll(): void {
    const ids = [...this.plugins.keys()].reverse()
    for (const id of ids) {
      try {
        this.deactivatePluginSync(id)
      } catch (err) {
        logger.error(LOG_SOURCE, `Error deactivating plugin "${id}" during shutdown`, err)
      }
    }
    BaseSession.removeExtraWindow(this.bridge as unknown as BrowserWindow)
    this.bridge.destroy()
  }

  listPlugins(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      enabled: p.enabled,
      views: p.views,
      error: p.error
    }))
  }

  getViews(): PluginViewWithOwner[] {
    const views: PluginViewWithOwner[] = []
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) continue
      for (const view of plugin.views) {
        views.push({ ...view, pluginId: plugin.id })
      }
    }
    return views
  }

  // -------------------------------------------------------------------------
  // Loading & activation
  // -------------------------------------------------------------------------

  private async loadPlugin(dirName: string): Promise<void> {
    const pluginDir = path.join(PLUGINS_DIR, dirName)
    const pkgPath = path.join(pluginDir, 'package.json')

    if (!fs.existsSync(pkgPath)) {
      logger.debug(LOG_SOURCE, `Skipping "${dirName}" — no package.json`)
      return
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const claudeui = pkg.claudeui
    if (!claudeui?.plugin) {
      logger.debug(LOG_SOURCE, `Skipping "${dirName}" — claudeui.plugin not set`)
      return
    }

    const entryPoint = claudeui.entryPoint || 'dist/index.js'
    const entryPath = path.join(pluginDir, entryPoint)

    if (!fs.existsSync(entryPath)) {
      const error = `Entry point not found: ${entryPath}`
      logger.error(LOG_SOURCE, error)
      this.plugins.set(dirName, {
        id: dirName,
        name: claudeui.displayName || pkg.name || dirName,
        version: pkg.version || '0.0.0',
        pluginDir,
        module: { activate: () => {} },
        disposables: [],
        views: [],
        enabled: false,
        error
      })
      return
    }

    // Plugins are arbitrary CommonJS modules loaded synchronously from disk at
    // runtime; require() is the correct primitive here, not a static import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(entryPath)
    const plugin: ClaudeUIPlugin = mod.default || mod

    if (typeof plugin.activate !== 'function') {
      const error = `Plugin "${dirName}" does not export an activate() function`
      logger.error(LOG_SOURCE, error)
      this.plugins.set(dirName, {
        id: dirName,
        name: claudeui.displayName || pkg.name || dirName,
        version: pkg.version || '0.0.0',
        pluginDir,
        module: plugin,
        disposables: [],
        views: [],
        enabled: false,
        error
      })
      return
    }

    const loaded: LoadedPlugin = {
      id: dirName,
      name: claudeui.displayName || pkg.name || dirName,
      version: pkg.version || '0.0.0',
      pluginDir,
      module: plugin,
      disposables: [],
      views: [],
      enabled: false
    }
    this.plugins.set(dirName, loaded)

    const ctx = this.buildContext(loaded)

    try {
      await this.activateWithTimeout(loaded, ctx)
      loaded.enabled = true
      logger.info(LOG_SOURCE, `Activated plugin "${dirName}" (${loaded.name} v${loaded.version})`)
    } catch (err) {
      loaded.error = err instanceof Error ? err.message : String(err)
      logger.error(LOG_SOURCE, `Activation failed for "${dirName}"`, err)
      // Clean up any partially registered resources
      this.disposeAll(loaded)
    }

    this.notifyViewsChanged()
  }

  private async activateWithTimeout(loaded: LoadedPlugin, ctx: PluginContext): Promise<void> {
    const result = loaded.module.activate(ctx)
    if (result instanceof Promise) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Plugin "${loaded.id}" activation timed out after ${ACTIVATION_TIMEOUT_MS}ms`
              )
            ),
          ACTIVATION_TIMEOUT_MS
        )
      )
      await Promise.race([result, timeout])
    }
  }

  // -------------------------------------------------------------------------
  // Deactivation & cleanup
  // -------------------------------------------------------------------------

  private async deactivatePlugin(id: string): Promise<void> {
    const loaded = this.plugins.get(id)
    if (!loaded) return

    this.disposeAll(loaded)

    if (loaded.module.deactivate) {
      try {
        const result = loaded.module.deactivate()
        if (result instanceof Promise) {
          await Promise.race([result, new Promise<void>((resolve) => setTimeout(resolve, 5000))])
        }
      } catch (err) {
        logger.error(LOG_SOURCE, `Error in deactivate() for "${id}"`, err)
      }
    }

    loaded.enabled = false
    this.plugins.delete(id)
    logger.info(LOG_SOURCE, `Deactivated plugin "${id}"`)
  }

  private deactivatePluginSync(id: string): void {
    const loaded = this.plugins.get(id)
    if (!loaded) return

    this.disposeAll(loaded)

    if (loaded.module.deactivate) {
      try {
        loaded.module.deactivate()
      } catch (err) {
        logger.error(LOG_SOURCE, `Error in deactivate() for "${id}"`, err)
      }
    }

    loaded.enabled = false
    this.plugins.delete(id)
  }

  private disposeAll(loaded: LoadedPlugin): void {
    for (const d of loaded.disposables) {
      try {
        d.dispose()
      } catch {
        /* ignore */
      }
    }
    loaded.disposables = []
    loaded.views = []
  }

  // -------------------------------------------------------------------------
  // Context builder
  // -------------------------------------------------------------------------

  private buildContext(loaded: LoadedPlugin): PluginContext {
    const { id, pluginDir } = loaded
    const dataDir = path.join(pluginDir, 'data')
    const isDebug = process.env.CLAUDEUI_PLUGIN_DEBUG === '1'

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    const pluginLogger = {
      info: (msg: string) => logger.info(`plugin:${id}`, msg),
      warn: (msg: string, err?: unknown) => logger.warn(`plugin:${id}`, msg, err),
      error: (msg: string, err?: unknown) => logger.error(`plugin:${id}`, msg, err),
      debug: (msg: string) => logger.debug(`plugin:${id}`, msg)
    }

    const ctx: PluginContext = {
      id,
      pluginDir,
      dataDir,
      configDir: pluginDir,
      debug: isDebug,
      logger: pluginLogger,

      sessions: this.sessionManager,
      automations: this.automationManager,
      window: this.win,
      ipcMain,
      sdkQuery,

      on: (event: string, handler: (...args: unknown[]) => void): Disposable => {
        let listeners = this.eventListeners.get(event)
        if (!listeners) {
          listeners = new Set()
          this.eventListeners.set(event, listeners)
        }
        listeners.add(handler)

        const disposable: Disposable = {
          dispose: () => {
            listeners!.delete(handler)
            if (listeners!.size === 0) {
              this.eventListeners.delete(event)
            }
          }
        }
        loaded.disposables.push(disposable)
        return disposable
      },

      emit: (event: string, ...args: unknown[]): void => {
        const namespacedEvent = `plugin:${id}:${event}`
        if (this.tracing) {
          logger.debug(LOG_SOURCE, `[trace] emit ${namespacedEvent}`)
        }
        // Fire on event bus
        this.fireEvent(namespacedEvent, ...args)
        // Forward to renderer
        if (!this.win.isDestroyed()) {
          this.win.webContents.send(namespacedEvent, ...args)
        }
      },

      registerIpcHandler: (
        channel: string,
        handler: (...args: unknown[]) => unknown
      ): Disposable => {
        const fullChannel = `plugin:${id}:${channel}`
        registerCommand({
          channel: fullChannel,
          ...PLUGIN_CHANNEL_DECLARATION,
          transport: 'desktop',
          handler: (...args: unknown[]) => handler(...args)
        })
        ipcMain.handle(fullChannel, (_event, ...args: unknown[]) =>
          commandRegistry.dispatch(fullChannel, 'desktop', args, desktopConnection())
        )
        pluginLogger.debug(`Registered IPC handler: ${fullChannel}`)

        const disposable: Disposable = {
          dispose: () => {
            ipcMain.removeHandler(fullChannel)
            commandRegistry.unregister(fullChannel, 'desktop')
            pluginLogger.debug(`Removed IPC handler: ${fullChannel}`)
          }
        }
        loaded.disposables.push(disposable)
        return disposable
      },

      registerRemoteHandler: (
        channel: string,
        handler: (...args: unknown[]) => unknown
      ): Disposable => {
        const fullChannel = `plugin:${id}:${channel}`
        registerCommand({
          channel: fullChannel,
          ...PLUGIN_CHANNEL_DECLARATION,
          transport: 'remote',
          handler: async (...args: unknown[]) => handler(...args)
        })
        pluginLogger.debug(`Registered remote handler: ${fullChannel}`)

        const disposable: Disposable = {
          dispose: () => {
            this.remoteDispatcher.unregister(fullChannel)
            pluginLogger.debug(`Removed remote handler: ${fullChannel}`)
          }
        }
        loaded.disposables.push(disposable)
        return disposable
      },

      registerView: (config): Disposable => {
        const viewConfig: PluginViewConfig = {
          id: config.id || id,
          label: config.label,
          icon: config.icon,
          htmlFile: path.isAbsolute(config.htmlFile)
            ? config.htmlFile
            : path.join(pluginDir, config.htmlFile)
        }
        loaded.views.push(viewConfig)
        this.notifyViewsChanged()
        pluginLogger.info(`Registered view: ${viewConfig.label} (${viewConfig.id})`)

        const disposable: Disposable = {
          dispose: () => {
            const idx = loaded.views.indexOf(viewConfig)
            if (idx >= 0) loaded.views.splice(idx, 1)
            this.notifyViewsChanged()
            pluginLogger.debug(`Removed view: ${viewConfig.id}`)
          }
        }
        loaded.disposables.push(disposable)
        return disposable
      }
    }

    return ctx
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  private fireEvent(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event)
    if (!listeners) return
    for (const fn of listeners) {
      try {
        fn(...args)
      } catch (err) {
        logger.error(LOG_SOURCE, `Error in event listener for "${event}"`, err)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private notifyViewsChanged(): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('plugin:views-changed', this.getViews())
    }
  }

  private clearRequireCache(pluginDir: string): void {
    // Normalize to handle Windows backslashes
    const normalized = pluginDir.replace(/\\/g, '/')
    for (const key of Object.keys(require.cache)) {
      if (key.replace(/\\/g, '/').startsWith(normalized)) {
        delete require.cache[key]
      }
    }
  }
}
