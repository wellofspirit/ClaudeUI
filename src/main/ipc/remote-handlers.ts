import * as fs from 'fs'
import * as path from 'path'
import { RemoteDispatcher } from '../services/remote-dispatcher'
import { SessionManager } from '../services/session-manager'
import {
  listDirectories,
  loadSessionHistory,
  loadSubagentHistory,
  buildSubagentFileMap,
  loadBackgroundOutput,
  resolveForkAnchor
} from '../services/session-history'
import { deleteSessionFiles, deleteProjectFiles } from '../services/delete-session-files'
import {
  loadSettings,
  saveSettings,
  loadSessionConfig,
  saveSessionConfig,
  loadSlashCommands
} from '../services/ui-config'
import { invalidateMockupSecuritySettings } from '../services/mockup-settings'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import {
  loadClaudePermissions,
  loadCleanupPeriodDays,
  saveCleanupPeriodDays
} from '../services/claude-settings'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { scanSkills } from '../services/skill-scanner'
import { scanCustomCommands } from '../services/custom-command-scanner'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import type { ApprovalDecision, SandboxSettings, PermissionSuggestion } from '../../shared/types'
import type { BrowserWindow } from 'electron'
import { ClaudeSession, getSdkExecutableOpts } from '../services/claude-session'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { query as sdkQuery } from '../sdk'
import { logger } from '../services/logger'
import type { ISession } from '../providers/ISession'

/** Type guard: narrows ISession to ClaudeSession when engineId === 'claude'. */
function isClaudeSession(session: ISession): session is ClaudeSession {
  return session.engineId === 'claude'
}

/**
 * Registers handler functions on the RemoteDispatcher.
 * These are the same operations exposed via IPC, but called by the WebSocket
 * server instead of ipcMain.handle. The dispatcher's built-in blocklist
 * prevents desktop-only channels from being registered.
 */
/**
 * The dispatcher registered via registerRemoteHandlers. Captured so that
 * version info — computed later in the app bootstrap, after this runs — can
 * still be registered against the live dispatcher.
 */
let activeDispatcher: RemoteDispatcher | null = null

/**
 * Register the `app:version-info` channel on the remote dispatcher. Called
 * from the main bootstrap once the build versions are known (they're computed
 * after registerRemoteHandlers runs). No-op if remote handlers aren't set up.
 */
export function registerRemoteVersionInfo(versionInfo: {
  appVersion: string
  sdkVersion: string
  cliVersion: string
}): void {
  activeDispatcher?.register('app:version-info', async () => versionInfo)
}

export function registerRemoteHandlers(
  dispatcher: RemoteDispatcher,
  manager: SessionManager,
  win: BrowserWindow
): void {
  activeDispatcher = dispatcher

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  dispatcher.register(
    'session:create',
    async (
      routingId: string,
      cwd: string,
      effort?: string,
      resumeSessionId?: string,
      permissionMode?: string,
      model?: string,
      thinkingMode?: string,
      resumeSessionAt?: string,
      forkSession?: boolean
    ) => {
      const settings = loadSettings() as Record<string, unknown>
      const sandboxConfig = (settings.sandbox as SandboxSettings) || undefined
      manager.create(
        routingId,
        win,
        cwd,
        effort,
        resumeSessionId,
        permissionMode,
        model,
        sandboxConfig,
        thinkingMode,
        resumeSessionAt,
        forkSession
      )
      // Notify local desktop + all extra windows (remote bridge → other remote clients)
      if (!win.isDestroyed()) {
        win.webContents.send('session:created', routingId, { cwd, resumeSessionId })
      }
      for (const w of ClaudeSession.getExtraWindows()) {
        if (!w.isDestroyed())
          w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
      }
    }
  )

  dispatcher.register('session:rekey', async (oldId: string, newId: string) => {
    manager.rekey(oldId, newId)
  })

  dispatcher.register(
    'session:resolve-fork-anchor',
    async (sessionId: string, cwd: string, messageId: string) => {
      return await resolveForkAnchor(sessionId, cwd, messageId)
    }
  )

  dispatcher.register(
    'session:send',
    async (
      routingId: string,
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => {
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
    }
  )

  dispatcher.register('session:cancel', async (routingId: string) => {
    manager.cancel(routingId)
  })

  dispatcher.register('session:interrupt', async (routingId: string) => {
    await manager.interrupt(routingId)
  })

  dispatcher.register(
    'session:approval-response',
    async (
      routingId: string,
      requestId: string,
      decision: ApprovalDecision,
      answers?: Record<string, string>,
      updatedPermissions?: PermissionSuggestion[]
    ) => {
      manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
    }
  )

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  dispatcher.register('session:watch-background', async (routingId: string, toolUseId: string) => {
    const s = manager.get(routingId)
    if (s?.capabilities.backgroundTasks && isClaudeSession(s)) s.watchBackground(toolUseId)
  })

  dispatcher.register(
    'session:unwatch-background',
    async (routingId: string, toolUseId: string) => {
      const s = manager.get(routingId)
      if (s?.capabilities.backgroundTasks && isClaudeSession(s)) s.unwatchBackground(toolUseId)
    }
  )

  dispatcher.register(
    'session:read-background-range',
    async (routingId: string, toolUseId: string, offset: number, length: number) => {
      const s = manager.get(routingId)
      if (s?.capabilities.backgroundTasks && isClaudeSession(s))
        return s.readBackgroundRange(toolUseId, offset, length)
      return ''
    }
  )

  dispatcher.register('session:stop-task', async (routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) return { success: false, error: 'No active session' }
    if (!session.capabilities.backgroundTasks || !isClaudeSession(session))
      return { success: false, error: 'Provider does not support background tasks' }
    return await session.stopTask(toolUseId)
  })

  dispatcher.register('session:background-task', async (routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) return { success: false, error: 'No active session' }
    if (!session.capabilities.backgroundTasks || !isClaudeSession(session))
      return { success: false, error: 'Provider does not support background tasks' }
    return await session.backgroundTask(toolUseId)
  })

  dispatcher.register('session:dequeue-message', async (routingId: string, value: string) => {
    const session = manager.get(routingId)
    if (!session || !isClaudeSession(session)) return { removed: 0 }
    return await session.dequeueMessage(value)
  })

  dispatcher.register('session:set-permission-mode', async (routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  dispatcher.register('session:set-model', async (routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  dispatcher.register('session:set-effort', async (routingId: string, effort: string) => {
    const s = manager.get(routingId)
    if (s?.capabilities.reasoning.effort != null && isClaudeSession(s)) s.setEffort(effort)
  })

  dispatcher.register('session:set-thinking-mode', async (routingId: string, mode: string) => {
    const s = manager.get(routingId)
    if (s?.capabilities.reasoning.thinking != null && isClaudeSession(s)) s.setThinkingMode(mode)
  })

  dispatcher.register('session:ask-side-question', async (routingId: string, question: string) => {
    const session = manager.get(routingId)
    if (!session) return null
    if (!session.capabilities.sideQuestion || !isClaudeSession(session)) return null
    return await session.askSideQuestion(question)
  })

  // -------------------------------------------------------------------------
  // Session queries
  // -------------------------------------------------------------------------

  dispatcher.register('session:get-models', async () => {
    const abort = new AbortController()
    const q = sdkQuery({
      prompt: '',
      options: {
        ...getSdkExecutableOpts(),
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
    const s = manager.get(routingId)
    if (s?.capabilities.plan && isClaudeSession(s)) return s.getPlanContent() ?? null
    return null
  })

  dispatcher.register('session:get-session-log-path', async (routingId: string) => {
    const s = manager.get(routingId)
    if (s && isClaudeSession(s)) return s.getSessionLogPath() ?? null
    return null
  })

  dispatcher.register('session:list-directories', async () => {
    return await listDirectories()
  })

  dispatcher.register('session:load-history', async (sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  dispatcher.register(
    'session:load-subagent-history',
    async (sessionId: string, projectKey: string, agentId: string) => {
      return await loadSubagentHistory(sessionId, projectKey, agentId)
    }
  )

  dispatcher.register(
    'session:build-subagent-file-map',
    async (sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
      return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
    }
  )

  dispatcher.register(
    'session:load-background-output',
    async (projectKey: string, taskId: string, outputFile?: string) => {
      return loadBackgroundOutput(projectKey, taskId, outputFile)
    }
  )

  dispatcher.register('session:delete-session', async (sessionId: string, projectKey: string) => {
    await deleteSessionFiles(sessionId, projectKey)
  })

  dispatcher.register('session:delete-project', async (projectKey: string) => {
    await deleteProjectFiles(projectKey)
  })

  // -------------------------------------------------------------------------
  // Config (read-write, synced bidirectionally)
  // -------------------------------------------------------------------------

  dispatcher.register('config:load-settings', async () => loadSettings())
  dispatcher.register('config:save-settings', async (settings: UISettings) => {
    saveSettings(settings)
    invalidateMockupSecuritySettings()
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
  dispatcher.register('config:scan-custom-commands', async (cwd: string) => scanCustomCommands(cwd))
  dispatcher.register('config:load-skill-details', async (cwd: string) => scanSkills(cwd))

  // Claude permissions (read-only)
  dispatcher.register('claude:load-permissions', async (scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  )

  // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
  dispatcher.register('claude:get-cleanup-period', async () => loadCleanupPeriodDays())
  dispatcher.register('claude:set-cleanup-period', async (days: number) => {
    saveCleanupPeriodDays(days)
    manager.forEachClaude((session) => session.notifySettingsChanged().catch(() => {}))
  })

  // MCP config (read-only)
  dispatcher.register('mcp:load-servers', async (scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  )
  dispatcher.register('mcp:read-disabled', async (cwd: string) => readDisabledMcpServers(cwd))

  // MCP runtime (Claude-only: capabilities.hostedMcp)
  dispatcher.register('mcp:status', async (routingId: string) => {
    const session = manager.get(routingId)
    if (!session || !session.capabilities.hostedMcp || !isClaudeSession(session)) return []
    return await session.mcpServerStatus()
  })

  // -------------------------------------------------------------------------
  // File listing (for folder browser on web)
  // -------------------------------------------------------------------------

  dispatcher.register('file:list-dir', async (dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const HIDDEN_NAMES = new Set([
        'node_modules',
        '.git',
        '.DS_Store',
        '__pycache__',
        '.next',
        '.cache'
      ])
      const result: Array<{ name: string; isDirectory: boolean }> = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || HIDDEN_NAMES.has(entry.name)) continue
        result.push({
          name: entry.name,
          isDirectory: entry.isDirectory() || entry.isSymbolicLink()
        })
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

  dispatcher.register('usage:set-account-filter', async (account: string | null) => {
    blockUsageService.setAccountFilter(account)
  })

  // -------------------------------------------------------------------------
  // Mockup preview — read HTML + watch the mockup directory for live reloads
  // -------------------------------------------------------------------------

  dispatcher.register('mockup:read-html', async (cwd: string, directory: string) => {
    const htmlPath = path.join(cwd, '.claude', 'ui', 'mockups', directory, 'index.html')
    return fs.promises.readFile(htmlPath, 'utf-8')
  })

  const mockupWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }
  >()

  dispatcher.register('mockup:watch', async (cwd: string, directory: string) => {
    const key = `${cwd}:${directory}`
    if (mockupWatchers.has(key)) return // already watching

    const dirPath = path.join(cwd, '.claude', 'ui', 'mockups', directory)
    if (!fs.existsSync(dirPath)) return

    const entry = {
      watcher: null! as fs.FSWatcher,
      debounceTimer: null as ReturnType<typeof setTimeout> | null
    }

    // Recursive + debounced, matching the desktop IPC watcher in session.ipc.ts.
    // Broadcast to the local desktop window AND all extra windows (remote bridge
    // → connected web clients) so a mockup open remotely live-reloads on edit.
    entry.watcher = fs.watch(dirPath, { recursive: true }, (_event, filename) => {
      if (!filename) return
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('mockup:file-changed', directory)
        for (const w of ClaudeSession.getExtraWindows()) {
          if (!w.isDestroyed()) w.webContents.send('mockup:file-changed', directory)
        }
      }, 200)
    })

    mockupWatchers.set(key, entry)
  })

  dispatcher.register('mockup:unwatch', async (cwd: string, directory: string) => {
    const key = `${cwd}:${directory}`
    const entry = mockupWatchers.get(key)
    if (entry) {
      entry.watcher.close()
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      mockupWatchers.delete(key)
    }
  })

  logger.info('remote-handlers', `Registered ${dispatcher.channels().length} remote handlers`)
}
