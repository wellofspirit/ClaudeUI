import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RemoteDispatcher } from '../services/remote-dispatcher'
import { SessionManager } from '../services/session-manager'
import { listDirectories, loadSessionHistory, loadSubagentHistory, buildSubagentFileMap, loadBackgroundOutput } from '../services/session-history'
import { loadSettings, saveSettings, loadSessionConfig, saveSessionConfig, loadSlashCommands } from '../services/ui-config'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import { loadClaudePermissions } from '../services/claude-settings'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { scanSkills } from '../services/skill-scanner'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import type { ApprovalDecision, SandboxSettings, PermissionSuggestion } from '../../shared/types'
import type { BrowserWindow } from 'electron'
import { ClaudeSession, getCliJsPath } from '../services/claude-session'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../services/logger'

/**
 * Registers handler functions on the RemoteDispatcher.
 * These are the same operations exposed via IPC, but called by the WebSocket
 * server instead of ipcMain.handle. The dispatcher's built-in blocklist
 * prevents desktop-only channels from being registered.
 */
export function registerRemoteHandlers(
  dispatcher: RemoteDispatcher,
  manager: SessionManager,
  win: BrowserWindow
): void {
  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  dispatcher.register('session:create', async (routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string) => {
    const settings = loadSettings() as Record<string, unknown>
    const sandboxConfig = (settings.sandbox as SandboxSettings) || undefined
    manager.create(routingId, win, cwd, effort, resumeSessionId, permissionMode, model, sandboxConfig)
    // Notify local desktop + all extra windows (remote bridge → other remote clients)
    if (!win.isDestroyed()) {
      win.webContents.send('session:created', routingId, { cwd, resumeSessionId })
    }
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
    }
  })

  dispatcher.register('session:rekey', async (oldId: string, newId: string) => {
    manager.rekey(oldId, newId)
  })

  dispatcher.register('session:send', async (routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) => {
    const session = manager.get(routingId)
    if (!session) throw new Error(`No session for routingId: ${routingId}`)
    // Check before run() — if session already active, the message will be queued
    const queued = session.willQueue
    session.run(prompt, attachments)
    // Notify local desktop + all extra windows (remote bridge → other remote clients)
    const payload = { prompt, attachments, queued }
    if (!win.isDestroyed()) {
      win.webContents.send('session:user-message', routingId, payload)
    }
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('session:user-message', routingId, payload)
    }
  })

  dispatcher.register('session:cancel', async (routingId: string) => {
    manager.cancel(routingId)
  })

  dispatcher.register('session:approval-response', async (routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]) => {
    manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
  })

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  dispatcher.register('session:watch-background', async (routingId: string, toolUseId: string) => {
    manager.get(routingId)?.watchBackground(toolUseId)
  })

  dispatcher.register('session:unwatch-background', async (routingId: string, toolUseId: string) => {
    manager.get(routingId)?.unwatchBackground(toolUseId)
  })

  dispatcher.register('session:read-background-range', async (routingId: string, toolUseId: string, offset: number, length: number) => {
    return manager.get(routingId)?.readBackgroundRange(toolUseId, offset, length) ?? ''
  })

  dispatcher.register('session:stop-task', async (routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) return { success: false, error: 'No active session' }
    return await session.stopTask(toolUseId)
  })

  dispatcher.register('session:background-task', async (routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) return { success: false, error: 'No active session' }
    return await session.backgroundTask(toolUseId)
  })

  dispatcher.register('session:dequeue-message', async (routingId: string, value: string) => {
    const session = manager.get(routingId)
    if (!session) return { removed: 0 }
    return await session.dequeueMessage(value)
  })

  dispatcher.register('session:set-permission-mode', async (routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  dispatcher.register('session:set-model', async (routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  dispatcher.register('session:set-effort', async (routingId: string, effort: string) => {
    manager.get(routingId)?.setEffort(effort)
  })

  // -------------------------------------------------------------------------
  // Session queries
  // -------------------------------------------------------------------------

  dispatcher.register('session:get-models', async () => {
    const abort = new AbortController()
    const cliPath = getCliJsPath()
    const q = sdkQuery({
      prompt: '',
      options: {
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
        cwd: PERSISTED_SESSIONS_DIR,
        abortController: abort
      }
    })
    try {
      return await (q as unknown as { supportedModels(): Promise<unknown[]> }).supportedModels()
    } finally {
      abort.abort()
    }
  })

  dispatcher.register('session:get-plan-content', async (routingId: string) => {
    return manager.get(routingId)?.getPlanContent() ?? null
  })

  dispatcher.register('session:get-session-log-path', async (routingId: string) => {
    return manager.get(routingId)?.getSessionLogPath() ?? null
  })

  dispatcher.register('session:list-directories', async () => {
    return await listDirectories()
  })

  dispatcher.register('session:load-history', async (sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  dispatcher.register('session:load-subagent-history', async (sessionId: string, projectKey: string, agentId: string) => {
    return await loadSubagentHistory(sessionId, projectKey, agentId)
  })

  dispatcher.register('session:build-subagent-file-map', async (sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
    return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
  })

  dispatcher.register('session:load-background-output', async (projectKey: string, taskId: string, outputFile?: string) => {
    return loadBackgroundOutput(projectKey, taskId, outputFile)
  })

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  dispatcher.register('session:get-team-info', async (routingId: string) => {
    return manager.getTeamInfo(routingId)
  })

  dispatcher.register('session:send-to-teammate', async (_routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string) => {
    const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
    await fs.promises.mkdir(inboxDir, { recursive: true })
    const inboxPath = path.join(inboxDir, `${sanitizedAgentName}.json`)
    let items: unknown[] = []
    try {
      const raw = await fs.promises.readFile(inboxPath, 'utf-8')
      items = JSON.parse(raw)
    } catch { /* empty */ }
    items.push({ from: 'user', text: message, timestamp: new Date().toISOString(), read: false })
    await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
  })

  dispatcher.register('session:broadcast-to-team', async (_routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string) => {
    const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
    await fs.promises.mkdir(inboxDir, { recursive: true })
    const entry = { from: 'user', text: message, timestamp: new Date().toISOString(), read: false }
    for (const name of sanitizedAgentNames) {
      const inboxPath = path.join(inboxDir, `${name}.json`)
      let items: unknown[] = []
      try {
        const raw = await fs.promises.readFile(inboxPath, 'utf-8')
        items = JSON.parse(raw)
      } catch { /* empty */ }
      items.push(entry)
      await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
    }
  })

  // -------------------------------------------------------------------------
  // Config (read-write, synced bidirectionally)
  // -------------------------------------------------------------------------

  dispatcher.register('config:load-settings', async () => loadSettings())
  dispatcher.register('config:save-settings', async (settings: UISettings) => {
    saveSettings(settings)
    // Notify local desktop + all extra windows (remote bridge → other remote clients)
    if (!win.isDestroyed()) {
      win.webContents.send('config:settings-changed', settings)
    }
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('config:settings-changed', settings)
    }
  })
  dispatcher.register('config:load-sessions', async () => loadSessionConfig())
  dispatcher.register('config:save-sessions', async (config: UISessionConfig) => {
    saveSessionConfig(config)
    // Notify local desktop + all extra windows (remote bridge → other remote clients)
    if (!win.isDestroyed()) {
      win.webContents.send('config:sessions-changed', config)
    }
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('config:sessions-changed', config)
    }
  })
  dispatcher.register('config:load-slash-commands', async () => loadSlashCommands())
  dispatcher.register('config:load-skill-details', async (cwd: string) => scanSkills(cwd))

  // Claude permissions (read-only)
  dispatcher.register('claude:load-permissions', async (scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd))

  // MCP config (read-only)
  dispatcher.register('mcp:load-servers', async (scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd))
  dispatcher.register('mcp:read-disabled', async (cwd: string) =>
    readDisabledMcpServers(cwd))

  // MCP runtime (via session)
  dispatcher.register('mcp:status', async (routingId: string) => {
    const session = manager.get(routingId)
    if (!session) return []
    return await session.mcpServerStatus()
  })

  // -------------------------------------------------------------------------
  // File listing (for folder browser on web)
  // -------------------------------------------------------------------------

  dispatcher.register('file:list-dir', async (dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const HIDDEN_NAMES = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.next', '.cache'])
      const result: Array<{ name: string; isDirectory: boolean }> = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || HIDDEN_NAMES.has(entry.name)) continue
        result.push({ name: entry.name, isDirectory: entry.isDirectory() || entry.isSymbolicLink() })
      }
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      const resolved = path.resolve(dirPath)
      const isRoot = path.dirname(resolved) === resolved
      const resolvedPosix = resolved.replace(/\\/g, '/').replace(/\/$/, '')
      return { entries: result, isRoot, resolvedPath: resolvedPosix }
    } catch {
      return { entries: [], isRoot: false, resolvedPath: '' }
    }
  })

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  dispatcher.register('usage:fetch', async () => {
    return usageFetcher.fetch()
  })

  dispatcher.register('usage:fetch-block', async () => {
    return blockUsageService.getData() ?? (await blockUsageService.recalculate())
  })

  logger.info('remote-handlers', `Registered ${dispatcher.channels().length} remote handlers`)
}
