import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '../sdk'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { SessionManager } from '../services/session-manager'
import { getSdkExecutableOpts } from '../services/claude-session'
import { BaseSession } from '../providers/BaseSession'
import {
  listDirectories,
  loadSessionHistory,
  loadSubagentHistory,
  buildSubagentFileMap,
  loadBackgroundOutput,
  resolveForkAnchor
} from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
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
  saveClaudePermissions,
  loadCleanupPeriodDays
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
import {
  createWorktree,
  getWorktreeStatus,
  removeWorktree,
  listWorktrees
} from '../services/worktree'
import { usageFetcher } from '../services/usage-fetcher'
import { serviceSession } from '../services/service-session'
import { blockUsageService } from '../services/block-usage'
import { usageReconciler } from '../services/usage-reconciler'
import { crossEngineDispatcher, XENG_REQUEST_PREFIX } from '../services/cross-engine-dispatcher'
import '../auth/register-auth-providers'
import { engineAuthRegistry } from '../auth/EngineAuthRegistry'
import { claudeAuthProvider } from '../auth/ClaudeAuthProvider'
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
  VendorAuthOption
} from '../../shared/types'
import {
  discoverOpencodeModels,
  invalidateOpencodeModelCache,
  discoverOpencodeProviderCatalog,
  getOpencodeProviderModels
} from '../opencode/model-discovery'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
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
import { deleteSessionByEngine } from '../services/session-delete'
import type { ISession } from '../providers/ISession'
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
  'session:get-opencode-provider-models',
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
  const net = await import('node:net')

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
    // SOCKS5 handshake (RFC 1928) → connect to target → TLS verify
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy()
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out (10s)' })
      }, TIMEOUT_MS)

      const socket = net.connect({ host: proxy.hostname, port: proxy.port })

      socket.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, latencyMs: Date.now() - start, error: err.message })
      })

      socket.once('connect', () => {
        // Step 1: greeting — offer no-auth (0x00) and user/pass (0x02)
        const methods = proxy.username
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00])
        socket.write(methods)
      })

      let phase: 'greeting' | 'auth' | 'connect' = 'greeting'

      socket.on('data', async (data: Buffer) => {
        if (phase === 'greeting') {
          if (data.length < 2 || data[0] !== 0x05) {
            clearTimeout(timer)
            socket.destroy()
            resolve({
              ok: false,
              latencyMs: Date.now() - start,
              error: 'Invalid SOCKS5 greeting response'
            })
            return
          }
          const method = data[1]
          if (method === 0x02 && proxy.username) {
            // Step 2: username/password auth (RFC 1929)
            phase = 'auth'
            const uBuf = Buffer.from(proxy.username, 'utf8')
            const pBuf = Buffer.from(proxy.password, 'utf8')
            const authBuf = Buffer.alloc(3 + uBuf.length + pBuf.length)
            authBuf[0] = 0x01 // version
            authBuf[1] = uBuf.length
            uBuf.copy(authBuf, 2)
            authBuf[2 + uBuf.length] = pBuf.length
            pBuf.copy(authBuf, 3 + uBuf.length)
            socket.write(authBuf)
          } else if (method === 0x00) {
            // No auth required — send connect request
            phase = 'connect'
            socket.write(buildSocks5ConnectRequest(TARGET_HOST, TARGET_PORT))
          } else if (method === 0xff) {
            clearTimeout(timer)
            socket.destroy()
            resolve({
              ok: false,
              latencyMs: Date.now() - start,
              error: 'SOCKS5 proxy rejected authentication methods'
            })
          }
        } else if (phase === 'auth') {
          if (data.length < 2 || data[1] !== 0x00) {
            clearTimeout(timer)
            socket.destroy()
            resolve({
              ok: false,
              latencyMs: Date.now() - start,
              error: 'SOCKS5 authentication failed'
            })
            return
          }
          // Auth succeeded — send connect request
          phase = 'connect'
          socket.write(buildSocks5ConnectRequest(TARGET_HOST, TARGET_PORT))
        } else if (phase === 'connect') {
          if (data.length < 2 || data[0] !== 0x05) {
            clearTimeout(timer)
            socket.destroy()
            resolve({
              ok: false,
              latencyMs: Date.now() - start,
              error: 'Invalid SOCKS5 connect response'
            })
            return
          }
          if (data[1] !== 0x00) {
            const errors: Record<number, string> = {
              0x01: 'general failure',
              0x02: 'connection not allowed',
              0x03: 'network unreachable',
              0x04: 'host unreachable',
              0x05: 'connection refused',
              0x06: 'TTL expired',
              0x07: 'command not supported',
              0x08: 'address type not supported'
            }
            clearTimeout(timer)
            socket.destroy()
            resolve({
              ok: false,
              latencyMs: Date.now() - start,
              error: `SOCKS5: ${errors[data[1]] || `error 0x${data[1].toString(16)}`}`
            })
            return
          }
          // Tunnel established — remove listeners, verify with TLS
          clearTimeout(timer)
          socket.removeAllListeners('data')
          const result = await verifyThroughTls(socket)
          resolve(result)
        }
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

/** Build a SOCKS5 connect request for a domain:port target. */
function buildSocks5ConnectRequest(host: string, port: number): Buffer {
  const hostBuf = Buffer.from(host, 'utf8')
  const buf = Buffer.alloc(7 + hostBuf.length)
  buf[0] = 0x05 // SOCKS version
  buf[1] = 0x01 // CONNECT
  buf[2] = 0x00 // reserved
  buf[3] = 0x03 // domain name
  buf[4] = hostBuf.length
  hostBuf.copy(buf, 5)
  buf.writeUInt16BE(port, 5 + hostBuf.length)
  return buf
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

  ipcMain.handle('session:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'session:create',
    async (
      _event,
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
        { notifyMainWindow: false }
      )
    }
  )

  ipcMain.handle('session:rekey', (_event, oldId: string, newId: string) => {
    manager.rekey(oldId, newId)
  })

  // Resolve the balanced JSONL line uuid to fork ("branch off") from, given an
  // assistant ChatMessage id. Used by the renderer before creating the branch.
  ipcMain.handle(
    'session:resolve-fork-anchor',
    async (_event, sessionId: string, cwd: string, messageId: string) => {
      return await resolveForkAnchor(sessionId, cwd, messageId)
    }
  )

  ipcMain.handle(
    'session:send',
    (
      _event,
      routingId: string,
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => sendPrompt(manager, win, routingId, prompt, attachments)
  )

  ipcMain.handle('session:cancel', (_event, routingId: string) => {
    manager.cancel(routingId)
  })

  ipcMain.handle('session:interrupt', async (_event, routingId: string) => {
    await manager.interrupt(routingId)
  })

  ipcMain.handle(
    'session:approval-response',
    (
      _event,
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

  ipcMain.handle('session:watch-background', (_e, routingId: string, toolUseId: string) =>
    watchBackground(manager, routingId, toolUseId)
  )

  ipcMain.handle('session:unwatch-background', (_e, routingId: string, toolUseId: string) =>
    unwatchBackground(manager, routingId, toolUseId)
  )

  ipcMain.handle(
    'session:read-background-range',
    (_e, routingId: string, toolUseId: string, offset: number, length: number) =>
      readBackgroundRange(manager, routingId, toolUseId, offset, length)
  )

  ipcMain.handle(
    'session:stop-task',
    async (_e, routingId: string, toolUseId: string, isDispatch?: boolean) => {
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
  )

  ipcMain.handle('session:background-task', async (_e, routingId: string, toolUseId: string) =>
    backgroundTask(manager, routingId, toolUseId)
  )

  ipcMain.handle('session:dequeue-message', async (_e, routingId: string, value: string) =>
    dequeueMessage(manager, routingId, value)
  )

  ipcMain.handle('session:ask-side-question', async (_e, routingId: string, question: string) =>
    askSideQuestion(manager, routingId, question)
  )

  ipcMain.handle('session:set-permission-mode', async (_e, routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  // Voice input handlers (Claude-only: capabilities.voice)
  ipcMain.handle(
    'voice:start-server',
    safeHandler(async (_e: unknown, routingId: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) throw new Error('Provider does not support voice')
      await session.voiceStartServer?.()
    })
  )

  ipcMain.handle(
    'voice:stop-server',
    safeHandler(async (_e: unknown, routingId: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) return
      await session.voiceStopServer?.()
    })
  )

  ipcMain.handle(
    'voice:start-recording',
    safeHandler(async (_e: unknown, routingId: string, language: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.voice) throw new Error('Provider does not support voice')
      await session.voiceStartRecording?.(language)
    })
  )

  ipcMain.handle(
    'voice:stop-recording',
    safeHandler(async (_e: unknown, routingId: string) => {
      const session = manager.get(routingId)
      if (!session || !session.capabilities.voice) return
      await session.voiceStopRecording?.()
    })
  )

  // Proxy test connection
  ipcMain.handle(
    'proxy:test-connection',
    safeHandler(async (_e: unknown, proxy: ProxySettings) => {
      return await testProxyConnection(proxy)
    })
  )

  ipcMain.handle('session:set-model', async (_e, routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  ipcMain.handle('session:set-effort', (_e, routingId: string, effort: string) =>
    setEffort(manager, routingId, effort)
  )

  ipcMain.handle('session:set-reasoning-variant', (_e, routingId: string, variant: string | null) => {
    manager.get(routingId)?.setReasoningVariant?.(variant)
  })

  ipcMain.handle('session:set-thinking-mode', (_e, routingId: string, mode: string) =>
    setThinkingMode(manager, routingId, mode)
  )

  ipcMain.handle('session:get-models', async () => {
    return await fetchModels()
  })

  ipcMain.handle('session:get-engine-models', async (): Promise<EngineModelGroup[]> => {
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
    return [claudeGroup, ...opencodeGroups]
  })

  // Full opencode provider catalog for the settings provider manager. Returns []
  // when opencode isn't installed or discovery fails (opencode is optional).
  ipcMain.handle('session:get-opencode-providers', async () => {
    if (!opencodeServerManager.isBinaryAvailable()) return []
    return await discoverOpencodeProviderCatalog()
  })

  // All catalog models for one provider (drives the model-allowlist dialog).
  ipcMain.handle(
    'session:get-opencode-provider-models',
    async (_e, providerId: string) => {
      if (!opencodeServerManager.isBinaryAvailable()) return []
      return await getOpencodeProviderModels(providerId)
    }
  )

  ipcMain.handle('session:generate-title', async (_e, conversationText: string) => {
    return await generateTitle(conversationText)
  })

  ipcMain.handle('session:generate-commit-message', async (_e, diff: string) => {
    return await generateCommitMessage(diff)
  })

  ipcMain.handle(
    'session:write-custom-title',
    async (_e, sessionId: string, projectKey: string, title: string) => {
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

  ipcMain.handle(
    'session:delete-session',
    safeHandler(async (_e: unknown, sessionId: string, projectKey: string, engineId?: EngineId) => {
      await deleteSessionByEngine(sessionId, projectKey, engineId)
    })
  )

  ipcMain.handle(
    'session:delete-project',
    safeHandler(async (_e: unknown, projectKey: string) => {
      await deleteProjectFiles(projectKey)
    })
  )

  ipcMain.handle('session:get-plan-content', (_e, routingId: string) =>
    getPlanContent(manager, routingId)
  )

  ipcMain.handle('session:get-session-log-path', (_e, routingId: string) =>
    getSessionLogPath(manager, routingId)
  )

  ipcMain.handle('session:list-directories', async () => {
    return await listDirectories()
  })

  ipcMain.handle('session:list-opencode', async () => {
    return await listOpencodeSessionsGlobal()
  })

  ipcMain.handle('session:load-opencode-history', async (_e, sessionId: string) => {
    return await loadOpencodeSessionHistory(sessionId)
  })

  ipcMain.handle('file:list-dir', async (_e, dirPath: string) => listDirEntries(dirPath))

  ipcMain.handle('session:load-history', async (_e, sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  ipcMain.handle(
    'session:load-subagent-history',
    async (_e, sessionId: string, projectKey: string, agentId: string) => {
      return await loadSubagentHistory(sessionId, projectKey, agentId)
    }
  )

  ipcMain.handle(
    'session:build-subagent-file-map',
    (_e, sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
      return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
    }
  )

  ipcMain.handle(
    'session:load-background-output',
    (_e, projectKey: string, taskId: string, outputFile?: string) => {
      return loadBackgroundOutput(projectKey, taskId, outputFile)
    }
  )

  ipcMain.handle(
    'session:watch-session',
    (_e, routingId: string, sessionId: string, projectKey: string) => {
      watchSession(routingId, sessionId, projectKey, win)
    }
  )

  ipcMain.handle('session:unwatch-session', (_e, routingId: string) => {
    unwatchSession(routingId)
  })

  // UI config persistence (~/.claude/ui/)
  ipcMain.handle('config:load-settings', () => loadSettings())
  ipcMain.handle('config:save-settings', (_e, incomingSettings: UISettings) =>
    saveUiSettings(manager, win, incomingSettings, { notifyMainWindow: false })
  )
  ipcMain.handle('config:load-sessions', () => loadSessionConfig())
  ipcMain.handle('config:save-sessions', (_e, config: UISessionConfig) =>
    saveSessions(win, config, { notifyMainWindow: false })
  )
  ipcMain.handle('config:load-slash-commands', () => loadSlashCommands())
  ipcMain.handle('config:save-slash-commands', (_e, commands: SlashCommandCache[]) =>
    saveSlashCommands(commands)
  )
  ipcMain.handle('config:scan-custom-commands', (_e, cwd: string) => scanCustomCommands(cwd))
  ipcMain.handle('config:load-skill-details', (_e, cwd: string) => loadSkillDetails(manager, cwd))
  ipcMain.handle('config:load-engine-config', (_e, engineId: string) =>
    loadEngineConfig(engineId)
  )
  ipcMain.handle('config:save-engine-config', (_e, engineId: string, cfg: EngineConfig) => {
    saveEngineConfig(engineId, cfg)
    // Provider enable/disable + custom-provider edits change which models the
    // discovery server returns. Drop the cache so the next getEngineModels()
    // re-discovers (otherwise a disabled/re-enabled provider only reflects after
    // an app restart).
    if (engineId === 'opencode') invalidateOpencodeModelCache()
  })
  // Cheap, deterministic engine availability check. Backs the renderer's
  // "is opencode installed?" gate WITHOUT spawning a server — a transient
  // spawn/HTTP failure can no longer masquerade as "not installed". Claude is
  // always installed (it's the bundled default engine).
  ipcMain.handle('engine:is-installed', (_e, engineId: EngineId): boolean =>
    engineId === 'opencode' ? opencodeServerManager.isBinaryAvailable() : true
  )
  ipcMain.handle('config:load-vendor-config', (_e, vendorId: string) =>
    loadVendorConfig(vendorId)
  )
  ipcMain.handle('config:save-vendor-config', (_e, vendorId: string, cfg: VendorConfig) =>
    saveVendorConfig(vendorId, cfg)
  )

  // opencode engine-native settings — read/write opencode's OWN config file.
  // The load handler triggers the one-time migration from the private store when
  // the opencode binary is available. modelAllowlist stays ClaudeUI-private.
  ipcMain.handle(
    'config:load-opencode-settings',
    safeHandler(async () => {
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
  )
  ipcMain.handle(
    'config:save-opencode-settings',
    safeHandler(async (_e: unknown, settings: OpencodeConfigSettings) => {
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
  )

  // Raw (non-lossy) opencode config access for the schema-driven settings editor.
  // Reads opencode's own config file verbatim; patches literal opencode field
  // names as jsonc leaf edits (comment-safe). Unlike save-opencode-settings this
  // never projects — it writes exactly the paths the UI names.
  ipcMain.handle(
    'config:read-opencode-native-raw',
    safeHandler(async () => readOpencodeNativeRaw())
  )
  ipcMain.handle(
    'config:patch-opencode-native',
    safeHandler(async (_e: unknown, patches: RawConfigPatch[]) => {
      patchOpencodeNativeRaw(patches)
      // Capability edits (attachment/modalities/…) change model discovery.
      invalidateOpencodeModelCache()
    })
  )

  // opencode agent CRUD — list/read/save/delete/disable custom + built-in agents
  ipcMain.handle(
    'opencode-agents:list',
    safeHandler(async (_e: unknown, cwd?: string) => listAgents(cwd))
  )
  ipcMain.handle(
    'opencode-agents:read',
    safeHandler(async (_e: unknown, name: string, scope: string, cwd?: string) =>
      readAgent(name, scope as 'global' | 'project', cwd)
    )
  )
  ipcMain.handle(
    'opencode-agents:save',
    safeHandler(async (_e: unknown, input: OpencodeAgentInput, cwd?: string) =>
      saveAgent(input, cwd)
    )
  )
  ipcMain.handle(
    'opencode-agents:delete',
    safeHandler(async (_e: unknown, name: string, scope: string, cwd?: string) =>
      deleteAgent(name, scope as 'global' | 'project', cwd)
    )
  )
  ipcMain.handle(
    'opencode-agents:set-disabled',
    safeHandler(
      async (_e: unknown, name: string, scope: string, cwd: string | undefined, disabled: boolean) =>
        setAgentDisabled(name, scope as 'global' | 'project', cwd, disabled)
    )
  )
  ipcMain.handle(
    'opencode-agents:generate',
    safeHandler(async (_e: unknown, description: string, cwd?: string) =>
      generateAgent(description, cwd)
    )
  )

  // Claude permission settings (allow/deny/ask rules)
  ipcMain.handle('claude:load-permissions', (_e, scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd)
  )
  ipcMain.handle(
    'claude:save-permissions',
    async (_e, scope: string, permissions: unknown, cwd?: string) => {
      saveClaudePermissions(scope as 'user' | 'project' | 'local', permissions as never, cwd)

      // Hot-reload: tell running CLI sessions to re-read settings from disk.
      // The CLI's file watcher is disabled in SDK mode, so writing to disk
      // alone doesn't propagate.  notifySettingsChanged() sends an empty
      // apply_flag_settings({}) which triggers the CLI's settings-change
      // subscriber to invalidate its cache and re-read all sources from disk,
      // respecting managed policies and the normal priority hierarchy.
      manager.forEach((session) => {
        if (!cwd || session.cwd === cwd || scope === 'user') {
          session.notifySettingsChanged?.().catch(() => {})
        }
      })
    }
  )

  // Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
  ipcMain.handle('claude:get-cleanup-period', () => loadCleanupPeriodDays())
  ipcMain.handle('claude:set-cleanup-period', async (_e, days: number) =>
    setCleanupPeriod(manager, days)
  )

  // MCP server management (Claude-only: capabilities.hostedMcp AND method presence —
  // opencode advertises hostedMcp:true but does not implement the MCP methods)
  ipcMain.handle('mcp:status', async (_e, routingId: string) => mcpStatus(manager, routingId))

  ipcMain.handle(
    'mcp:toggle',
    safeHandler(async (_e: unknown, routingId: string, serverName: string, enabled: boolean) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpToggleServer)
        throw new Error('Provider does not support hosted MCP')
      await session.mcpToggleServer(serverName, enabled)
    })
  )

  ipcMain.handle(
    'mcp:reconnect',
    safeHandler(async (_e: unknown, routingId: string, serverName: string) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpReconnectServer)
        throw new Error('Provider does not support hosted MCP')
      await session.mcpReconnectServer(serverName)
    })
  )

  ipcMain.handle(
    'mcp:set-servers',
    safeHandler(async (_e: unknown, routingId: string, servers: Record<string, unknown>) => {
      const session = manager.get(routingId)
      if (!session) throw new Error('No active session')
      if (!session.capabilities.hostedMcp || !session.mcpSetServers)
        throw new Error('Provider does not support hosted MCP')
      return await session.mcpSetServers(servers)
    })
  )

  // MCP config file read/write (direct file access, no session needed)
  ipcMain.handle('mcp:load-servers', (_e, scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd)
  )
  ipcMain.handle(
    'mcp:save-servers',
    (_e, scope: string, servers: Record<string, unknown>, cwd?: string) =>
      saveMcpServers(scope as 'user' | 'project' | 'local', servers as never, cwd)
  )
  ipcMain.handle('mcp:remove-server', (_e, scope: string, serverName: string, cwd?: string) =>
    removeMcpServer(scope as 'user' | 'project' | 'local', serverName, cwd)
  )

  // MCP disabled state (direct ~/.claude.json access, no session needed)
  ipcMain.handle('mcp:read-disabled', (_e, cwd: string) => {
    return readDisabledMcpServers(cwd)
  })

  ipcMain.handle(
    'mcp:toggle-disabled',
    async (_e, cwd: string, serverName: string, enabled: boolean) => {
      const disabled = readDisabledMcpServers(cwd)
      let updated: string[]
      if (enabled) {
        updated = disabled.filter((n) => n !== serverName)
      } else {
        updated = disabled.includes(serverName) ? disabled : [...disabled, serverName]
      }
      writeDisabledMcpServers(cwd, updated)
    }
  )

  // -------------------------------------------------------------------------
  // Git integration IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'git:check-repo',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.isGitRepo()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:status',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getStatus()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:branches',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getBranches()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:checkout',
    safeHandler(async (_e: unknown, cwd: string, branch: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.checkout(branch)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:create-branch',
    safeHandler(async (_e: unknown, cwd: string, name: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.createBranch(name)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:file-patch',
    safeHandler(
      async (
        _e: unknown,
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
  )

  ipcMain.handle(
    'git:file-contents',
    safeHandler(async (_e: unknown, cwd: string, filePath: string, staged: boolean) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.getFileContents(filePath, staged)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:stage-file',
    safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.stageFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:unstage-file',
    safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.unstageFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:discard-file',
    safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.discardFile(filePath)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:stage-all',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.stageAll()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:unstage-all',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.unstageAll()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:commit',
    safeHandler(async (_e: unknown, cwd: string, message: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.commit(message)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:push',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.push()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:push-with-upstream',
    safeHandler(async (_e: unknown, cwd: string, branch: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.pushWithUpstream(branch)
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:pull',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        return await svc.pull()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  ipcMain.handle(
    'git:fetch',
    safeHandler(async (_e: unknown, cwd: string) => {
      const svc = gitServiceManager.get(cwd)
      try {
        await svc.fetch()
      } finally {
        gitServiceManager.release(cwd)
      }
    })
  )

  // Git polling — persistent service per cwd
  const gitWatchers = new Map<string, { refCount: number }>()

  ipcMain.handle('git:start-watching', async (_e, cwd: string) => {
    const existing = gitWatchers.get(cwd)
    if (existing) {
      existing.refCount++
      return
    }
    gitWatchers.set(cwd, { refCount: 1 })
    const svc = gitServiceManager.get(cwd)
    svc.startPolling((status) => {
      if (!win.isDestroyed()) {
        win.webContents.send('git:status-update', { cwd, status })
      }
      for (const w of BaseSession.getExtraWindows()) {
        if (!w.isDestroyed()) w.webContents.send('git:status-update', { cwd, status })
      }
    }, 5000)
  })

  ipcMain.handle('git:stop-watching', async (_e, cwd: string) => {
    const entry = gitWatchers.get(cwd)
    if (!entry) return
    entry.refCount--
    if (entry.refCount <= 0) {
      gitWatchers.delete(cwd)
      const svc = gitServiceManager.getIfExists(cwd)
      svc?.stopPolling()
      gitServiceManager.release(cwd)
    }
  })

  // -------------------------------------------------------------------------
  // Worktree IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'worktree:create',
    safeHandler(async (_e: unknown, cwd: string, name: string) => {
      return await createWorktree(cwd, name)
    })
  )

  ipcMain.handle(
    'worktree:status',
    safeHandler(async (_e: unknown, worktreePath: string, originalHead: string) => {
      return await getWorktreeStatus(worktreePath, originalHead)
    })
  )

  ipcMain.handle(
    'worktree:remove',
    safeHandler(async (_e: unknown, worktreePath: string, branch: string, gitRoot: string) => {
      await removeWorktree(worktreePath, branch, gitRoot)
    })
  )

  ipcMain.handle(
    'worktree:list',
    safeHandler(async (_e: unknown, cwd: string) => {
      return await listWorktrees(cwd)
    })
  )

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher(win)

  // Watch ~/.claude/ui/ config files for cross-instance sync
  startConfigWatcher(win, () => BaseSession.getExtraWindows())

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
  usageFetcher.setWindow(win)
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
  blockUsageService.setWindow(win)
  if (!skipUsageInDev) {
    // Phase 7 Pass 2 (Full SQL): run the backfill reconciler FIRST so usage_event
    // holds out-of-tool Claude + opencode usage before the first dashboard
    // emission (no flash of missing per-engine/opencode data). recalculate() is
    // itself self-sufficient for the Claude dashboard — it seeds daily_usage from
    // the legacy JSON files, self-upserts its freshly-parsed JSONL into
    // usage_event, then reads SQL-sourced blocks + daily — so even if reconcile
    // is slow/fails, the Claude blocks + history are never empty.
    usageReconciler
      .reconcileAll()
      .catch(() => {})
      .finally(() => {
        blockUsageService.recalculate().catch((err) => {
          logger.error('BlockUsage', 'Initial recalculation failed', err)
        })
      })
    usageReconciler.start()
    blockUsageService.startWatching()
  } else {
    logger.info(
      'IPC',
      'Dev mode — skipping block usage writes (set CLAUDE_UI_DEV_USAGE=1 to enable)'
    )
  }

  // IPC handlers — always registered so the renderer never gets "no handler" errors.
  ipcMain.handle('usage:fetch', async () => {
    return usageFetcher.fetch()
  })

  ipcMain.handle('usage:fetch-block', async () => {
    return blockUsageService.getData() ?? (await blockUsageService.recalculate())
  })

  ipcMain.handle('usage:set-account-filter', async (_e, account: string | null) => {
    blockUsageService.setAccountFilter(account)
  })

  // Phase 9b: fetch opencode pricing from /config/providers, persist + register.
  // Desktop-only — spawns a local opencode server; blocked from remote dispatch.
  ipcMain.handle(
    'usage:refresh-prices',
    safeHandler(async () => refreshPrices())
  )

  // Native Anthropic OAuth (ADR-014) — routed through EngineAuthProvider.
  // Channels and payloads are unchanged; the registry defaults to 'claude'.
  const claudeAuth = engineAuthRegistry.require('claude')
  ipcMain.handle('auth:sign-in', async () => claudeAuth.signIn?.())
  ipcMain.handle('auth:submit-code', async (_e, code: string) => claudeAuth.submitCode?.(code))
  ipcMain.handle('auth:cancel', async () => claudeAuth.cancelSignIn?.())

  // Multiple-account support (ADR-015) — routed through EngineAuthProvider for
  // add/switch/delete; setEnabled stays direct on AccountManager (not on the interface).
  ipcMain.handle('account:get', async () => accountManager.getState())
  ipcMain.handle('account:set-enabled', async (_e, enabled: boolean) =>
    accountManager.setEnabled(enabled)
  )
  ipcMain.handle('account:add', async () => claudeAuth.addAccount?.())
  ipcMain.handle('account:switch', async (_e, id: string) => claudeAuth.switchAccount?.(id))
  ipcMain.handle('account:delete', async (_e, id: string) => claudeAuth.deleteAccount?.(id))

  // -------------------------------------------------------------------------
  // Engine-routed per-vendor auth channels (opencode multi-vendor auth, Phase 5c)
  // Each handler dispatches to engineAuthRegistry.require(engineId) and guards
  // the optional per-vendor method — throws a clear error if the provider lacks it.
  // Claude auth is unchanged: auth:* / account:* above stay byte-identical.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'vendor-auth:probe',
    safeHandler(async (_e: unknown, engineId: EngineId): Promise<VendorAuthMap> => {
      const provider = engineAuthRegistry.require(engineId)
      return provider.probe()
    })
  )

  ipcMain.handle(
    'vendor-auth:list-options',
    safeHandler(
      async (_e: unknown, engineId: EngineId): Promise<Record<string, VendorAuthOption[]>> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.listVendorAuthOptions) {
          throw new Error(`Engine "${engineId}" does not support listVendorAuthOptions`)
        }
        return provider.listVendorAuthOptions()
      }
    )
  )

  ipcMain.handle(
    'vendor-auth:list-keys',
    safeHandler(
      async (_e: unknown, engineId: EngineId): Promise<Record<string, 'api' | 'oauth'>> => {
        const provider = engineAuthRegistry.require(engineId)
        if (!provider.listVendorCredentialIds) {
          throw new Error(`Engine "${engineId}" does not support listVendorCredentialIds`)
        }
        return provider.listVendorCredentialIds()
      }
    )
  )

  ipcMain.handle(
    'vendor-auth:set-key',
    safeHandler(async (_e: unknown, engineId: EngineId, vendorId: string, key: string): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      if (!provider.setVendorApiKey) {
        throw new Error(`Engine "${engineId}" does not support setVendorApiKey`)
      }
      return provider.setVendorApiKey(vendorId, key)
    })
  )

  ipcMain.handle(
    'vendor-auth:oauth-authorize',
    safeHandler(
      async (
        _e: unknown,
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
  )

  ipcMain.handle(
    'vendor-auth:oauth-callback',
    safeHandler(
      async (
        _e: unknown,
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
  )

  ipcMain.handle(
    'vendor-auth:remove',
    safeHandler(async (_e: unknown, engineId: EngineId, vendorId: string): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      if (!provider.removeVendorAuth) {
        throw new Error(`Engine "${engineId}" does not support removeVendorAuth`)
      }
      return provider.removeVendorAuth(vendorId)
    })
  )

  ipcMain.handle(
    'vendor-auth:oauth-cancel',
    safeHandler(async (_e: unknown, engineId: EngineId): Promise<void> => {
      const provider = engineAuthRegistry.require(engineId)
      // No-op if the engine doesn't drive OAuth flows.
      await provider.cancelVendorOauth?.()
    })
  )

  // Mockup preview — read HTML from mockup directory
  ipcMain.handle(
    'mockup:read-html',
    safeHandler(async (_e: unknown, cwd: string, directory: string) => {
      const htmlPath = path.join(cwd, '.claude', 'ui', 'mockups', directory, 'index.html')
      return fs.promises.readFile(htmlPath, 'utf-8')
    })
  )

  // Mockup file watcher — watches a mockup directory for changes
  const mockupWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }
  >()

  ipcMain.handle('mockup:watch', (_e: unknown, cwd: string, directory: string) => {
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
        if (!win.isDestroyed()) {
          win.webContents.send('mockup:file-changed', directory)
        }
      }, 200)
    })

    mockupWatchers.set(key, entry)
  })

  ipcMain.handle('mockup:unwatch', (_e: unknown, cwd: string, directory: string) => {
    const key = `${cwd}:${directory}`
    const entry = mockupWatchers.get(key)
    if (entry) {
      entry.watcher.close()
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      mockupWatchers.delete(key)
    }
  })

  return manager
}

function startProjectsWatcher(win: BrowserWindow): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:directories-changed')
      }
      for (const w of BaseSession.getExtraWindows()) {
        if (!w.isDestroyed()) w.webContents.send('session:directories-changed')
      }
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
