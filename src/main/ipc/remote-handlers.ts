import * as fs from 'fs'
import * as os from 'os'
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
import { isPathInside, assertSafePathSegment } from '../services/path-containment'
import { gitServiceManager } from '../services/git-service'
import { gitWatchRegistry, GIT_WATCH_OWNER_REMOTE } from '../services/git-watch-registry'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { accountManager } from '../services/account-manager'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory
} from '../services/opencode-session-list'
import { listPiSessionsGlobal, loadPiSessionHistory } from '../services/pi-session-list'
import {
  discoverOpencodeModels,
  discoverOpencodeProviderCatalog,
  getOpencodeProviderModels
} from '../opencode/model-discovery'
import {
  removeOpencodeProvider,
  setOpencodeProviderDisabled
} from '../opencode/provider-management'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { discoverPiModels, getPiModelCatalogGroups } from '../pi/model-discovery'
import { piBinaryAvailable, locatePiBinary } from '../pi/pi-locate'
import { credentialSync } from '../auth/vault/CredentialSync'
import type { EngineModelGroup, ModelInfo, ProviderRemoveKind } from '../../shared/types'
import { deleteProjectFiles } from '../services/delete-session-files'
import { deleteSessionByEngine } from '../services/session-delete'
import { loadSettings, loadSessionConfig, loadSlashCommands } from '../services/ui-config'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import {
  loadClaudePermissions,
  loadCleanupPeriodDays,
  isWorkspaceTrusted
} from '../services/claude-settings'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { scanCustomCommands } from '../services/custom-command-scanner'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import type {
  ApprovalDecision,
  PermissionSuggestion,
  EngineId,
  PermissionScope,
  ClaudePermissions
} from '../../shared/types'
import type { BrowserWindow } from 'electron'
import { getSdkExecutableOpts } from '../services/claude-session'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import { dispatchedUsageSummary } from '../services/db'
import { BaseSession } from '../providers/BaseSession'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { query as sdkQuery } from '../sdk'
import { logger } from '../services/logger'
import { sharedProviderService } from '../shared-providers'
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
  setPermissionMode,
  setEffort,
  setThinkingMode,
  getPlanContent,
  getSessionLogPath,
  mcpStatus,
  setCleanupPeriod,
  savePermissionsAndNotify,
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

/**
 * Acquire/release a per-cwd GitService around a call — the exact
 * get/try-finally/release pattern the desktop `git:*` IPC handlers use. The
 * real logic lives in `gitServiceManager`; this only mirrors the thin IPC
 * adapter so the remote surface reuses the same service (not a forked impl).
 */
async function withGit<T>(
  cwd: string,
  fn: (svc: ReturnType<typeof gitServiceManager.get>) => Promise<T>
): Promise<T> {
  const svc = gitServiceManager.get(cwd)
  try {
    return await fn(svc)
  } finally {
    gitServiceManager.release(cwd)
  }
}

/** Uncached claude model list via a throwaway SDK query (no auth-source side
 *  effects — those are desktop-only; see handlers-core.ts rationale). */
async function claudeSupportedModels(): Promise<ModelInfo[]> {
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
    return await (q as unknown as { supportedModels(): Promise<ModelInfo[]> }).supportedModels()
  } finally {
    abort.abort()
  }
}

// Title/commit-message generation. Kept behaviorally identical to the desktop
// twins in session.ipc.ts (importing those would drag session.ipc.ts's whole
// Electron/auth import graph into the hermetically-mocked remote-handlers test).
const COMMIT_MSG_SYSTEM_PROMPT =
  'You are a commit message generator. Given a git diff of staged changes, write a concise conventional commit message. Output ONLY the commit message — no explanation, no quotes, no markdown. Use imperative mood. First line should be a short summary (max 72 chars). If needed, add a blank line followed by bullet points for details. Focus on the "why" not the "what".'

async function generateTitle(conversationText: string): Promise<string | null> {
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
    const handle = q as unknown as {
      generateSessionTitle(
        desc: string,
        opts?: { persist?: boolean }
      ): Promise<{ title?: string | null } | unknown>
    }
    const result = await handle.generateSessionTitle(conversationText, { persist: false })
    const title =
      result && typeof result === 'object' && 'title' in result
        ? (result as { title?: string | null }).title
        : null
    const trimmed = typeof title === 'string' ? title.trim() : ''
    return trimmed.length >= 2 ? trimmed : null
  } catch (err) {
    logger.error('remote-handlers', `generateTitle failed: ${err}`)
    return null
  } finally {
    abort.abort()
  }
}

async function generateCommitMessage(diff: string): Promise<string | null> {
  const abort = new AbortController()
  try {
    const q = sdkQuery({
      prompt: diff,
      options: {
        ...getSdkExecutableOpts(),
        cwd: PERSISTED_SESSIONS_DIR,
        abortController: abort,
        systemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        tools: [],
        thinking: { type: 'disabled' },
        persistSession: false
      }
    })
    let result = ''
    for await (const message of q) {
      if (!message || typeof message !== 'object') continue
      const msg = message as Record<string, unknown>
      if (msg.type === 'assistant') {
        const betaMessage = msg.message as
          | { content?: Array<{ type: string; text?: string }> }
          | undefined
        if (betaMessage?.content) {
          for (const block of betaMessage.content) {
            if (block.type === 'text' && block.text) result += block.text
          }
        }
      }
    }
    const cleaned = result.trim()
    return cleaned.length >= 3 ? cleaned : null
  } catch (err) {
    logger.error('remote-handlers', `generateCommitMessage failed: ${err}`)
    return null
  } finally {
    abort.abort()
  }
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
    async (sessionId: string, cwd: string, messageId: string, engineId: EngineId, messageIndex: number) => {
      return await resolveForkAnchor(sessionId, cwd, messageId, engineId, messageIndex)
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

  dispatcher.register('session:set-permission-mode', async (routingId: string, mode: string) =>
    setPermissionMode(manager, win, routingId, mode)
  )

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

  dispatcher.register('session:get-models', async () => claudeSupportedModels())

  // Cross-engine model catalog (Claude + opencode + pi) for the model picker.
  // Mirrors session.ipc.ts's get-engine-models minus the desktop-only
  // auth-source reporting side effects.
  dispatcher.register('session:get-engine-models', async (): Promise<EngineModelGroup[]> => {
    const claudeModels = (await claudeSupportedModels()).map((m) => ({
      ...m,
      engineId: 'claude' as const,
      vendorId: 'anthropic'
    }))
    const claudeGroup: EngineModelGroup = {
      engineId: 'claude',
      vendorId: 'anthropic',
      vendorName: 'Anthropic',
      models: claudeModels
    }
    const opencodeGroups = await discoverOpencodeModels()
    const piGroups = await discoverPiModels()
    return [claudeGroup, ...opencodeGroups, ...piGroups]
  })

  // Full opencode provider catalog / per-provider models for the allowlist UI.
  dispatcher.register('session:get-opencode-providers', async () => {
    if (!opencodeServerManager.isBinaryAvailable()) return []
    return await discoverOpencodeProviderCatalog()
  })
  dispatcher.register('session:get-opencode-provider-models', async (providerId: string) => {
    if (!opencodeServerManager.isBinaryAvailable()) return []
    return await getOpencodeProviderModels(providerId)
  })
  // Provider enable/disable + removal reach the remote surface too (full parity,
  // token-gated). Removal is destructive, so `kind` is passed through verbatim
  // from the caller's resolved actions — the main-process owner re-derives
  // nothing and widens nothing.
  dispatcher.register(
    'session:set-opencode-provider-disabled',
    async (providerId: string, disabled: boolean) => {
      setOpencodeProviderDisabled(providerId, disabled)
    }
  )
  dispatcher.register(
    'session:remove-opencode-provider',
    async (providerId: string, kind: ProviderRemoveKind) => {
      await removeOpencodeProvider(providerId, kind)
    }
  )
  dispatcher.register('session:get-pi-model-catalog', async () => getPiModelCatalogGroups())

  dispatcher.register('session:set-reasoning-variant', async (routingId: string, variant: string | null) => {
    manager.get(routingId)?.setReasoningVariant?.(variant)
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

  // Multi-engine session listing + history (opencode + pi) for the sidebar.
  dispatcher.register('session:list-opencode', async () => listOpencodeSessionsGlobal())
  dispatcher.register('session:load-opencode-history', async (sessionId: string) =>
    loadOpencodeSessionHistory(sessionId)
  )
  dispatcher.register('session:list-pi', async () => listPiSessionsGlobal())
  dispatcher.register('session:load-pi-history', async (sessionId: string) =>
    loadPiSessionHistory(sessionId)
  )

  // Live transcript watching (drives the remote client's live history view).
  dispatcher.register(
    'session:watch-session',
    async (routingId: string, sessionId: string, projectKey: string) => {
      watchSession(routingId, sessionId, projectKey, win)
    }
  )
  dispatcher.register('session:unwatch-session', async (routingId: string) => {
    unwatchSession(routingId)
  })

  // Persist a custom session title (appends a custom-title JSONL entry).
  dispatcher.register(
    'session:write-custom-title',
    async (sessionId: string, projectKey: string, title: string) => {
      // LOW-RW3: reachable by any token-holding remote client. Without this,
      // projectKey='../..' + a crafted sessionId appends attacker-controlled
      // JSON to an arbitrary *.jsonl on the host. Mirrors the desktop handler
      // in session.ipc.ts and deleteSessionFiles().
      assertSafePathSegment(sessionId, 'sessionId')
      assertSafePathSegment(projectKey, 'projectKey')
      const filePath = path.join(
        os.homedir(),
        '.claude',
        'projects',
        projectKey,
        `${sessionId}.jsonl`
      )
      const entry = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
      await fs.promises.appendFile(filePath, entry + '\n', { mode: 0o600 })
    }
  )

  // Title / commit-message generation (throwaway SDK queries).
  dispatcher.register('session:generate-title', async (conversationText: string) =>
    generateTitle(conversationText)
  )
  dispatcher.register('session:generate-commit-message', async (diff: string) =>
    generateCommitMessage(diff)
  )

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
  dispatcher.register('shared-provider:list', async () => sharedProviderService.listDefinitions())
  dispatcher.register('shared-provider:statuses', async () => sharedProviderService.listStatuses())
  dispatcher.register('shared-provider:models', async (id: string) =>
    sharedProviderService.listProviderModels(id)
  )
  dispatcher.register('config:scan-custom-commands', async (cwd: string) => scanCustomCommands(cwd))
  dispatcher.register('config:load-skill-details', async (cwd: string) =>
    loadSkillDetails(manager, cwd)
  )

  // Claude permissions — full parity with the desktop handler (same
  // save + hot-reload fan-out), consistent with the user decision that the
  // remote token is the sole gate for mutations (see the git block below).
  dispatcher.register('claude:load-permissions', async (scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  )
  dispatcher.register(
    'claude:save-permissions',
    async (scope: string, permissions: ClaudePermissions, cwd?: string) =>
      savePermissionsAndNotify(manager, scope as PermissionScope, permissions, cwd)
  )
  dispatcher.register('claude:workspace-trust', async (cwd: string) => isWorkspaceTrusted(cwd))

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
  // Git — full parity incl. mutations (user decision: token is the sole gate).
  // Same gitServiceManager the desktop git:* IPC handlers use (get/release).
  //
  // Live watching goes through gitWatchRegistry, the SAME registry the desktop
  // `git:start-watching` IPC handler uses, under a separate owner id. It must not
  // start its own poller: GitService.startPolling() holds a single callback, so
  // that would replace the desktop's broadcast. The registry starts at most one
  // poller per cwd, fans `git:status-update` out to the main window AND every
  // extra window (the remote bridge is registered as one, so remote clients get
  // it over the existing forwarding), and replays the cached status to a
  // late-joining owner — the previous model, "driven by the desktop's own
  // polling broadcast", was dead because that broadcast only fires on CHANGE and
  // exists at all only if the desktop happens to be watching the same cwd.
  // -------------------------------------------------------------------------

  dispatcher.register('git:start-watching', async (cwd: string) => {
    gitWatchRegistry.startWatching(cwd, GIT_WATCH_OWNER_REMOTE)
  })
  dispatcher.register('git:stop-watching', async (cwd: string) => {
    gitWatchRegistry.stopWatching(cwd, GIT_WATCH_OWNER_REMOTE)
  })

  dispatcher.register('git:check-repo', async (cwd: string) => withGit(cwd, (s) => s.isGitRepo()))
  dispatcher.register('git:status', async (cwd: string) => withGit(cwd, (s) => s.getStatus()))
  dispatcher.register('git:branches', async (cwd: string) => withGit(cwd, (s) => s.getBranches()))
  dispatcher.register('git:checkout', async (cwd: string, branch: string) =>
    withGit(cwd, (s) => s.checkout(branch))
  )
  dispatcher.register('git:create-branch', async (cwd: string, name: string) =>
    withGit(cwd, (s) => s.createBranch(name))
  )
  dispatcher.register(
    'git:file-patch',
    async (cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) =>
      withGit(cwd, (s) => s.getFilePatch(filePath, staged, ignoreWhitespace))
  )
  dispatcher.register('git:file-contents', async (cwd: string, filePath: string, staged: boolean) =>
    withGit(cwd, (s) => s.getFileContents(filePath, staged))
  )
  dispatcher.register('git:stage-file', async (cwd: string, filePath: string) =>
    withGit(cwd, (s) => s.stageFile(filePath))
  )
  dispatcher.register('git:unstage-file', async (cwd: string, filePath: string) =>
    withGit(cwd, (s) => s.unstageFile(filePath))
  )
  dispatcher.register('git:discard-file', async (cwd: string, filePath: string) =>
    withGit(cwd, (s) => s.discardFile(filePath))
  )
  dispatcher.register('git:stage-all', async (cwd: string) => withGit(cwd, (s) => s.stageAll()))
  dispatcher.register('git:unstage-all', async (cwd: string) => withGit(cwd, (s) => s.unstageAll()))
  dispatcher.register('git:commit', async (cwd: string, message: string) =>
    withGit(cwd, (s) => s.commit(message))
  )
  dispatcher.register('git:push', async (cwd: string) => withGit(cwd, (s) => s.push()))
  dispatcher.register('git:push-with-upstream', async (cwd: string, branch: string) =>
    withGit(cwd, (s) => s.pushWithUpstream(branch))
  )
  dispatcher.register('git:pull', async (cwd: string) => withGit(cwd, (s) => s.pull()))
  dispatcher.register('git:fetch', async (cwd: string) => withGit(cwd, (s) => s.fetch()))

  // -------------------------------------------------------------------------
  // Engine availability + pi/account read-only queries
  // -------------------------------------------------------------------------

  dispatcher.register('engine:is-installed', async (engineId: EngineId): Promise<boolean> => {
    if (engineId === 'opencode') return opencodeServerManager.isBinaryAvailable()
    if (engineId === 'pi') return piBinaryAvailable()
    return true
  })
  dispatcher.register('pi:binary-path', async (): Promise<string | null> => locatePiBinary())
  dispatcher.register('pi:auth-status', async () => credentialSync.getStatus())
  // Multi-account state (read-only over remote; mutations stay desktop-only via
  // the dispatcher denylist).
  dispatcher.register('account:get', async () => accountManager.getState())

  // -------------------------------------------------------------------------
  // Mockup preview — read HTML + watch the mockup directory for live reloads
  // -------------------------------------------------------------------------

  // `cwd`/`directory` are caller-supplied and reachable remotely — confine the
  // read to a direct child of the project's mockups root (mirrors the HTTP
  // transport's traversal guard in mockup-protocol.ts).
  dispatcher.register('mockup:read-html', async (cwd: string, directory: string) => {
    const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
    const mockupDir = path.resolve(path.join(mockupsRoot, directory))
    if (!isPathInside(mockupsRoot, mockupDir)) {
      throw new Error('Invalid mockup directory')
    }
    return fs.promises.readFile(path.join(mockupDir, 'index.html'), 'utf-8')
  })

  const mockupWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }
  >()

  const closeMockupWatcher = (key: string): void => {
    const entry = mockupWatchers.get(key)
    if (!entry) return
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    mockupWatchers.delete(key)
  }

  dispatcher.register('mockup:watch', async (cwd: string, directory: string) => {
    const key = `${cwd}:${directory}`
    if (mockupWatchers.has(key)) return // already watching

    // `cwd`/`directory` are caller-supplied and reachable remotely. Confine the
    // recursive watch to a direct child of the project's mockups root — same
    // containment as mockup:read-html — so `directory: '../../..'` can't arm a
    // recursive fs.watch over an arbitrary tree.
    const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
    const dirPath = path.resolve(path.join(mockupsRoot, directory))
    if (!isPathInside(mockupsRoot, dirPath)) return
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

    // Without an 'error' listener a watcher fault (on Windows, deleting the
    // watched dir raises one asynchronously) becomes a process-level
    // uncaughtException, and the dead watcher would otherwise stay in the map
    // behind the has() guard above — permanently blocking re-watch. Drop it.
    entry.watcher.on('error', () => closeMockupWatcher(key))

    mockupWatchers.set(key, entry)
  })

  dispatcher.register('mockup:unwatch', async (cwd: string, directory: string) => {
    closeMockupWatcher(`${cwd}:${directory}`)
  })

  logger.info('remote-handlers', `Registered ${dispatcher.channels().length} remote handlers`)
}
