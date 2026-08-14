import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '../sdk'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { SessionManager } from '../services/session-manager'
import { getSdkExecutableOpts } from '../services/claude-session'
import { emitEvent } from '../services/sync-host'
import { seedCanonicalAppState, refreshCanonicalDirectories } from '../services/sync-seed'
import {
  listDirectories,
  loadSessionHistory,
  loadSubagentHistory,
  buildSubagentFileMap,
  loadBackgroundOutput,
  resolveForkAnchor
} from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { isPathInside, assertSafePathSegment } from '../services/path-containment'
import { socks5Connect } from '../services/socks-bridge'
import {
  loadSettings,
  loadSessionConfig,
  loadSlashCommands,
  saveSlashCommands,
  startConfigWatcher,
  loadEngineConfig,
  saveEngineConfig,
  loadVendorConfig,
  saveVendorConfig
} from '../services/ui-config'
import {
  loadClaudePermissions,
  loadCleanupPeriodDays,
  isWorkspaceTrusted
} from '../services/claude-settings'
import {
  loadMcpServers,
  saveMcpServers,
  removeMcpServer,
  readDisabledMcpServers,
  writeDisabledMcpServers
} from '../services/claude-mcp'
import { scanCustomCommands } from '../services/custom-command-scanner'
import type { UISettings, UISessionConfig, SlashCommandCache } from '../services/ui-config'
import { gitServiceManager } from '../services/git-service'
import { gitWatchRegistry, GIT_WATCH_OWNER_DESKTOP } from '../services/git-watch-registry'
import {
  createWorktree,
  getWorktreeStatus,
  removeWorktree,
  listWorktrees
} from '../services/worktree'
import { usageFetcher } from '../services/usage-fetcher'
import { serviceSession } from '../services/service-session'
import { blockUsageService } from '../services/block-usage'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import { dispatchedUsageSummary } from '../services/db'
import '../auth/register-auth-providers'
import { engineAuthRegistry } from '../auth/EngineAuthRegistry'
import { claudeAuthProvider } from '../auth/ClaudeAuthProvider'
import { credentialSync } from '../auth/vault/CredentialSync'
import { sharedProviderService } from '../shared-providers'
import { authManager } from '../services/auth-manager'
import { accountManager } from '../services/account-manager'
import type {
  ApprovalDecision,
  ModelInfo,
  EngineModelGroup,
  ProxySettings,
  PermissionSuggestion,
  IpcResult,
  EngineId,
  EngineConfig,
  VendorConfig,
  VendorAuthMap,
  VendorAuthOption,
  OpencodeProviderCatalogEntry,
  ProviderRemoveKind,
  PermissionScope,
  ClaudePermissions
} from '../../shared/types'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition
} from '../../shared/shared-provider'
import {
  discoverOpencodeModels,
  invalidateOpencodeModelCache,
  discoverOpencodeProviderCatalog,
  getOpencodeProviderModels
} from '../opencode/model-discovery'
import {
  removeOpencodeProvider,
  setOpencodeProviderDisabled
} from '../opencode/provider-management'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import {
  discoverPiModels,
  getPiModelCatalogGroups,
  invalidatePiModelCache
} from '../pi/model-discovery'
import { piBinaryAvailable, locatePiBinary } from '../pi/pi-locate'
import {
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig,
  migrateOpencodeConfigToNative
} from '../opencode/opencode-config'
import {
  readOpencodeNativeRaw,
  patchOpencodeNativeRaw
} from '../opencode/opencode-native-raw'
import type { OpencodeConfigSettings, RawConfigPatch } from '../../shared/types'
import {
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  setAgentDisabled,
} from '../opencode/opencode-agents'
import type { OpencodeAgentInput } from '../opencode/opencode-agents'
import { generateAgent } from '../opencode/agent-generate'
import { refreshPrices } from '../services/opencode-pricing'
import { logger } from '../services/logger'
import { deleteProjectFiles } from '../services/delete-session-files'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory
} from '../services/opencode-session-list'
import { listPiSessionsGlobal, loadPiSessionHistory } from '../services/pi-session-list'
import { deleteSessionByEngine } from '../services/session-delete'
import type { ISession } from '../providers/ISession'
import { prepareAndCreateSession } from './create-session'
import {
  commandRegistry,
  desktopConnection,
  registerCommand,
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
  listDirEntries
} from './handlers-core'

/**
 * Wraps an async IPC handler with try-catch, returning a standardized IpcResult envelope.
 * Use this for handlers that can throw (git, MCP, worktree, file operations) but NOT for
 * fire-and-forget handlers (session:send) or those that already have proper error handling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeHandler<T>(handler: (...args: any[]) => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<IpcResult<T>> => {
    try {
      const data = await handler(...args)
      return { ok: true, data }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('IPC', error)
      return { ok: false, error }
    }
  }
}

/**
 * Register one desktop-transport command and wire its `ipcMain.handle`.
 *
 * The ONE way this file exposes a channel (SyncCore phase 1 — ADR-051/052).
 * The declaration (capability/kind/sessionIdArg) goes into the shared command
 * registry, which the remote transport also registers into, and the actual
 * dispatch — capability check + audit — happens in the registry. Both
 * transports therefore pass through the same choke point.
 *
 * Handlers no longer receive the Electron `IpcMainInvokeEvent`: nothing in this
 * file ever used it (every body named it `_e`/`_event`), and a handler body
 * that a headless core can also call must not know about Electron at all. The
 * event stays here, in the transport adapter, and never reaches the registry.
 */
function handleIpc(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'desktop' })
  ipcMain.handle(reg.channel, (_event, ...args: unknown[]) =>
    commandRegistry.dispatch(reg.channel, 'desktop', args, desktopConnection())
  )
}

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
      // reportLoginStatus broadcasts session:auth-source to the window (legacy path).
      authManager.reportLoginStatus(init?.account)
      // Also update the ClaudeAuthProvider probe cache so probe() and session.account
      // are accurate from the first model-fetch, before any chat session opens.
      const acc = init?.account as Record<string, unknown> | undefined
      if (acc) {
        const loggedIn = !!(acc.email)
        claudeAuthProvider.updateAuthSource(loggedIn ? 'authenticated' : 'none', {
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
  'git:start-watching',
  'git:stop-watching',
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

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/**
 * Test proxy connectivity by making a real HTTPS request through the proxy
 * to api.anthropic.com. A 401 (Unauthorized) proves the proxy works — we're
 * testing the tunnel, not the API key.
 */
async function testProxyConnection(
  proxy: ProxySettings
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const http = await import('node:http')
  const tls = await import('node:tls')

  const start = Date.now()
  const TARGET_HOST = 'api.anthropic.com'
  const TARGET_PORT = 443
  const TIMEOUT_MS = 10_000

  /** Upgrade a raw socket to TLS, send a GET, and check the HTTP status. */
  function verifyThroughTls(
    rawSocket: import('node:net').Socket
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        tlsSocket.destroy()
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'TLS handshake timed out' })
      }, TIMEOUT_MS)

      const tlsSocket = tls.connect({ socket: rawSocket, servername: TARGET_HOST }, () => {
        // TLS established — send a minimal HTTP request
        tlsSocket.write(
          `GET /v1/models HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nConnection: close\r\n\r\n`
        )
      })

      tlsSocket.once('data', (chunk: Buffer) => {
        clearTimeout(timer)
        tlsSocket.destroy()
        const head = chunk.toString('utf8', 0, Math.min(chunk.length, 128))
        const statusMatch = head.match(/^HTTP\/\d\.\d (\d{3})/)
        if (statusMatch) {
          // Any HTTP response (even 401) means the proxy routed traffic successfully
          resolve({ ok: true, latencyMs: Date.now() - start })
        } else {
          resolve({
            ok: false,
            latencyMs: Date.now() - start,
            error: 'Unexpected response from server'
          })
        }
      })

      tlsSocket.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, latencyMs: Date.now() - start, error: `TLS error: ${err.message}` })
      })
    })
  }

  if (proxy.type === 'socks5') {
    // SOCKS5 handshake (RFC 1928) → connect to target → TLS verify.
    // LOW-RW5: the handshake is socks-bridge.ts's socks5Connect. The hand-rolled
    // copy that used to live here assumed one SOCKS5 message per TCP chunk, so a
    // split greeting/CONNECT reply failed the proxy test spuriously.
    return new Promise((resolve) => {
      let settled = false
      // The outer 10s budget stays authoritative (socks5Connect's own 15s
      // internal timeout would otherwise outlive it).
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out (10s)' })
      }, TIMEOUT_MS)

      socks5Connect(
        {
          socksHost: proxy.hostname,
          socksPort: proxy.port,
          username: proxy.username,
          password: proxy.password
        },
        TARGET_HOST,
        TARGET_PORT
      )
        .then(async ({ socket, leftover }) => {
          if (settled) {
            // Outer timeout already answered — drop the late tunnel.
            socket.destroy()
            return
          }
          settled = true
          clearTimeout(timer)
          // For TLS the client speaks first, so the proxy should not have sent
          // anything past the CONNECT reply — but never drop bytes if it did.
          if (leftover.length > 0) socket.unshift(leftover)
          resolve(await verifyThroughTls(socket))
        })
        .catch((err: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, latencyMs: Date.now() - start, error: err.message })
        })
    })
  }

  // HTTP proxy: CONNECT tunnel → TLS verify
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out (10s)' })
    }, TIMEOUT_MS)

    const authHeader = proxy.username
      ? {
          'Proxy-Authorization':
            'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
        }
      : {}

    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${TARGET_HOST}:${TARGET_PORT}`,
      headers: authHeader
    })

    req.on('connect', async (res, socket) => {
      clearTimeout(timer)
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({
          ok: false,
          latencyMs: Date.now() - start,
          error: `Proxy returned HTTP ${res.statusCode}`
        })
        return
      }
      // Tunnel open — verify with TLS
      const result = await verifyThroughTls(socket)
      resolve(result)
    })

    req.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, latencyMs: Date.now() - start, error: err.message })
    })

    req.end()
  })
}

/** Shared SessionManager — created once, used by both IPC and remote handlers. */
let sharedManager: SessionManager | null = null
export function getSessionManager(): SessionManager | null {
  return sharedManager
}

export function registerSessionIpc(win: BrowserWindow): SessionManager {
  // Remove previous handlers to allow re-registration (e.g. macOS dock re-open)
  for (const channel of SESSION_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  const manager = new SessionManager()
  sharedManager = manager

  handleIpc({
    channel: 'session:pick-folder',
    capability: 'host',
    kind: 'command',
    handler: async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
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

  // Proxy test connection
  handleIpc({
    channel: 'proxy:test-connection',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (proxy: ProxySettings) => {
      return await testProxyConnection(proxy)
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

  handleIpc({
    channel: 'session:delete-session',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (sessionId: string, projectKey: string, engineId?: EngineId) => {
      await deleteSessionByEngine(sessionId, projectKey, engineId)
    })
  })

  handleIpc({
    channel: 'session:delete-project',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (projectKey: string) => {
      await deleteProjectFiles(projectKey)
    })
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
      return await listDirectories()
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
    handler: async (sessionId: string, projectKey: string) => {
      return await loadSessionHistory(sessionId, projectKey)
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
    handler: (routingId: string, sessionId: string, projectKey: string) => {
      watchSession(routingId, sessionId, projectKey)
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
    channel: 'config:save-slash-commands',
    capability: 'config',
    kind: 'command',
    handler: (commands: SlashCommandCache[]) =>
      saveSlashCommands(commands)
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
  handleIpc({
    channel: 'config:load-engine-config',
    capability: 'config',
    kind: 'query',
    handler: (engineId: string) =>
      loadEngineConfig(engineId)
  })
  handleIpc({
    channel: 'config:save-engine-config',
    capability: 'config',
    kind: 'command',
    handler: (engineId: string, cfg: EngineConfig) => {
      saveEngineConfig(engineId, cfg)
      // Provider enable/disable + custom-provider edits change which models the
      // discovery server returns. Drop the cache so the next getEngineModels()
      // re-discovers (otherwise a disabled/re-enabled provider only reflects after
      // an app restart).
      if (engineId === 'opencode') invalidateOpencodeModelCache()
      if (engineId === 'pi') invalidatePiModelCache()
    }
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
    channel: 'config:load-vendor-config',
    capability: 'config',
    kind: 'query',
    handler: (vendorId: string) =>
      loadVendorConfig(vendorId)
  })
  handleIpc({
    channel: 'config:save-vendor-config',
    capability: 'config',
    kind: 'command',
    handler: (vendorId: string, cfg: VendorConfig) =>
      saveVendorConfig(vendorId, cfg)
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
  handleIpc({
    channel: 'shared-provider:save',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (definition: SharedProviderDefinition) =>
      sharedProviderService.saveDefinition(definition)
    )
  })
  handleIpc({
    channel: 'shared-provider:remove',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (id: string) => sharedProviderService.removeDefinition(id))
  })
  handleIpc({
    channel: 'shared-provider:set-route',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(
      async (id: string, harness: ConfigurableHarnessId, enabled: boolean) =>
        sharedProviderService.setRouteEnabled(id, harness, enabled)
    )
  })
  handleIpc({
    channel: 'shared-provider:set-key',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (id: string, key: string) => sharedProviderService.setApiKey(id, key))
  })
  handleIpc({
    channel: 'shared-provider:sync',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (id: string) => sharedProviderService.syncProvider(id))
  })
  handleIpc({
    channel: 'shared-provider:disconnect',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (id: string) => sharedProviderService.disconnectProvider(id))
  })
  handleIpc({
    channel: 'shared-provider:set-default',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(
      async (id: string, harness: ConfigurableHarnessId, modelId?: string) =>
        sharedProviderService.setRouteDefaultModel(id, harness, modelId)
    )
  })

  // opencode engine-native settings — read/write opencode's OWN config file.
  // The load handler triggers the one-time migration from the private store when
  // the opencode binary is available. modelAllowlist stays ClaudeUI-private.
  handleIpc({
    channel: 'config:load-opencode-settings',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async () => {
      if (opencodeServerManager.isBinaryAvailable()) {
        migrateOpencodeConfigToNative()
      }
      const native = readOpencodeNativeConfig()
      const privCfg = loadEngineConfig('opencode')
      const modelAllowlist = privCfg.opencodeConfig?.modelAllowlist
      const result: OpencodeConfigSettings = {
        ...native,
        ...(modelAllowlist !== undefined ? { modelAllowlist } : {})
      }
      return result
    })
  })
  handleIpc({
    channel: 'config:save-opencode-settings',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (settings: OpencodeConfigSettings) => {
      // Write the six native fields to opencode's own config file.
      const { modelAllowlist, ...nativeFields } = settings
      writeOpencodeNativeConfig(nativeFields)
      // Route modelAllowlist to the private EngineConfig, preserving autoMode/sandbox/proxy.
      // The private opencodeConfig only holds modelAllowlist now (six native fields moved to disk).
      const engCfg = loadEngineConfig('opencode')
      const nextOpencodeConfig: OpencodeConfigSettings | undefined =
        modelAllowlist !== undefined && Object.keys(modelAllowlist).length > 0
          ? { modelAllowlist }
          : engCfg.opencodeConfig?.modelAllowlist &&
              Object.keys(engCfg.opencodeConfig.modelAllowlist).length > 0
            ? { modelAllowlist: engCfg.opencodeConfig.modelAllowlist }
            : undefined
      saveEngineConfig('opencode', {
        ...engCfg,
        opencodeConfig: nextOpencodeConfig
      })
      // Provider changes affect the discoverable model set.
      invalidateOpencodeModelCache()
    })
  })

  // Raw (non-lossy) opencode config access for the schema-driven settings editor.
  // Reads opencode's own config file verbatim; patches literal opencode field
  // names as jsonc leaf edits (comment-safe). Unlike save-opencode-settings this
  // never projects — it writes exactly the paths the UI names.
  handleIpc({
    channel: 'config:read-opencode-native-raw',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async () => readOpencodeNativeRaw())
  })
  handleIpc({
    channel: 'config:patch-opencode-native',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (patches: RawConfigPatch[]) => {
      patchOpencodeNativeRaw(patches)
      // Capability edits (attachment/modalities/…) change model discovery.
      invalidateOpencodeModelCache()
    })
  })

  // opencode agent CRUD — list/read/save/delete/disable custom + built-in agents
  handleIpc({
    channel: 'opencode-agents:list',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async (cwd?: string) => listAgents(cwd))
  })
  handleIpc({
    channel: 'opencode-agents:read',
    capability: 'config',
    kind: 'query',
    handler: safeHandler(async (name: string, scope: string, cwd?: string) =>
      readAgent(name, scope as 'global' | 'project', cwd)
    )
  })
  handleIpc({
    channel: 'opencode-agents:save',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (input: OpencodeAgentInput, cwd?: string) =>
      saveAgent(input, cwd)
    )
  })
  handleIpc({
    channel: 'opencode-agents:delete',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(async (name: string, scope: string, cwd?: string) =>
      deleteAgent(name, scope as 'global' | 'project', cwd)
    )
  })
  handleIpc({
    channel: 'opencode-agents:set-disabled',
    capability: 'config',
    kind: 'command',
    handler: safeHandler(
      async (name: string, scope: string, cwd: string | undefined, disabled: boolean) =>
        setAgentDisabled(name, scope as 'global' | 'project', cwd, disabled)
    )
  })
  handleIpc({
    channel: 'opencode-agents:generate',
    capability: 'chat',
    kind: 'command',
    handler: safeHandler(async (description: string, cwd?: string) =>
      generateAgent(description, cwd)
    )
  })

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

  handleIpc({
    channel: 'mcp:toggle',
    capability: 'config',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string, serverName: string, enabled: boolean) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpToggleServer)
        throw new Error('Provider does not support hosted MCP')
      await session.mcpToggleServer(serverName, enabled)
    })
  })

  handleIpc({
    channel: 'mcp:reconnect',
    capability: 'config',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string, serverName: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpReconnectServer)
        throw new Error('Provider does not support hosted MCP')
      await session.mcpReconnectServer(serverName)
    })
  })

  handleIpc({
    channel: 'mcp:set-servers',
    capability: 'config',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(async (routingId: string, servers: Record<string, unknown>) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpSetServers)
        throw new Error('Provider does not support hosted MCP')
      return await session.mcpSetServers(servers)
    })
  })

  // MCP config file read/write (direct file access, no session needed)
  handleIpc({
    channel: 'mcp:load-servers',
    capability: 'config',
    kind: 'query',
    handler: (scope: string, cwd?: string) =>
      loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  })
  handleIpc({
    channel: 'mcp:save-servers',
    capability: 'config',
    kind: 'command',
    handler: (scope: string, servers: Record<string, unknown>, cwd?: string) =>
      saveMcpServers(scope as 'user' | 'project' | 'local', servers as never, cwd)
  })
  handleIpc({
    channel: 'mcp:remove-server',
    capability: 'config',
    kind: 'command',
    handler: (scope: string, serverName: string, cwd?: string) =>
      removeMcpServer(scope as 'user' | 'project' | 'local', serverName, cwd)
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

  handleIpc({
    channel: 'mcp:toggle-disabled',
    capability: 'config',
    kind: 'command',
    handler: async (cwd: string, serverName: string, enabled: boolean) => {
      const disabled = readDisabledMcpServers(cwd)
      let updated: string[]
      if (enabled) {
        updated = disabled.filter((n) => n !== serverName)
      } else {
        updated = disabled.includes(serverName) ? disabled : [...disabled, serverName]
      }
      writeDisabledMcpServers(cwd, updated)
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
  // independent starts on one cwd would silently clobber each other; the
  // registry is what keeps desktop and remote owners coexisting. This is also
  // the only place that knows the window fan-out, so it installs it.
  gitWatchRegistry.init((cwd, status) => {
    emitEvent('git:status-update', [{ cwd, status }])
  })

  handleIpc({
    channel: 'git:start-watching',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => {
      gitWatchRegistry.startWatching(cwd, GIT_WATCH_OWNER_DESKTOP)
    }
  })

  handleIpc({
    channel: 'git:stop-watching',
    capability: 'git',
    kind: 'query',
    handler: async (cwd: string) => {
      gitWatchRegistry.stopWatching(cwd, GIT_WATCH_OWNER_DESKTOP)
    }
  })

  // -------------------------------------------------------------------------
  // Worktree IPC handlers
  // -------------------------------------------------------------------------

  handleIpc({
    channel: 'worktree:create',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (cwd: string, name: string) => {
      return await createWorktree(cwd, name)
    })
  })

  handleIpc({
    channel: 'worktree:status',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (worktreePath: string, originalHead: string) => {
      return await getWorktreeStatus(worktreePath, originalHead)
    })
  })

  handleIpc({
    channel: 'worktree:remove',
    capability: 'git',
    kind: 'command',
    handler: safeHandler(async (worktreePath: string, branch: string, gitRoot: string) => {
      await removeWorktree(worktreePath, branch, gitRoot)
    })
  })

  handleIpc({
    channel: 'worktree:list',
    capability: 'git',
    kind: 'query',
    handler: safeHandler(async (cwd: string) => {
      return await listWorktrees(cwd)
    })
  })

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
  const skipUsageInDev = !app.isPackaged && !process.env.CLAUDE_UI_DEV_USAGE
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
    import('../services/usage-reconciler')
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

  // Phase 9b: fetch opencode pricing from /config/providers, persist + register.
  // Desktop-only — spawns a local opencode server; blocked from remote dispatch.
  handleIpc({
    channel: 'usage:refresh-prices',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async () => refreshPrices())
  })

  // Native Anthropic OAuth (ADR-014) — routed through EngineAuthProvider.
  // Channels and payloads are unchanged; the registry defaults to 'claude'.
  const claudeAuth = engineAuthRegistry.require('claude')
  handleIpc({
    channel: 'auth:sign-in',
    capability: 'admin',
    kind: 'command',
    handler: async () => claudeAuth.signIn?.()
  })
  handleIpc({
    channel: 'auth:submit-code',
    capability: 'admin',
    kind: 'command',
    handler: async (code: string) => claudeAuth.submitCode?.(code)
  })
  handleIpc({
    channel: 'auth:cancel',
    capability: 'admin',
    kind: 'command',
    handler: async () => claudeAuth.cancelSignIn?.()
  })

  // Multiple-account support (ADR-015) — routed through EngineAuthProvider for
  // add/switch/delete; setEnabled stays direct on AccountManager (not on the interface).
  handleIpc({
    channel: 'account:get',
    capability: 'config',
    kind: 'query',
    handler: async () => accountManager.getState()
  })
  handleIpc({
    channel: 'account:set-enabled',
    capability: 'admin',
    kind: 'command',
    handler: async (enabled: boolean) =>
      accountManager.setEnabled(enabled)
  })
  handleIpc({
    channel: 'account:add',
    capability: 'admin',
    kind: 'command',
    handler: async () => claudeAuth.addAccount?.()
  })
  handleIpc({
    channel: 'account:switch',
    capability: 'admin',
    kind: 'command',
    handler: async (id: string) => claudeAuth.switchAccount?.(id)
  })
  handleIpc({
    channel: 'account:delete',
    capability: 'admin',
    kind: 'command',
    handler: async (id: string) => claudeAuth.deleteAccount?.(id)
  })

  // -------------------------------------------------------------------------
  // Engine-routed per-vendor auth channels (opencode multi-vendor auth, Phase 5c)
  // Each handler dispatches to engineAuthRegistry.require(engineId) and guards
  // the optional per-vendor method — throws a clear error if the provider lacks it.
  // Claude auth is unchanged: auth:* / account:* above stay byte-identical.
  // -------------------------------------------------------------------------

  handleIpc({
    channel: 'vendor-auth:probe',
    capability: 'admin',
    kind: 'query',
    handler: safeHandler(async (engineId: EngineId): Promise<VendorAuthMap> => {
      const provider = engineAuthRegistry.require(engineId)
      return provider.probe()
    })
  })

  handleIpc({
    channel: 'vendor-auth:list-options',
    capability: 'admin',
    kind: 'query',
    handler: safeHandler(
      async (engineId: EngineId): Promise<Record<string, VendorAuthOption[]>> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.listVendorAuthOptions) {
          throw new Error(`Engine "${engineId}" does not support listVendorAuthOptions`)
        }
        return provider.listVendorAuthOptions()
      }
    )
  })

  handleIpc({
    channel: 'vendor-auth:list-keys',
    capability: 'admin',
    kind: 'query',
    handler: safeHandler(
      async (engineId: EngineId): Promise<Record<string, 'api' | 'oauth'>> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.listVendorCredentialIds) {
          throw new Error(`Engine "${engineId}" does not support listVendorCredentialIds`)
        }
        return provider.listVendorCredentialIds()
      }
    )
  })

  handleIpc({
    channel: 'vendor-auth:set-key',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (engineId: EngineId, vendorId: string, key: string): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      if (!provider.setVendorApiKey) {
        throw new Error(`Engine "${engineId}" does not support setVendorApiKey`)
      }
      return provider.setVendorApiKey(vendorId, key)
    })
  })

  handleIpc({
    channel: 'vendor-auth:oauth-authorize',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(
      async (
        engineId: EngineId,
        vendorId: string,
        method: number,
        inputs?: Record<string, string>
      ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.oauthAuthorize) {
          throw new Error(`Engine "${engineId}" does not support oauthAuthorize`)
        }
        return provider.oauthAuthorize(vendorId, method, inputs)
      }
    )
  })

  handleIpc({
    channel: 'vendor-auth:oauth-callback',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(
      async (
        engineId: EngineId,
        vendorId: string,
        method: number,
        code?: string
      ): Promise<boolean> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.oauthCallback) {
          throw new Error(`Engine "${engineId}" does not support oauthCallback`)
        }
        return provider.oauthCallback(vendorId, method, code)
      }
    )
  })

  handleIpc({
    channel: 'vendor-auth:remove',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (engineId: EngineId, vendorId: string): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      if (!provider.removeVendorAuth) {
        throw new Error(`Engine "${engineId}" does not support removeVendorAuth`)
      }
      return provider.removeVendorAuth(vendorId)
    })
  })

  handleIpc({
    channel: 'vendor-auth:oauth-cancel',
    capability: 'admin',
    kind: 'command',
    handler: safeHandler(async (engineId: EngineId): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      // No-op if the engine doesn't drive OAuth flows.
      await provider.cancelVendorOauth?.()
    })
  })

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

function startProjectsWatcher(): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // Canonical holds the listing the notify tells clients to refetch (phase
      // 4b): the snapshot carries `directories`, so core must refresh from the
      // SAME trigger or a resyncing client would get a stale sidebar while a
      // live one got a fresh one. Fire-and-forget — the notify must not wait on
      // a directory walk.
      void refreshCanonicalDirectories()
      emitEvent('session:directories-changed', [])
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
