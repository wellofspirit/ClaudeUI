import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { query as sdkQuery } from '../sdk'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { SessionManager } from '../services/session-manager'
import { getSdkExecutableOpts } from '../services/claude-session'
import { emitEvent } from '../services/sync-host'
import { STREAM_WATCH_COMMAND } from './stream-watch'
import { GIT_WATCH_COMMAND } from './git-watch'
import { getHostWindow } from '../services/host-window'
import {
  seedCanonicalAppState,
  refreshCanonicalDirectories,
  listAllDirectories
} from '../services/sync-seed'
import {
  loadSessionHistory,
  loadSubagentHistory,
  buildSubagentFileMap,
  loadBackgroundOutput,
  resolveForkAnchor
} from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { isPathInside, assertSafePathSegment } from '../services/path-containment'
import {
  loadSettings,
  loadSessionConfig,
  loadSlashCommands,
  startConfigWatcher
} from '../services/ui-config'
import {
  loadClaudePermissions,
  loadCleanupPeriodDays,
  isWorkspaceTrusted
} from '../services/claude-settings'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { scanCustomCommands } from '../services/custom-command-scanner'
import type { UISettings, UISessionConfig } from '../services/ui-config'
import { gitServiceManager } from '../services/git-service'
import { gitWatchRegistry } from '../services/git-watch-registry'
import { usageFetcher } from '../services/usage-fetcher'
import { serviceSession } from '../services/service-session'
import { blockUsageService } from '../services/block-usage'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import { dispatchedUsageSummary } from '../services/db'
import { credentialSync } from '../auth/vault/CredentialSync'
import { sharedProviderService } from '../shared-providers'
import {
  accountState,
  hostIsPackaged,
  pickHostDirectory,
  reportHostLoginStatus,
  updateClaudeAuthSource
} from '../host'
import type {
  ApprovalDecision,
  ModelInfo,
  EngineModelGroup,
  PermissionSuggestion,
  EngineId,
  OpencodeProviderCatalogEntry,
  ProviderRemoveKind,
  PermissionScope,
  ClaudePermissions
} from '../../shared/types'
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
import { logger } from '../services/logger'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory
} from '../services/opencode-session-list'
import { listPiSessionsGlobal, loadPiSessionHistory } from '../services/pi-session-list'
import type { ISession } from '../providers/ISession'
import { prepareAndCreateSession } from './create-session'
import { safeHandler } from './safe-handler'
import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import { configCommands } from './config-commands'
import { authCommands, type AuthCommandDeps } from './auth-commands'
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

// `safeHandler` (the IpcResult envelope) and `handleIpc` (the desktop transport
// adapter) both moved out of this file with the S1b registration sweep: the
// channels that sweep shares with the WebSocket transport are declared once, in
// an Electron-free module, so the envelope had to become Electron-free too — and
// `automation.ipc.ts` needed the same adapter rather than a second copy of it.
// See `safe-handler.ts` / `desktop-transport.ts`.

// The model list is derived from cli.js's initialize response, which reflects
// ~/.claude.json's additionalModelOptionsCache. That cache is warmed by cli.js's
// bootstrap fetch a few seconds AFTER a spawn's init resolves (fire-and-forget),
// so newly-entitled models (e.g. Fable) can be absent from the very first fetch on
// a cold cache. A short TTL lets a subsequent picker fetch (the renderer re-fetches
// on cwd change / modelReloadNonce) pick them up without an app restart.
const MODELS_CACHE_TTL_MS = 2 * 60_000
let cachedModels: { models: ModelInfo[]; at: number } | null = null

const COMMIT_MSG_SYSTEM_PROMPT =
  'You are a commit message generator. Given a git diff of staged changes, write a concise conventional commit message. Output ONLY the commit message — no explanation, no quotes, no markdown. Use imperative mood. First line should be a short summary (max 72 chars). If needed, add a blank line followed by bullet points for details. Focus on the "why" not the "what".'

/**
 * Ask cli.js to generate a session title for the given conversation text.
 *
 * Delegates to the `generate_session_title` control request (anchor ~12854900
 * in cli.js), which runs the model with cli.js's own sentence-case 3-7 word
 * prompt and returns a JSON-schema validated `{title: string | null}`.
 *
 * `persist:false` — we track our manual regenerations through the custom-title
 * file path; letting cli.js also persist would create two sources of truth.
 */
async function generateTitle(conversationText: string): Promise<string | null> {
  const abort = new AbortController()
  logger.debug('generateTitle', `request: ${conversationText.length} chars`)

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
    if (trimmed.length >= 2) {
      logger.debug('generateTitle', `title: ${trimmed}`)
      return trimmed
    }
    logger.debug('generateTitle', 'cli.js returned no usable title')
    return null
  } catch (err) {
    logger.error('generateTitle', 'Failed to generate title', err)
    return null
  } finally {
    abort.abort()
  }
}

async function generateCommitMessage(diff: string): Promise<string | null> {
  const abort = new AbortController()
  logger.debug('generateCommitMessage', `request: ${diff.length} chars`)

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

    logger.debug('generateCommitMessage', `response: ${JSON.stringify(result)}`)

    const cleaned = result.trim()
    if (cleaned.length >= 3) {
      return cleaned
    }
    logger.debug('generateCommitMessage', 'no usable message extracted')
    return null
  } catch (err) {
    logger.error('generateCommitMessage', 'Failed to generate commit message', err)
    return null
  } finally {
    abort.abort()
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  if (cachedModels && Date.now() - cachedModels.at < MODELS_CACHE_TTL_MS) {
    return cachedModels.models
  }

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
      supportedModels(): Promise<ModelInfo[]>
      initializationResult(): Promise<Record<string, unknown>>
    }
    const models = await handle.supportedModels()
    cachedModels = { models, at: Date.now() }
    // The same initialize response carries the user's account — report login
    // status at app load so the sign-in banner is accurate before any chat
    // session is opened. Resolves immediately (init already completed). ADR-014.
    try {
      const init = await handle.initializationResult()
      // reportLoginStatus broadcasts session:auth-source to the window (legacy
      // path). Through the `HostAuth` seam since S3 stage 1b — status-only, and
      // a no-op with no host wired.
      reportHostLoginStatus(init?.account)
      // Also update the ClaudeAuthProvider probe cache so probe() and session.account
      // are accurate from the first model-fetch, before any chat session opens.
      const acc = init?.account as Record<string, unknown> | undefined
      if (acc) {
        const loggedIn = !!(acc.email)
        updateClaudeAuthSource(loggedIn ? 'authenticated' : 'none', {
          email: (acc.email as string | null) ?? null,
          organization: (acc.organization as string | null) ?? null,
          subscriptionType: (acc.subscriptionType as string | null) ?? null,
          tokenSource: (acc.tokenSource as string | null) ?? null,
          apiKeySource: (acc.apiKeySource as string | null) ?? null,
          apiProvider: (acc.apiProvider as string | null) ?? null
        })
      }
    } catch {
      /* non-fatal — per-session init will still report status */
    }
    return models
  } finally {
    abort.abort()
  }
}

const SESSION_IPC_CHANNELS = [
  // The volatile lane's subscription verb (phase 5 S1) — registered below like
  // every other channel here, so it must be removable like every other one too.
  'stream:watch',
  'session:pick-folder',
  'session:create',
  'session:rekey',
  'session:resolve-fork-anchor',
  'session:send',
  'session:cancel',
  'session:interrupt',
  'session:approval-response',
  'session:watch-background',
  'session:unwatch-background',
  'session:read-background-range',
  'session:stop-task',
  'session:background-task',
  'session:dequeue-message',
  'session:ask-side-question',
  'session:set-permission-mode',
  'session:set-model',
  'session:set-effort',
  'session:set-reasoning-variant',
  'session:get-models',
  'session:get-engine-models',
  'session:get-opencode-providers',
  'session:set-opencode-provider-disabled',
  'session:remove-opencode-provider',
  'session:get-opencode-provider-models',
  'session:get-pi-model-catalog',
  'session:generate-title',
  'session:generate-commit-message',
  'session:write-custom-title',
  'session:get-plan-content',
  'session:get-session-log-path',
  'session:delete-session',
  'session:delete-project',
  'session:clear-conversation',
  'session:list-directories',
  'session:list-opencode',
  'session:load-opencode-history',
  'session:list-pi',
  'session:load-pi-history',
  'session:load-history',
  'session:load-subagent-history',
  'session:build-subagent-file-map',
  'session:load-background-output',
  'session:watch-session',
  'session:unwatch-session',
  'config:load-settings',
  'config:save-settings',
  'config:load-sessions',
  'config:save-sessions',
  'config:load-slash-commands',
  'config:save-slash-commands',
  'config:scan-custom-commands',
  'config:load-skill-details',
  'config:load-opencode-settings',
  'config:save-opencode-settings',
  'config:read-opencode-native-raw',
  'config:patch-opencode-native',
  'opencode-agents:list',
  'opencode-agents:read',
  'opencode-agents:save',
  'opencode-agents:delete',
  'opencode-agents:set-disabled',
  'opencode-agents:generate',
  'git:check-repo',
  'git:status',
  'git:branches',
  'git:checkout',
  'git:create-branch',
  'git:file-patch',
  'git:file-contents',
  'git:stage-file',
  'git:unstage-file',
  'git:discard-file',
  'git:stage-all',
  'git:unstage-all',
  'git:commit',
  'git:push',
  'git:push-with-upstream',
  'git:pull',
  'git:fetch',
  'git:watch',
  'file:list-dir',
  'usage:fetch',
  'usage:fetch-block',
  'usage:set-account-filter',
  'usage:refresh-prices',
  'usage:fetch-dispatched',
  'auth:sign-in',
  'auth:submit-code',
  'auth:cancel',
  'account:get',
  'account:set-enabled',
  'account:add',
  'account:switch',
  'account:delete',
  'claude:load-permissions',
  'claude:save-permissions',
  'claude:get-cleanup-period',
  'claude:set-cleanup-period',
  'mcp:status',
  'mcp:toggle',
  'mcp:reconnect',
  'mcp:set-servers',
  'mcp:load-servers',
  'mcp:save-servers',
  'mcp:remove-server',
  'mcp:read-disabled',
  'mcp:toggle-disabled',
  'worktree:create',
  'worktree:status',
  'worktree:remove',
  'worktree:list',
  'app:quit-confirm',
  'session:sandbox-violation',
  'voice:start-server',
  'voice:stop-server',
  'voice:start-recording',
  'voice:stop-recording',
  'proxy:test-connection',
  'vendor-auth:probe',
  'vendor-auth:list-options',
  'vendor-auth:list-keys',
  'vendor-auth:set-key',
  'vendor-auth:oauth-authorize',
  'vendor-auth:oauth-callback',
  'vendor-auth:oauth-cancel',
  'vendor-auth:remove'
]

/** Shared SessionManager — created once, used by both IPC and remote handlers. */
let sharedManager: SessionManager | null = null
export function getSessionManager(): SessionManager | null {
  return sharedManager
}

/**
 * Register every session/config/git/usage channel and start the window-independent
 * services behind them.
 *
 * **Takes no window (SyncCore phase 4d).** It used to take the one it was called
 * with from `createWindow`, which made the whole surface — including the canonical
 * seeds and the watchers below — window-lifetime code that could not run at all
 * without a `BrowserWindow`. It is called once from `bootCore()` now, BEFORE any
 * window decision, so the two places that genuinely want the host's window (a
 * native folder picker and the spawn handle a session holds) read it from
 * `services/host-window.ts` at USE time and cope with `null`.
 */
export function registerSessionIpc(authDeps: AuthCommandDeps): SessionManager {
  // Remove previous handlers to allow re-registration (e.g. a second bootCore in
  // a test; production boots core exactly once).
  unbindDesktopChannels(SESSION_IPC_CHANNELS)

  const manager = new SessionManager()
  sharedManager = manager

  // The volatile lane's subscription verb (phase 5 S1). Same declaration the
  // remote transport registers — see `ipc/stream-watch.ts`.
  handleIpc(STREAM_WATCH_COMMAND)

  handleIpc({
    channel: 'session:pick-folder',
    capability: 'host',
    kind: 'command',
    handler: async () => {
      // `host` capability, so only the desktop client can reach this. The native
      // dialog itself is a HOST act — Electron's overload set even makes the
      // window-parented and unparented calls two different calls — so it lives
      // behind the `HostPicker` seam (S3 stage 1b) and the desktop wires
      // `dialog.showOpenDialog` into it from `boot-core`. A headless server has
      // no operator at a console to show a picker to, so it wires nothing and
      // this resolves to `null` — the same answer a cancelled dialog gives.
      return await pickHostDirectory()
    }
  })

  handleIpc({
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

  handleIpc({
    channel: 'session:rekey',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: (oldId: string, newId: string) => {
      rekeyShim(manager, oldId, newId)
    }
  })

  // Resolve the fork ("branch off") anchor, engine-dispatched — Claude by
  // messageId (JSONL line uuid), pi by messageIndex (position, no stable id).
  // Used by the renderer before creating the branch.
  handleIpc({
    channel: 'session:resolve-fork-anchor',
    capability: 'fs-read',
    kind: 'query',
    handler: async (
      sessionId: string,
      cwd: string,
      messageId: string,
      engineId: EngineId,
      messageIndex: number
    ) => {
      return await resolveForkAnchor(sessionId, cwd, messageId, engineId, messageIndex)
    }
  })

  handleIpc({
    channel: 'session:send',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: (
      routingId: string,
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => sendPrompt(manager, routingId, prompt, attachments)
  })

  handleIpc({
    channel: 'session:cancel',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: (routingId: string) => {
      manager.cancel(routingId)
    }
  })

  handleIpc({
    channel: 'session:interrupt',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string) => {
      await manager.interrupt(routingId)
    }
  })

  handleIpc({
    channel: 'session:approval-response',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: (
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

  handleIpc({
    channel: 'session:watch-background',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string, toolUseId: string) =>
      watchBackground(manager, routingId, toolUseId)
  })

  handleIpc({
    channel: 'session:unwatch-background',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string, toolUseId: string) =>
      unwatchBackground(manager, routingId, toolUseId)
  })

  handleIpc({
    channel: 'session:read-background-range',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string, toolUseId: string, offset: number, length: number) =>
      readBackgroundRange(manager, routingId, toolUseId, offset, length)
  })

  handleIpc({
    channel: 'session:stop-task',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string, isDispatch?: boolean) => {
      // A cross-engine dispatch card's toolUseId isn't gated on the dispatching
      // session's own backgroundTasks capability — route to the dispatcher
      // FIRST (ADR-033 M3), same precedent as the xeng: approval-response
      // routing above. routingId scopes the stop to the OWNING session.
      if (isDispatch) {
        // The renderer KNOWS this is a dispatch card: arm a durable stop-intent
        // when the dispatch hasn't registered yet (the Stop click can beat the
        // MCP tools/call round-trip), and NEVER fall through to the session
        // path — its "Provider does not support background tasks" error was
        // this race's misleading symptom.
        crossEngineDispatcher.stopDispatch(toolUseId, routingId, { armIfUnknown: true })
        return { success: true }
      }
      // Not marked: try the dispatcher without arming, fall through to the
      // session's own stopTask when it's not a known dispatch id.
      if (crossEngineDispatcher.stopDispatch(toolUseId, routingId)) return { success: true }
      return stopTask(manager, routingId, toolUseId)
    }
  })

  handleIpc({
    channel: 'session:background-task',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, toolUseId: string) =>
      backgroundTask(manager, routingId, toolUseId)
  })

  handleIpc({
    channel: 'session:recall-queued',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string) => recallQueued(manager, routingId)
  })

  // Deprecated (ADR-053): recall-all shim for cached `/remote` bundles.
  handleIpc({
    channel: 'session:dequeue-message',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, value: string) =>
      dequeueMessage(manager, routingId, value)
  })

  handleIpc({
    channel: 'session:ask-side-question',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, question: string) =>
      askSideQuestion(manager, routingId, question)
  })

  handleIpc({
    channel: 'session:set-permission-mode',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, mode: string) =>
      setPermissionMode(manager, routingId, mode)
  })

  // Voice input handlers (Claude-only: capabilities.voice)
  handleIpc({
    channel: 'voice:start-server',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) throw new Error('Provider does not support voice')
      await session.voiceStartServer?.()
    })
  })

  handleIpc({
    channel: 'voice:stop-server',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) return
      await session.voiceStopServer?.()
    })
  })

  handleIpc({
    channel: 'voice:start-recording',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string, language: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) throw new Error('Provider does not support voice')
      await session.voiceStartRecording?.(language)
    })
  })

  handleIpc({
    channel: 'voice:stop-recording',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string) => {
      const session = manager.get(routingId)
      if (!session || !session.capabilities.voice) return
      await session.voiceStopRecording?.()
    })
  })

  handleIpc({
    channel: 'session:set-model',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, model: string) => setModel(manager, routingId, model)
  })

  handleIpc({
    channel: 'session:set-effort',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: (routingId: string, effort: string) => setEffort(manager, routingId, effort)
  })

  handleIpc({
    channel: 'session:set-reasoning-variant',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: (routingId: string, variant: string | null) =>
      setReasoningVariant(manager, routingId, variant)
  })

  handleIpc({
    channel: 'session:set-thinking-mode',
    capability: 'session-config',
    kind: 'command',
    sessionIdArg: 0,
    handler: (routingId: string, mode: string) => setThinkingMode(manager, routingId, mode)
  })

  handleIpc({
    channel: 'session:get-models',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return await fetchModels()
    }
  })

  handleIpc({
    channel: 'session:get-engine-models',
    capability: 'config',
    kind: 'query',
    handler: async (): Promise<EngineModelGroup[]> => {
      // Claude models as a flat group. supportedModels() returns bare ModelInfo
      // (no engineId/vendorId) — stamp them so the renderer can attribute a Claude
      // pick to the 'claude' engine. Without this, picking a Claude model while on
      // an opencode session leaves engineId undefined and the pick is mis-recorded
      // under the session's current engine (e.g. "opencode/default").
      const claudeModels = (await fetchModels()).map((m) => ({
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
      // opencode models — returns [] if binary not present or discovery fails
      const opencodeGroups = await discoverOpencodeModels()
      // pi models — returns [] if binary not present, no auth configured, or discovery fails
      const piGroups = await discoverPiModels()
      return [claudeGroup, ...opencodeGroups, ...piGroups]
    }
  })

  // Full opencode provider catalog for the settings provider manager. Returns []
  // when opencode isn't installed or discovery fails (opencode is optional).
  handleIpc({
    channel: 'session:get-opencode-providers',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      if (!opencodeServerManager.isBinaryAvailable()) return []
      const catalog = await discoverOpencodeProviderCatalog()
      // Decorate with shared-provider ownership HERE rather than inside discovery:
      // shared-providers/index → OpencodeSharedProviderAdapter → model-discovery,
      // so a shared-provider import inside model-discovery would be a cycle.
      return decorateSharedProviderClaims(catalog)
    }
  })

  // Enable/disable is a reversible veto (opencode's disabled_providers) and is
  // deliberately NOT the same operation as removal — see provider-management.ts.
  handleIpc({
    channel: 'session:set-opencode-provider-disabled',
    capability: 'config',
    kind: 'command',
    handler: async (providerId: string, disabled: boolean) => {
      setOpencodeProviderDisabled(providerId, disabled)
    }
  })

  // Destructive: deletes the credential and/or the provider declaration ClaudeUI
  // owns. `kind` must come from the entry's resolved actions — widening it here
  // would delete something the UI never warned about.
  handleIpc({
    channel: 'session:remove-opencode-provider',
    capability: 'config',
    kind: 'command',
    handler: async (providerId: string, kind: ProviderRemoveKind) => {
      await removeOpencodeProvider(providerId, kind)
    }
  })

  // All catalog models for one provider (drives the model-allowlist dialog).
  handleIpc({
    channel: 'session:get-opencode-provider-models',
    capability: 'config',
    kind: 'query',
    handler: async (providerId: string) => {
      if (!opencodeServerManager.isBinaryAvailable()) return []
      return await getOpencodeProviderModels(providerId)
    }
  })

  // Unfiltered authenticated pi catalog for the model-allowlist dialog.
  handleIpc({
    channel: 'session:get-pi-model-catalog',
    capability: 'config',
    kind: 'query',
    handler: async () => getPiModelCatalogGroups()
  })

  handleIpc({
    channel: 'session:generate-title',
    capability: 'chat',
    kind: 'command',
    handler: async (conversationText: string) => {
      return await generateTitle(conversationText)
    }
  })

  handleIpc({
    channel: 'session:generate-commit-message',
    capability: 'chat',
    kind: 'command',
    handler: async (diff: string) => {
      return await generateCommitMessage(diff)
    }
  })

  handleIpc({
    channel: 'session:write-custom-title',
    capability: 'config',
    kind: 'command',
    handler: async (sessionId: string, projectKey: string, title: string) => {
      // LOW-RW3: both identifiers are caller-supplied and interpolated straight
      // into a path — a `..`/separator segment would append attacker-controlled
      // JSON to any *.jsonl on disk. Same check as deleteSessionFiles(); the
      // remote twin of this handler (remote-handlers.ts) is reachable by any
      // token-holding remote client, so the guard must exist on both.
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

  // `chat`, not `config`, since ADR-056 (the review sync-core.md §Follow-ons
  // asked for, resolved). Deleting a session or a project removes CONVERSATIONS
  // — the same material `chat` already governs reading and writing — and calling
  // that "configuration" put the destructive verb in the bundle a client holds
  // for saving UI preferences. Both remote and desktop registrars move together;
  // the registry throws on a per-transport disagreement, which is the mechanism
  // that keeps this a single reviewed fact.
  handleIpc({
    channel: 'session:delete-session',
    capability: 'chat',
    kind: 'command',
    handler: safeHandler(async (sessionId: string, projectKey: string, engineId?: EngineId) => {
      await deleteSession(manager, sessionId, projectKey, engineId)
    })
  })

  handleIpc({
    channel: 'session:delete-project',
    capability: 'chat',
    kind: 'command',
    handler: safeHandler(async (projectKey: string) => {
      await deleteProject(manager, projectKey)
    })
  })

  handleIpc({
    channel: 'session:clear-conversation',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    handler: async (routingId: string, permissionMode?: string) => {
      await clearConversation(manager, routingId, permissionMode)
    }
  })

  handleIpc({
    channel: 'session:get-plan-content',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string) =>
      getPlanContent(manager, routingId)
  })

  handleIpc({
    channel: 'session:get-session-log-path',
    capability: 'chat',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string) =>
      getSessionLogPath(manager, routingId)
  })

  handleIpc({
    channel: 'session:list-directories',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => {
      // The MERGED listing (claude + opencode + pi), so a cold query and the
      // replicated `session:directories-changed` payload are the same value —
      // they used to be the claude-only subset and a per-client merge.
      return await listAllDirectories()
    }
  })

  handleIpc({
    channel: 'session:list-opencode',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => {
      return await listOpencodeSessionsGlobal()
    }
  })

  handleIpc({
    channel: 'session:load-opencode-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string) => {
      return await loadOpencodeSessionHistory(sessionId)
    }
  })

  handleIpc({
    channel: 'session:list-pi',
    capability: 'fs-read',
    kind: 'query',
    handler: async () => {
      return await listPiSessionsGlobal()
    }
  })

  handleIpc({
    channel: 'session:load-pi-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string) => {
      return await loadPiSessionHistory(sessionId)
    }
  })

  handleIpc({
    channel: 'file:list-dir',
    capability: 'fs-read',
    kind: 'query',
    handler: async (dirPath: string) => listDirEntries(dirPath)
  })

  handleIpc({
    channel: 'session:load-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, projectKey: string, resumeSessionAt?: string) => {
      return await loadSessionHistory(sessionId, projectKey, resumeSessionAt)
    }
  })

  handleIpc({
    channel: 'session:load-subagent-history',
    capability: 'fs-read',
    kind: 'query',
    handler: async (sessionId: string, projectKey: string, agentId: string) => {
      return await loadSubagentHistory(sessionId, projectKey, agentId)
    }
  })

  handleIpc({
    channel: 'session:build-subagent-file-map',
    capability: 'fs-read',
    kind: 'query',
    handler: (sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
      return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
    }
  })

  handleIpc({
    channel: 'session:load-background-output',
    capability: 'fs-read',
    kind: 'query',
    handler: (projectKey: string, taskId: string, outputFile?: string) => {
      return loadBackgroundOutput(projectKey, taskId, outputFile)
    }
  })

  handleIpc({
    channel: 'session:watch-session',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string, sessionId: string, projectKey: string, cwd?: string) => {
      watchSession(routingId, sessionId, projectKey, cwd)
    }
  })

  handleIpc({
    channel: 'session:unwatch-session',
    capability: 'fs-read',
    kind: 'query',
    sessionIdArg: 0,
    handler: (routingId: string) => {
      unwatchSession(routingId)
    }
  })

  // UI config persistence (~/.claude/ui/)
  handleIpc({
    channel: 'config:load-settings',
    capability: 'config',
    kind: 'query',
    handler: () => loadSettings()
  })
  handleIpc({
    channel: 'config:save-settings',
    capability: 'config',
    kind: 'command',
    handler: (incomingSettings: UISettings) =>
      saveUiSettings(manager, incomingSettings)
  })
  handleIpc({
    channel: 'config:load-sessions',
    capability: 'config',
    kind: 'query',
    handler: () => loadSessionConfig()
  })
  handleIpc({
    channel: 'config:save-sessions',
    capability: 'config',
    kind: 'command',
    handler: (config: UISessionConfig) =>
      saveSessions(config)
  })
  handleIpc({
    channel: 'config:load-slash-commands',
    capability: 'config',
    kind: 'query',
    handler: () => loadSlashCommands()
  })
  handleIpc({
    channel: 'config:scan-custom-commands',
    capability: 'config',
    kind: 'query',
    handler: (cwd: string) => scanCustomCommands(cwd)
  })
  handleIpc({
    channel: 'config:load-skill-details',
    capability: 'config',
    kind: 'query',
    handler: (cwd: string) => loadSkillDetails(manager, cwd)
  })
  // Cheap, deterministic engine availability check. Backs the renderer's
  // "is opencode/pi installed?" gate WITHOUT spawning a server/process — a
  // transient spawn/HTTP failure can no longer masquerade as "not installed".
  // Claude is always installed (it's the bundled default engine).
  handleIpc({
    channel: 'engine:is-installed',
    capability: 'config',
    kind: 'query',
    handler: (engineId: EngineId): boolean => {
      if (engineId === 'opencode') return opencodeServerManager.isBinaryAvailable()
      if (engineId === 'pi') return piBinaryAvailable()
      return true
    }
  })
  // Absolute path to the vendored pi binary, for the Settings › pi subscription
  // hint's copyable "run this command in a terminal" block. Null if not found.
  handleIpc({
    channel: 'pi:binary-path',
    capability: 'config',
    kind: 'query',
    handler: (): string | null => locatePiBinary()
  })
  // Read-only Codex (ChatGPT) auth-vault status for Settings › pi's "Connect
  // ChatGPT" UI (M6c) — mirrors 'pi:binary-path''s registration shape exactly.
  // Never returns token material; see CredentialSync.getStatus().
  handleIpc({
    channel: 'pi:auth-status',
    capability: 'config',
    kind: 'query',
    handler: () => credentialSync.getStatus()
  })
  handleIpc({
    channel: 'shared-provider:list',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async () => sharedProviderService.listDefinitions())
  })
  handleIpc({
    channel: 'shared-provider:statuses',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async () => sharedProviderService.listStatuses())
  })
  handleIpc({
    channel: 'shared-provider:models',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async (id: string) => sharedProviderService.listProviderModels(id))
  })
  // The shared-provider MUTATIONS (save/remove/set-route/set-key/sync/
  // disconnect/set-default) moved to `ipc/auth-commands.ts` in the S4 vendor-
  // OAuth series — ONE declaration both transports spread, so the remote UI can
  // edit provider routing too (ADR-057). The read half above (list/statuses/
  // models) stays inline: it was already on both transports.

  // Claude permission settings (allow/deny/ask rules)
  handleIpc({
    channel: 'claude:load-permissions',
    capability: 'config',
    kind: 'query',
    handler: (scope: string, cwd?: string) =>
      loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  })
  // Hot-reload is belt-and-braces, not the only propagation path: cli.js DOES
  // run its chokidar settings watcher in ClaudeUI's child, so a disk write
  // lands on its own within ~1-1.5s (awaitWriteFinish). notifySettingsChanged
  // makes it immediate and deterministic, and covers a missed watcher event.
  handleIpc({
    channel: 'claude:save-permissions',
    capability: 'config',
    kind: 'command',
    handler: async (scope: string, permissions: unknown, cwd?: string) =>
      savePermissionsAndNotify(
        manager,
        scope as PermissionScope,
        permissions as ClaudePermissions,
        cwd
      )
  })

  // Whether cli.js will honor this workspace's project/local ALLOW rules —
  // read-only surfacing of the trust gate (see isWorkspaceTrusted).
  handleIpc({
    channel: 'claude:workspace-trust',
    capability: 'config',
    kind: 'query',
    handler: (cwd: string) => isWorkspaceTrusted(cwd)
  })

  // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
  handleIpc({
    channel: 'claude:get-cleanup-period',
    capability: 'config',
    kind: 'query',
    handler: () => loadCleanupPeriodDays()
  })
  handleIpc({
    channel: 'claude:set-cleanup-period',
    capability: 'config',
    kind: 'command',
    handler: async (days: number) =>
      setCleanupPeriod(manager, days)
  })

  // MCP server management (Claude-only: capabilities.hostedMcp AND method presence —
  // opencode advertises hostedMcp:true but does not implement the MCP methods)
  handleIpc({
    channel: 'mcp:status',
    capability: 'config',
    kind: 'query',
    sessionIdArg: 0,
    handler: async (routingId: string) => mcpStatus(manager, routingId)
  })

  // MCP config file read/write (direct file access, no session needed)
  handleIpc({
    channel: 'mcp:load-servers',
    capability: 'config',
    kind: 'query',
    handler: (scope: string, cwd?: string) =>
      loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  })
  // MCP disabled state (direct ~/.claude.json access, no session needed)
  handleIpc({
    channel: 'mcp:read-disabled',
    capability: 'config',
    kind: 'query',
    handler: (cwd: string) => {
      return readDisabledMcpServers(cwd)
    }
  })

  // -------------------------------------------------------------------------
  // Git integration IPC handlers
  // -------------------------------------------------------------------------

  handleIpc({
    channel: 'git:check-repo',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.isGitRepo()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:status',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getStatus()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:branches',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getBranches()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:checkout',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, branch: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.checkout(branch)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:create-branch',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, name: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.createBranch(name)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:file-patch',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(
      async (
        cwd: string,
        filePath: string,
        staged: boolean,
        ignoreWhitespace: boolean
      ) => {
        const svc = gitServiceManager.get(cwd)
        try {
          return await svc.getFilePatch(filePath, staged, ignoreWhitespace)
        } finally {
          gitServiceManager.release(cwd)
        }
      }
    )
  })

  handleIpc({
    channel: 'git:file-contents',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (cwd: string, filePath: string, staged: boolean) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getFileContents(filePath, staged)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:stage-file',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.stageFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:unstage-file',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.unstageFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:discard-file',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.discardFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:stage-all',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.stageAll()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:unstage-all',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.unstageAll()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:commit',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, message: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.commit(message)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:push',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.push()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:push-with-upstream',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, branch: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.pushWithUpstream(branch)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:pull',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.pull()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  handleIpc({
    channel: 'git:fetch',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.fetch()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  })

  // Git polling — one poller per cwd, shared with the remote path through
  // gitWatchRegistry. GitService.startPolling() holds a SINGLE callback, so two
  // independent starts on one cwd would silently clobber each other; the registry
  // is what keeps every connection's interest coexisting on one poller. This is
  // also the only place that knows the fan-out, so it installs it.
  gitWatchRegistry.init((cwd, status) => {
    emitEvent('git:status-update', [{ cwd, status }])
  })

  // Per-connection interest (phase 5 S2). Same declaration the remote transport
  // registers — see `ipc/git-watch.ts`. The desktop is a connection like any
  // other: it dispatches under the process-wide `hostConnection()` id, which is
  // what its watch set is keyed by.
  handleIpc(GIT_WATCH_COMMAND)

  // The config / worktree family (S1b). ONE declaration per channel, spread here
  // for the desktop and in `remote-handlers.ts` for the WebSocket — see
  // `ipc/config-commands.ts` for what is in it and why each entry is reachable
  // from a phone.
  for (const cmd of configCommands(manager)) {
    handleIpc(cmd)
  }

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher()

  // Watch ~/.claude/ui/ config files for cross-instance sync. The watcher emits
  // through the funnel now, so it no longer needs an extra-window accessor.
  startConfigWatcher()

  // SyncCore phase 4b: canonical state is the `sync-full` source, so the fields
  // that come from files/queries rather than events have to be in it before the
  // first client connects. Non-blocking — nothing here gates IPC registration.
  void seedCanonicalAppState()

  const savedSettings = loadSettings() as Record<string, unknown>

  // Apply saved session idle timeout
  if (typeof savedSettings.sessionTimeoutMins === 'number') {
    manager.setSessionTimeout(savedSettings.sessionTimeoutMins * 60 * 1000)
  }
  // Apply saved log level + filter (merged with CLAUDE_UI_LOG env var)
  {
    const level =
      typeof savedSettings.logLevel === 'string'
        ? (savedSettings.logLevel as 'debug' | 'info' | 'warn' | 'error')
        : undefined
    const filter = typeof savedSettings.logFilter === 'string' ? savedSettings.logFilter : ''
    if (level || filter) {
      logger.applyFilter(filter, level)
    }
  }
  // Apply saved analytics refresh interval
  if (typeof savedSettings.analyticsRefreshSecs === 'number') {
    blockUsageService.setDebounceSecs(savedSettings.analyticsRefreshSecs)
  }

  // Account usage polling (5hr / 7-day rate limits).
  // Real-time updates come from SDK rate_limit_event messages (free, from
  // inference headers). Background polling (every 30 min) fetches supplementary
  // data (per-model breakdowns, extra_usage). Disk cache avoids API calls on
  // every launch.
  // Wire up SDK usage relay — tries active user sessions first, then
  // the always-on service session as fallback.
  usageFetcher.setSessionGetter(async () => {
    // Try active sessions first (they're already running; costUsd capability implies getUsage)
    const sessions: ISession[] = []
    manager.forEach((s) => sessions.push(s))
    for (const session of sessions) {
      try {
        const data = await session.getUsage?.()
        if (data != null) return data
      } catch {
        /* try next session */
      }
    }
    // Fall back to the service session (spawns lazily on first call)
    return serviceSession.getUsage()
  })
  // Apply saved refresh interval before starting
  if (typeof savedSettings.usageRefreshSecs === 'number') {
    usageFetcher.setIntervalSecs(savedSettings.usageRefreshSecs)
  }
  usageFetcher.startPolling()

  // Block usage analytics — watches JSONL files for changes (no polling).
  // Full scan on startup, then event-driven recalculation on file changes.
  // Disabled in dev builds to avoid snapshot write conflicts with the prod
  // instance. Set CLAUDE_UI_DEV_USAGE=1 to enable for testing.
  const skipUsageInDev = !hostIsPackaged() && !process.env.CLAUDE_UI_DEV_USAGE
  if (!skipUsageInDev) {
    // Phase 7 Pass 2 (Full SQL): run the backfill reconciler FIRST so usage_event
    // holds out-of-tool Claude + opencode usage before the first dashboard
    // emission (no flash of missing per-engine/opencode data). recalculate() is
    // itself self-sufficient for the Claude dashboard — it seeds daily_usage from
    // the legacy JSON files, self-upserts its freshly-parsed JSONL into
    // usage_event, then reads SQL-sourced blocks + daily — so even if reconcile
    // is slow/fails, the Claude blocks + history are never empty.
    //
    // Lazy import: usage-reconciler statically imports block-usage →
    // usage-fetcher → claude-session, so a static import from this module (which
    // is imported by claude-session) would form a static cycle. Loaded here at
    // IPC startup instead.
    import('../../core/services/usage-reconciler')
      .then(({ usageReconciler }) => {
        usageReconciler
          .reconcileAll()
          .catch(() => {})
          .finally(() => {
            blockUsageService.recalculate().catch((err) => {
              logger.error('BlockUsage', 'Initial recalculation failed', err)
            })
          })
        usageReconciler.start()
      })
      .catch(() => {})
    blockUsageService.startWatching()
  } else {
    logger.info(
      'IPC',
      'Dev mode — skipping block usage writes (set CLAUDE_UI_DEV_USAGE=1 to enable)'
    )
  }

  // IPC handlers — always registered so the renderer never gets "no handler" errors.
  handleIpc({
    channel: 'usage:fetch',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return usageFetcher.fetch()
    }
  })

  handleIpc({
    channel: 'usage:fetch-block',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return blockUsageService.getData() ?? (await blockUsageService.recalculate())
    }
  })

  handleIpc({
    channel: 'usage:set-account-filter',
    capability: 'config',
    kind: 'command',
    handler: async (account: string | null) => {
      blockUsageService.setAccountFilter(account)
    }
  })

  // ADR-033 M4-B: cross-engine dispatched usage, all-time, grouped by
  // (targetEngine, targetModel). Backs UsageView's "Delegated" section.
  handleIpc({
    channel: 'usage:fetch-dispatched',
    capability: 'config',
    kind: 'query',
    handler: async () => {
      return dispatchedUsageSummary()
    }
  })

  // Native Anthropic OAuth (ADR-014), multi-account MUTATIONS (ADR-015), the
  // engine-routed per-vendor auth channels (Phase 5c) and the shared-provider
  // MUTATIONS all moved to `ipc/auth-commands.ts` in the S4 vendor-OAuth series
  // (ADR-057): ONE declaration both transports spread, so the remote UI can
  // drive them too. `config` since ADR-056 (engine/vendor credentials, not the
  // session-security surface). The desktop-auth subsystem stays in `src/main`,
  // so the factory takes `requireEngineAuth` / `setAccountEnabled` injected here.
  //
  // `account:get` (a query) is NOT in that family — it stays inline below, as it
  // was already registered on both transports.
  handleIpc({
    channel: 'account:get',
    capability: 'config',
    kind: 'query',
    handler: async () => accountState()
  })
  for (const cmd of authCommands(authDeps)) {
    handleIpc(cmd)
  }

  // Mockup preview — read HTML from mockup directory. `cwd`/`directory` are
  // caller-supplied (and reachable remotely), so confine the read to a direct
  // child of the project's mockups root — a crafted `directory` (e.g. '../../..')
  // must not traverse out. Mirrors mockup-protocol.ts's path-traversal guard.
  handleIpc({
    channel: 'mockup:read-html',
    capability: 'fs-read',
    kind: 'query',
    handler: safeHandler(async (cwd: string, directory: string) => {
      const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
      const mockupDir = path.resolve(path.join(mockupsRoot, directory))
      if (!isPathInside(mockupsRoot, mockupDir)) {
        throw new Error('Invalid mockup directory')
      }
      return fs.promises.readFile(path.join(mockupDir, 'index.html'), 'utf-8')
    })
  })

  // Mockup file watcher — watches a mockup directory for changes
  const mockupWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }
  >()

  handleIpc({
    channel: 'mockup:watch',
    capability: 'fs-read',
    kind: 'query',
    handler: (cwd: string, directory: string) => {
      const key = `${cwd}:${directory}`
      if (mockupWatchers.has(key)) return // already watching

      const dirPath = path.join(cwd, '.claude', 'ui', 'mockups', directory)
      if (!fs.existsSync(dirPath)) return

      const entry = {
        watcher: null! as fs.FSWatcher,
        debounceTimer: null as ReturnType<typeof setTimeout> | null
      }

      // Recursive so edits to sibling subdirs (e.g. `images/hero.png`,
      // `components/card.css`) also trigger reloads. Debounced so editors
      // that atomic-write via temp-file + rename don't fire multiple times.
      entry.watcher = fs.watch(dirPath, { recursive: true }, (_event, filename) => {
        if (!filename) return
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.debounceTimer = setTimeout(() => {
          // Uniform delivery since SyncCore phase 4c: this watcher used to be
          // main-window-only while the remote-registered one (remote-handlers.ts)
          // fanned out, which meant a reconnecting client replayed a notify it
          // could never receive live (4a's "catchup leak"). Both reach every
          // subscriber now.
          emitEvent('mockup:file-changed', [directory])
        }, 200)
      })

      mockupWatchers.set(key, entry)
    }
  })

  handleIpc({
    channel: 'mockup:unwatch',
    capability: 'fs-read',
    kind: 'query',
    handler: (cwd: string, directory: string) => {
      const key = `${cwd}:${directory}`
      const entry = mockupWatchers.get(key)
      if (entry) {
        entry.watcher.close()
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        mockupWatchers.delete(key)
      }
    }
  })

  return manager
}

/** Matches the 30 s cadence the sidebar polled at before the merge moved here. */
const DIRECTORY_POLL_MS = 30_000

/**
 * Keep the replicated sidebar listing fresh: a watcher on Claude's transcripts,
 * plus a poll for the two engines that have no watchable path.
 *
 * The POLL is unconditional and starts first, deliberately. Only Claude keeps
 * transcripts under `~/.claude/projects`; opencode keeps sessions in its own
 * store and pi in `~/.pi`, so on a machine that has never run Claude the watcher
 * below returns early and the poll would be the ONLY thing that ever refreshed
 * the sidebar. `refreshCanonicalDirectories` emits only when the merged listing
 * actually changed, so a quiet host adds nothing to the ring; `unref()` keeps
 * the timer from holding the process open at quit.
 */
function startProjectsWatcher(): void {
  setInterval(() => {
    void refreshCanonicalDirectories()
  }, DIRECTORY_POLL_MS).unref?.()

  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // ONE call: it re-reads the MERGED listing and emits
      // `session:directories-changed` carrying it (only when the listing really
      // changed), so canonical and every live client are updated by the same
      // fold — the refetch-per-client round trip is gone. Fire-and-forget: the
      // watcher must not wait on a directory walk.
      void refreshCanonicalDirectories()
    }, 500)
  }

  // Watch each project subdirectory for JSONL file changes
  // (fs.watch recursive option works on macOS and Windows)
  try {
    fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        notify()
      }
    })
  } catch (err) {
    logger.warn('ProjectsWatcher', 'Failed to watch projects directory', err)
  }
}

/**
 * Mark catalog entries whose vendor id is claimed by an ENABLED shared-provider
 * route (today: `chatgpt` → opencode vendor `openai`).
 *
 * Why the row needs to know: CredentialSync re-feeds a shared credential on
 * every refresh, so removing that credential in the opencode provider manager is
 * silently undone — "Remove" would appear to do nothing. The row warns and
 * offers to turn the shared route off instead of losing the race.
 */
function decorateSharedProviderClaims(
  catalog: OpencodeProviderCatalogEntry[]
): OpencodeProviderCatalogEntry[] {
  let claims: Map<string, { id: string; name: string }>
  try {
    claims = new Map(
      sharedProviderService
        .listDefinitions()
        .filter((definition) => definition.routes.opencode.enabled)
        .map((definition) => [
          definition.routes.opencode.providerId ?? definition.id,
          { id: definition.id, name: definition.name }
        ])
    )
  } catch (err) {
    // Shared-provider config is optional; an unreadable definition must not take
    // down the provider list.
    logger.warn('opencode', `Shared-provider claim lookup failed: ${String(err)}`)
    return catalog
  }
  return catalog.map((entry) => {
    const claim = claims.get(entry.id)
    return claim ? { ...entry, sharedProviderClaim: claim } : entry
  })
}
