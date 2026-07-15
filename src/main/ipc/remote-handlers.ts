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
import { deleteProjectFiles } from '../services/delete-session-files'
import { deleteSessionByEngine } from '../services/session-delete'
import { loadSettings, loadSessionConfig, loadSlashCommands } from '../services/ui-config'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import { loadClaudePermissions, loadCleanupPeriodDays } from '../services/claude-settings'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { scanCustomCommands } from '../services/custom-command-scanner'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import type { ApprovalDecision, PermissionSuggestion, EngineId } from '../../shared/types'
import type { BrowserWindow } from 'electron'
import { getSdkExecutableOpts } from '../services/claude-session'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import { dispatchedUsageSummary } from '../services/db'
import { BaseSession } from '../providers/BaseSession'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { query as sdkQuery } from '../sdk'
import { logger } from '../services/logger'
import { prepareAndCreateSession } from './create-session'
import {
  sendPrompt,
  watchBackground,
  unwatchBackground,
  readBackgroundRange,
  stopTask,
  backgroundTask,
  dequeueMessage,
  askSideQuestion,
  setEffort,
  setThinkingMode,
  getPlanContent,
  getSessionLogPath,
  mcpStatus,
  setCleanupPeriod,
  loadSkillDetails,
  saveSessions,
  saveUiSettings,
  listDirEntries
} from './handlers-core'

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
      forkSession?: boolean,
      engineId?: EngineId
    ) => {
      await prepareAndCreateSession(
        manager,
        win,
        {
          routingId,
          cwd,
          effort,
          resumeSessionId,
          permissionMode,
          model,
          thinkingMode,
          resumeSessionAt,
          forkSession,
          engineId
        },
        { notifyMainWindow: true }
      )
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
    ) => sendPrompt(manager, win, routingId, prompt, attachments)
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
      // Reserved `xeng:` prefix → forwarded cross-engine dispatch approval (ADR-033).
      if (
        requestId.startsWith(XENG_REQUEST_PREFIX) &&
        crossEngineDispatcher.resolveApproval(requestId, decision, answers, updatedPermissions)
      ) {
        return
      }
      manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
    }
  )

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  dispatcher.register('session:watch-background', async (routingId: string, toolUseId: string) =>
    watchBackground(manager, routingId, toolUseId)
  )

  dispatcher.register(
    'session:unwatch-background',
    async (routingId: string, toolUseId: string) => unwatchBackground(manager, routingId, toolUseId)
  )

  dispatcher.register(
    'session:read-background-range',
    async (routingId: string, toolUseId: string, offset: number, length: number) =>
      readBackgroundRange(manager, routingId, toolUseId, offset, length)
  )

  dispatcher.register(
    'session:stop-task',
    async (routingId: string, toolUseId: string, isDispatch?: boolean) => {
      // Mirrors session.ipc.ts — route dispatch toolUseIds to the dispatcher
      // FIRST (ADR-033 M3), same precedent as the xeng: approval-response
      // routing. routingId scopes the stop to the OWNING session. isDispatch
      // (renderer knows the card): arm a durable stop-intent, never fall
      // through to the session path.
      if (isDispatch) {
        crossEngineDispatcher.stopDispatch(toolUseId, routingId, { armIfUnknown: true })
        return { success: true }
      }
      if (crossEngineDispatcher.stopDispatch(toolUseId, routingId)) return { success: true }
      return stopTask(manager, routingId, toolUseId)
    }
  )

  dispatcher.register('session:background-task', async (routingId: string, toolUseId: string) =>
    backgroundTask(manager, routingId, toolUseId)
  )

  dispatcher.register('session:dequeue-message', async (routingId: string, value: string) =>
    dequeueMessage(manager, routingId, value)
  )

  dispatcher.register('session:set-permission-mode', async (routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  dispatcher.register('session:set-model', async (routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  dispatcher.register('session:set-effort', async (routingId: string, effort: string) =>
    setEffort(manager, routingId, effort)
  )

  dispatcher.register('session:set-thinking-mode', async (routingId: string, mode: string) =>
    setThinkingMode(manager, routingId, mode)
  )

  dispatcher.register('session:ask-side-question', async (routingId: string, question: string) =>
    askSideQuestion(manager, routingId, question)
  )

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

  dispatcher.register('session:get-plan-content', async (routingId: string) =>
    getPlanContent(manager, routingId)
  )

  dispatcher.register('session:get-session-log-path', async (routingId: string) =>
    getSessionLogPath(manager, routingId)
  )

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

  dispatcher.register('session:delete-session', async (sessionId: string, projectKey: string, engineId?: EngineId) => {
    await deleteSessionByEngine(sessionId, projectKey, engineId)
  })

  dispatcher.register('session:delete-project', async (projectKey: string) => {
    await deleteProjectFiles(projectKey)
  })

  // -------------------------------------------------------------------------
  // Config (read-write, synced bidirectionally)
  // -------------------------------------------------------------------------

  dispatcher.register('config:load-settings', async () => loadSettings())
  dispatcher.register('config:save-settings', async (settings: UISettings) =>
    saveUiSettings(manager, win, settings, { notifyMainWindow: true })
  )
  dispatcher.register('config:load-sessions', async () => loadSessionConfig())
  dispatcher.register('config:save-sessions', async (config: UISessionConfig) =>
    saveSessions(win, config, { notifyMainWindow: true })
  )
  dispatcher.register('config:load-slash-commands', async () => loadSlashCommands())
  dispatcher.register('config:scan-custom-commands', async (cwd: string) => scanCustomCommands(cwd))
  dispatcher.register('config:load-skill-details', async (cwd: string) =>
    loadSkillDetails(manager, cwd)
  )

  // Claude permissions (read-only)
  dispatcher.register('claude:load-permissions', async (scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  )

  // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
  dispatcher.register('claude:get-cleanup-period', async () => loadCleanupPeriodDays())
  dispatcher.register('claude:set-cleanup-period', async (days: number) =>
    setCleanupPeriod(manager, days)
  )

  // MCP config (read-only)
  dispatcher.register('mcp:load-servers', async (scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  )
  dispatcher.register('mcp:read-disabled', async (cwd: string) => readDisabledMcpServers(cwd))

  // MCP runtime (Claude-only: capabilities.hostedMcp AND method presence —
  // opencode advertises hostedMcp:true but does not implement mcpServerStatus)
  dispatcher.register('mcp:status', async (routingId: string) => mcpStatus(manager, routingId))

  // -------------------------------------------------------------------------
  // File listing (for folder browser on web)
  // -------------------------------------------------------------------------

  dispatcher.register('file:list-dir', async (dirPath: string) => listDirEntries(dirPath))

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

  // ADR-033 M4-B: cross-engine dispatched usage, all-time, grouped by
  // (targetEngine, targetModel). Read-only DB aggregate — safe over remote.
  dispatcher.register('usage:fetch-dispatched', async () => {
    return dispatchedUsageSummary()
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
        for (const w of BaseSession.getExtraWindows()) {
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
