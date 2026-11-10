import type { ContentBlock } from './content'

// ---------------------------------------------------------------------------
// Plugin session event types (ADR-005)
// All session events forwarded to plugins are wrapped in this shape.
// ---------------------------------------------------------------------------

/** Base envelope for all session events forwarded to plugins. */
export interface PluginSessionEvent {
  routingId: string
  sessionId: string | null
}

/** session:message event as seen by plugins. */
export interface PluginMessageEvent extends PluginSessionEvent {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
}

/** session:result event as seen by plugins. */
export interface PluginResultEvent extends PluginSessionEvent {
  totalCostUsd: number
  durationMs: number
  result: string
}

/** session:stream event as seen by plugins. */
export interface PluginStreamEvent extends PluginSessionEvent {
  type: 'text' | 'thinking'
  text: string
}

// ---------------------------------------------------------------------------
// Plugin system types
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void
}

export interface PluginViewConfig {
  /** Unique view ID (defaults to plugin ID if only one view) */
  id: string
  /** Label shown in sidebar */
  label: string
  /** SVG icon string for sidebar NavItem */
  icon?: string
  /** Absolute path to HTML file for the webview */
  htmlFile: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  views: PluginViewConfig[]
  error?: string
}

export interface ClaudeUIPlugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

export interface PluginContext {
  /** Plugin ID */
  id: string
  /** Filesystem path to plugin directory */
  pluginDir: string
  /** Data directory for plugin persistence (~/.claude/ui/plugins/<id>/data/) */
  dataDir: string
  /** Config directory (~/.claude/ui/plugins/<id>/) */
  configDir: string
  /** Debug mode (CLAUDEUI_PLUGIN_DEBUG=1) */
  debug: boolean
  /** Namespaced logger */
  logger: {
    info(message: string): void
    warn(message: string, err?: unknown): void
    error(message: string, err?: unknown): void
    debug(message: string): void
  }
  // Core services — typed as `any` here since main-process classes
  // are not importable from shared types. Actual implementations
  // provide the real SessionManager / AutomationManager instances.
  /** Session manager — create/get/cancel sessions */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any
  /** Automation manager */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automations: any
  /** Main window reference */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window: any
  /** Raw ipcMain for advanced use cases */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain: any
  /** SDK query escape hatch */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkQuery: any
  /** Subscribe to session/app events (same payloads as IPC events) */
  on(event: string, handler: (...args: unknown[]) => void): Disposable
  /** Emit custom events (auto-namespaced to plugin:<id>:<event>) */
  emit(event: string, ...args: unknown[]): void
  /** Register an IPC handler (auto-namespaced to plugin:<id>:<channel>) */
  registerIpcHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a remote handler (auto-namespaced to plugin:<id>:<channel>) */
  registerRemoteHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a UI view that replaces the chat panel */
  registerView(config: Omit<PluginViewConfig, 'id'> & { id?: string }): Disposable
}

export type PluginViewWithOwner = PluginViewConfig & { pluginId: string }
