import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteDispatcher } from '../services/remote-dispatcher'
import { SessionManager } from '../services/session-manager'
import {
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
import { getSdkExecutableOpts } from '../services/claude-session'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import { dispatchedUsageSummary } from '../services/db'
import { emitEvent } from '../services/sync-host'
import { listAllDirectories } from '../services/sync-seed'
import { getHostWindow } from '../services/host-window'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { query as sdkQuery } from '../sdk'
import { logger } from '../services/logger'
import { sharedProviderService } from '../shared-providers'
import { prepareAndCreateSession } from './create-session'
import { terminalService } from '../services/terminal-service'
import {
  registerCommand,
  type CommandConnection,
  type CommandRegistration
} from './command-registry'
import {
  sendPrompt,
  watchBackground,
  unwatchBackground,
  readBackgroundRange,
  stopTask,
  backgroundTask,
  dequeueMessage,
  recallQueued,
  askSideQuestion,
  setPermissionMode,
  setEffort,
  setThinkingMode,
  setModel,
  setReasoningVariant,
  rekeyShim,
  getPlanContent,
  getSessionLogPath,
  mcpStatus,
  setCleanupPeriod,
  savePermissionsAndNotify,
  loadSkillDetails,
  saveSessions,
  saveUiSettings,
  listDirEntries,
  deleteSession,
  deleteProject,
  clearConversation
} from './handlers-core'

/**
 * Registers the remote-transport handlers on the shared command registry.
 * These are the same operations exposed via IPC, but called by the WebSocket
 * server instead of ipcMain.handle.
 *
 * Gating is fail-closed (SyncCore phase 1 — ADR-051/052): every channel here
 * DECLARES a capability, and a remote connection can only reach it if that
 * capability is in its grant set. Desktop-only surfaces (`window:*`,
 * `terminal:*`, `auth:*`, account mutations, `remote:*` config, …) are simply
 * not registered here, and their capabilities (`host`/`shell`/`admin`) are not
 * granted to remote connections — so registering one by accident could not
 * expose it either. That double property replaces the old dispatcher denylist.
 */

/**
 * Register one remote-transport command. Counterpart of session.ipc.ts's
 * `handleIpc`; the registry is the same instance, so a channel served by both
 * surfaces must agree on capability/kind or registration throws.
 */
function handleRemote(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'remote' })
}

/**
 * True once registerRemoteHandlers has run. `registerRemoteVersionInfo` is
 * called later in the app bootstrap and must stay a no-op when the remote
 * surface was never set up (it was previously gated on the captured dispatcher).
 */
let remoteHandlersRegistered = false

/**
 * Register the `app:version-info` channel on the remote transport. Called from
 * the main bootstrap once the build versions are known (they're computed after
 * registerRemoteHandlers runs). No-op if remote handlers aren't set up.
 */
export function registerRemoteVersionInfo(versionInfo: {
  appVersion: string
  sdkVersion: string
  cliVersion: string
}): void {
  if (!remoteHandlersRegistered) return
  handleRemote({
    channel: 'app:version-info',
    capability: 'config',
    kind: 'query',
    handler: async () => versionInfo
  })
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

/**
 * Register the remote transport's command surface.
 *
 * **Takes no window (SyncCore phase 4d).** It used to capture `createWindow`'s
 * window purely to hand it to `prepareAndCreateSession` as the new session's host
 * handle; core registers this BEFORE any window decision now, so the handle is
 * read at spawn time from `services/host-window.ts` and is `null` when the app
 * runs windowless.
 */
export function registerRemoteHandlers(
  dispatcher: RemoteDispatcher,
  manager: SessionManager
): void {
  remoteHandlersRegistered = true

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'session:create',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (
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
        getHostWindow(),
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
        }
      )
    }
  })

  handleRemote({
    channel: 'session:rekey',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (oldId: string, newId: string) => {
      rekeyShim(manager, oldId, newId)
    }
  })

  handleRemote({
    channel: 'session:resolve-fork-anchor',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, cwd: string, messageId: string, engineId: EngineId, messageIndex: number) => {
      return await resolveForkAnchor(sessionId, cwd, messageId, engineId, messageIndex)
    }
  })

  handleRemote({
    channel: 'session:send',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (
      routingId: string,
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => sendPrompt(manager, routingId, prompt, attachments)
  })

  handleRemote({
    channel: 'session:cancel',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string) => {
      manager.cancel(routingId)
    }
  })

  handleRemote({
    channel: 'session:interrupt',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string) => {
      await manager.interrupt(routingId)
    }
  })

  handleRemote({
    channel: 'session:approval-response',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (
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
  })

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'session:watch-background',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string) =>
      watchBackground(manager, routingId, toolUseId)
  })

  handleRemote({
    channel: 'session:unwatch-background',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string) => unwatchBackground(manager, routingId, toolUseId)
  })

  handleRemote({
    channel: 'session:read-background-range',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string, offset: number, length: number) =>
      readBackgroundRange(manager, routingId, toolUseId, offset, length)
  })

  handleRemote({
    channel: 'session:stop-task',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string, isDispatch?: boolean) => {
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
  })

  handleRemote({
    channel: 'session:background-task',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string) =>
      backgroundTask(manager, routingId, toolUseId)
  })

  handleRemote({
    channel: 'session:recall-queued',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string) => recallQueued(manager, routingId)
  })

  // Deprecated (ADR-053): recall-all shim for cached `/remote` bundles.
  handleRemote({
    channel: 'session:dequeue-message',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, value: string) =>
      dequeueMessage(manager, routingId, value)
  })

  handleRemote({
    channel: 'session:set-permission-mode',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, mode: string) =>
      setPermissionMode(manager, routingId, mode)
  })

  handleRemote({
    channel: 'session:set-model',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, model: string) => setModel(manager, routingId, model)
  })

  handleRemote({
    channel: 'session:set-effort',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, effort: string) =>
      setEffort(manager, routingId, effort)
  })

  handleRemote({
    channel: 'session:set-thinking-mode',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, mode: string) =>
      setThinkingMode(manager, routingId, mode)
  })

  handleRemote({
    channel: 'session:ask-side-question',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, question: string) =>
      askSideQuestion(manager, routingId, question)
  })

  // -------------------------------------------------------------------------
  // Session queries
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'session:get-models',
    capability: 'config',
    kind: 'query',
    handler: async () => claudeSupportedModels()
  })

  // Cross-engine model catalog (Claude + opencode + pi) for the model picker.
  // Mirrors session.ipc.ts's get-engine-models minus the desktop-only
  // auth-source reporting side effects.
  handleRemote({
    channel: 'session:get-engine-models',
    capability: 'config',
    kind: 'query',
    handler: async (): Promise<EngineModelGroup[]> => {
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
    }
  })

  // Full opencode provider catalog / per-provider models for the allowlist UI.
  handleRemote({
    channel: 'session:get-opencode-providers',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      if (!opencodeServerManager.isBinaryAvailable()) return []
      return await discoverOpencodeProviderCatalog()
    }
  })
  handleRemote({
    channel: 'session:get-opencode-provider-models',
    capability: 'config',
    kind: 'query',
    handler: async (providerId: string) => {
      if (!opencodeServerManager.isBinaryAvailable()) return []
      return await getOpencodeProviderModels(providerId)
    }
  })
  // Provider enable/disable + removal reach the remote surface too (full parity,
  // token-gated). Removal is destructive, so `kind` is passed through verbatim
  // from the caller's resolved actions — the main-process owner re-derives
  // nothing and widens nothing.
  handleRemote({
    channel: 'session:set-opencode-provider-disabled',
    capability: 'config',
    kind: 'command',
    handler: async (providerId: string, disabled: boolean) => {
      setOpencodeProviderDisabled(providerId, disabled)
    }
  })
  handleRemote({
    channel: 'session:remove-opencode-provider',
    capability: 'config',
    kind: 'command',
    handler: async (providerId: string, kind: ProviderRemoveKind) => {
      await removeOpencodeProvider(providerId, kind)
    }
  })
  handleRemote({
    channel: 'session:get-pi-model-catalog',
    capability: 'config',
    kind: 'query',
    handler: async () => getPiModelCatalogGroups()
  })

  handleRemote({
    channel: 'session:set-reasoning-variant',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, variant: string | null) =>
      setReasoningVariant(manager, routingId, variant)
  })

  handleRemote({
    channel: 'session:get-plan-content',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string) =>
      getPlanContent(manager, routingId)
  })

  handleRemote({
    channel: 'session:get-session-log-path',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string) =>
      getSessionLogPath(manager, routingId)
  })

  handleRemote({
    channel: 'session:list-directories',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => {
      // The MERGED listing — same value the replicated
      // `session:directories-changed` carries (see sync-seed.ts).
      return await listAllDirectories()
    }
  })

  // Multi-engine session listing + history (opencode + pi) for the sidebar.
  handleRemote({
    channel: 'session:list-opencode',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => listOpencodeSessionsGlobal()
  })
  handleRemote({
    channel: 'session:load-opencode-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string) =>
      loadOpencodeSessionHistory(sessionId)
  })
  handleRemote({
    channel: 'session:list-pi',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => listPiSessionsGlobal()
  })
  handleRemote({
    channel: 'session:load-pi-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string) =>
      loadPiSessionHistory(sessionId)
  })

  // Live transcript watching (drives the remote client's live history view).
  handleRemote({
    channel: 'session:watch-session',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string, sessionId: string, projectKey: string, cwd?: string) => {
      watchSession(routingId, sessionId, projectKey, cwd)
    }
  })
  handleRemote({
    channel: 'session:unwatch-session',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string) => {
      unwatchSession(routingId)
    }
  })

  // Persist a custom session title (appends a custom-title JSONL entry).
  handleRemote({
    channel: 'session:write-custom-title',
    capability: 'config',
    kind: 'command',
    handler: async (sessionId: string, projectKey: string, title: string) => {
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
  })

  // Title / commit-message generation (throwaway SDK queries).
  handleRemote({
    channel: 'session:generate-title',
    capability: 'chat',
    kind: 'command',
    handler: async (conversationText: string) =>
      generateTitle(conversationText)
  })
  handleRemote({
    channel: 'session:generate-commit-message',
    capability: 'chat',
    kind: 'command',
    handler: async (diff: string) =>
      generateCommitMessage(diff)
  })

  handleRemote({
    channel: 'session:load-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, projectKey: string, resumeSessionAt?: string) => {
      return await loadSessionHistory(sessionId, projectKey, resumeSessionAt)
    }
  })

  handleRemote({
    channel: 'session:load-subagent-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, projectKey: string, agentId: string) => {
      return await loadSubagentHistory(sessionId, projectKey, agentId)
    }
  })

  handleRemote({
    channel: 'session:build-subagent-file-map',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
      return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
    }
  })

  handleRemote({
    channel: 'session:load-background-output',
    capability: 'fs-read',
    kind: 'query',
    handler: async (projectKey: string, taskId: string, outputFile?: string) => {
      return loadBackgroundOutput(projectKey, taskId, outputFile)
    }
  })

  handleRemote({
    channel: 'session:delete-session',
    capability: 'config',
    kind: 'command',
    handler: async (sessionId: string, projectKey: string, engineId?: EngineId) => {
      await deleteSession(manager, sessionId, projectKey, engineId)
    }
  })

  handleRemote({
    channel: 'session:clear-conversation',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, permissionMode?: string) => {
      await clearConversation(manager, routingId, permissionMode)
    }
  })

  handleRemote({
    channel: 'session:delete-project',
    capability: 'config',
    kind: 'command',
    handler: async (projectKey: string) => {
      await deleteProject(manager, projectKey)
    }
  })

  // -------------------------------------------------------------------------
  // Config (read-write, synced bidirectionally)
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'config:load-settings',
    capability: 'config',
    kind: 'query',
    handler: async () => loadSettings()
  })
  handleRemote({
    channel: 'config:save-settings',
    capability: 'config',
    kind: 'command',
    handler: async (settings: UISettings) =>
      saveUiSettings(manager, settings)
  })
  handleRemote({
    channel: 'config:load-sessions',
    capability: 'config',
    kind: 'query',
    handler: async () => loadSessionConfig()
  })
  handleRemote({
    channel: 'config:save-sessions',
    capability: 'config',
    kind: 'command',
    handler: async (config: UISessionConfig) =>
      saveSessions(config)
  })
  handleRemote({
    channel: 'config:load-slash-commands',
    capability: 'config',
    kind: 'query',
    handler: async () => loadSlashCommands()
  })
  handleRemote({
    channel: 'shared-provider:list',
    capability: 'config',
    kind: 'query',
    handler: async () => sharedProviderService.listDefinitions()
  })
  handleRemote({
    channel: 'shared-provider:statuses',
    capability: 'config',
    kind: 'query',
    handler: async () => sharedProviderService.listStatuses()
  })
  handleRemote({
    channel: 'shared-provider:models',
    capability: 'config',
    kind: 'query',
    handler: async (id: string) =>
      sharedProviderService.listProviderModels(id)
  })
  handleRemote({
    channel: 'config:scan-custom-commands',
    capability: 'config',
    kind: 'query',
    handler: async (cwd: string) => scanCustomCommands(cwd)
  })
  handleRemote({
    channel: 'config:load-skill-details',
    capability: 'config',
    kind: 'query',
    handler: async (cwd: string) =>
      loadSkillDetails(manager, cwd)
  })

  // Claude permissions — full parity with the desktop handler (same
  // save + hot-reload fan-out), consistent with the user decision that the
  // remote token is the sole gate for mutations (see the git block below).
  handleRemote({
    channel: 'claude:load-permissions',
    capability: 'config',
    kind: 'query',
    handler: async (scope: string, cwd?: string) =>
      loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  })
  handleRemote({
    channel: 'claude:save-permissions',
    capability: 'config',
    kind: 'command',
    handler: async (scope: string, permissions: ClaudePermissions, cwd?: string) =>
      savePermissionsAndNotify(manager, scope as PermissionScope, permissions, cwd)
  })
  handleRemote({
    channel: 'claude:workspace-trust',
    capability: 'config',
    kind: 'query',
    handler: async (cwd: string) => isWorkspaceTrusted(cwd)
  })

  // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
  handleRemote({
    channel: 'claude:get-cleanup-period',
    capability: 'config',
    kind: 'query',
    handler: async () => loadCleanupPeriodDays()
  })
  handleRemote({
    channel: 'claude:set-cleanup-period',
    capability: 'config',
    kind: 'command',
    handler: async (days: number) =>
      setCleanupPeriod(manager, days)
  })

  // MCP config (read-only)
  handleRemote({
    channel: 'mcp:load-servers',
    capability: 'config',
    kind: 'query',
    handler: async (scope: string, cwd?: string) =>
      loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  })
  handleRemote({
    channel: 'mcp:read-disabled',
    capability: 'config',
    kind: 'query',
    handler: async (cwd: string) => readDisabledMcpServers(cwd)
  })

  // MCP runtime (Claude-only: capabilities.hostedMcp AND method presence —
  // opencode advertises hostedMcp:true but does not implement mcpServerStatus)
  handleRemote({
    channel: 'mcp:status',
    capability: 'config',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string) => mcpStatus(manager, routingId)
  })

  // -------------------------------------------------------------------------
  // File listing (for folder browser on web)
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'file:list-dir',
    capability: 'fs-read',
    kind: 'query',
    handler: async (dirPath: string) => listDirEntries(dirPath)
  })

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'usage:fetch',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return usageFetcher.fetch()
    }
  })

  handleRemote({
    channel: 'usage:fetch-block',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return blockUsageService.getData() ?? (await blockUsageService.recalculate())
    }
  })

  handleRemote({
    channel: 'usage:set-account-filter',
    capability: 'config',
    kind: 'command',
    handler: async (account: string | null) => {
      blockUsageService.setAccountFilter(account)
    }
  })

  // ADR-033 M4-B: cross-engine dispatched usage, all-time, grouped by
  // (targetEngine, targetModel). Read-only DB aggregate — safe over remote.
  handleRemote({
    channel: 'usage:fetch-dispatched',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return dispatchedUsageSummary()
    }
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

  handleRemote({
    channel: 'git:start-watching',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => {
      gitWatchRegistry.startWatching(cwd, GIT_WATCH_OWNER_REMOTE)
    }
  })
  handleRemote({
    channel: 'git:stop-watching',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => {
      gitWatchRegistry.stopWatching(cwd, GIT_WATCH_OWNER_REMOTE)
    }
  })

  handleRemote({
    channel: 'git:check-repo',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => withGit(cwd, (s) => s.isGitRepo())
  })
  handleRemote({
    channel: 'git:status',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => withGit(cwd, (s) => s.getStatus())
  })
  handleRemote({
    channel: 'git:branches',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => withGit(cwd, (s) => s.getBranches())
  })
  handleRemote({
    channel: 'git:checkout',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, branch: string) =>
      withGit(cwd, (s) => s.checkout(branch))
  })
  handleRemote({
    channel: 'git:create-branch',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, name: string) =>
      withGit(cwd, (s) => s.createBranch(name))
  })
  handleRemote({
    channel: 'git:file-patch',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) =>
      withGit(cwd, (s) => s.getFilePatch(filePath, staged, ignoreWhitespace))
  })
  handleRemote({
    channel: 'git:file-contents',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string, filePath: string, staged: boolean) =>
      withGit(cwd, (s) => s.getFileContents(filePath, staged))
  })
  handleRemote({
    channel: 'git:stage-file',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, filePath: string) =>
      withGit(cwd, (s) => s.stageFile(filePath))
  })
  handleRemote({
    channel: 'git:unstage-file',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, filePath: string) =>
      withGit(cwd, (s) => s.unstageFile(filePath))
  })
  handleRemote({
    channel: 'git:discard-file',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, filePath: string) =>
      withGit(cwd, (s) => s.discardFile(filePath))
  })
  handleRemote({
    channel: 'git:stage-all',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string) => withGit(cwd, (s) => s.stageAll())
  })
  handleRemote({
    channel: 'git:unstage-all',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string) => withGit(cwd, (s) => s.unstageAll())
  })
  handleRemote({
    channel: 'git:commit',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, message: string) =>
      withGit(cwd, (s) => s.commit(message))
  })
  handleRemote({
    channel: 'git:push',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string) => withGit(cwd, (s) => s.push())
  })
  handleRemote({
    channel: 'git:push-with-upstream',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string, branch: string) =>
      withGit(cwd, (s) => s.pushWithUpstream(branch))
  })
  handleRemote({
    channel: 'git:pull',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string) => withGit(cwd, (s) => s.pull())
  })
  handleRemote({
    channel: 'git:fetch',
    capability: 'git',
    kind: 'command',
    handler: async (cwd: string) => withGit(cwd, (s) => s.fetch())
  })

  // -------------------------------------------------------------------------
  // Engine availability + pi/account read-only queries
  // -------------------------------------------------------------------------

  handleRemote({
    channel: 'engine:is-installed',
    capability: 'config',
    kind: 'query',
    handler: async (engineId: EngineId): Promise<boolean> => {
      if (engineId === 'opencode') return opencodeServerManager.isBinaryAvailable()
      if (engineId === 'pi') return piBinaryAvailable()
      return true
    }
  })
  handleRemote({
    channel: 'pi:binary-path',
    capability: 'config',
    kind: 'query',
    handler: async (): Promise<string | null> => locatePiBinary()
  })
  handleRemote({
    channel: 'pi:auth-status',
    capability: 'config',
    kind: 'query',
    handler: async () => credentialSync.getStatus()
  })
  // Multi-account state (read-only over remote; the mutations are `admin`
  // capability and are not registered for this transport).
  handleRemote({
    channel: 'account:get',
    capability: 'config',
    kind: 'query',
    handler: async () => accountManager.getState()
  })

  // -------------------------------------------------------------------------
  // Mockup preview — read HTML + watch the mockup directory for live reloads
  // -------------------------------------------------------------------------

  // `cwd`/`directory` are caller-supplied and reachable remotely — confine the
  // read to a direct child of the project's mockups root (mirrors the HTTP
  // transport's traversal guard in mockup-protocol.ts).
  handleRemote({
    channel: 'mockup:read-html',
    capability: 'fs-read',
    kind: 'query',
    handler: async (cwd: string, directory: string) => {
      const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
      const mockupDir = path.resolve(path.join(mockupsRoot, directory))
      if (!isPathInside(mockupsRoot, mockupDir)) {
        throw new Error('Invalid mockup directory')
      }
      return fs.promises.readFile(path.join(mockupDir, 'index.html'), 'utf-8')
    }
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

  handleRemote({
    channel: 'mockup:watch',
    capability: 'fs-read',
    kind: 'query',
    handler: async (cwd: string, directory: string) => {
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
          emitEvent('mockup:file-changed', [directory])
        }, 200)
      })

      // Without an 'error' listener a watcher fault (on Windows, deleting the
      // watched dir raises one asynchronously) becomes a process-level
      // uncaughtException, and the dead watcher would otherwise stay in the map
      // behind the has() guard above — permanently blocking re-watch. Drop it.
      entry.watcher.on('error', () => closeMockupWatcher(key))

      mockupWatchers.set(key, entry)
    }
  })

  handleRemote({
    channel: 'mockup:unwatch',
    capability: 'fs-read',
    kind: 'query',
    handler: async (cwd: string, directory: string) => {
      closeMockupWatcher(`${cwd}:${directory}`)
    }
  })

  // -------------------------------------------------------------------------
  // Terminal (SyncCore phase 2 — ADR-052 decision 6, security.md §Terminal posture)
  //
  // The first channels on this surface whose capability is NOT in
  // LEGACY_REMOTE_GRANTS. Registering them does not expose them: `shell` is
  // granted only by the step-up ceremony (a transport frame — see
  // remote-server.ts), only while the desktop-side "Allow remote terminal"
  // toggle is ON, and only until the grant decays. Three gates in series, all
  // server-side.
  // -------------------------------------------------------------------------

  // `index` (optional) selects the slot in this cwd's terminal POOL, so a phone
  // opening "terminal 0" of a repo lands on the same pty the desktop has open.
  // An older web bundle sends no index and still gets a fresh pty in the next
  // free slot — the pre-pool behavior, unchanged.
  handleRemote({
    channel: 'terminal:create',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, cwd: string, index?: number) =>
      terminalService.create(connection, cwd, index)
  })

  // `terminal:write` stays registered even though the web client prefers the
  // `term-input` FRAME (no invoke bookkeeping per keystroke): it keeps the two
  // surfaces symmetrical, and it is the same gates either way.
  handleRemote({
    channel: 'terminal:write',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string, data: string) => {
      terminalService.write(connection, id, data)
    }
  })

  handleRemote({
    channel: 'terminal:resize',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string, cols: number, rows: number) => {
      terminalService.resize(connection, id, cols, rows)
    }
  })

  handleRemote({
    channel: 'terminal:kill',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) => {
      terminalService.kill(connection, id)
    }
  })

  // DELIBERATE EXCEPTION to "subscriptions are queries": attach/detach are
  // subscription toggles with no domain effect, which would normally make them
  // `query` (and therefore unaudited). security.md §Audit requires terminal
  // lifecycle — spawn/attach/detach/exit with identity — in the audit trail, so
  // they are declared `command` purely to be audited. They still carry no PTY
  // content; only who attached to which terminal, and when.
  handleRemote({
    channel: 'terminal:attach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) =>
      terminalService.attach(connection, id)
  })
  handleRemote({
    channel: 'terminal:detach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) => {
      terminalService.detach(connection, id)
    }
  })

  // Capability honesty: the ONLY thing a web client needs to decide whether to
  // render the terminal affordance, and whether to prompt for step-up first.
  // `config` (not `shell`) on purpose — asking "may I?" must be answerable
  // without already holding the grant.
  handleRemote({
    channel: 'terminal:availability',
    capability: 'config',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => terminalService.availability(connection)
  })

  logger.info('remote-handlers', `Registered ${dispatcher.channels().length} remote handlers`)
}
