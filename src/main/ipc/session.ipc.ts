import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '../sdk'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { SessionManager } from '../services/session-manager'
import { getSdkExecutableOpts, ClaudeSession } from '../services/claude-session'
import { listDirectories, loadSessionHistory, loadSubagentHistory, buildSubagentFileMap, loadBackgroundOutput } from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { loadSettings, saveSettings, loadSessionConfig, saveSessionConfig, loadSlashCommands, saveSlashCommands, startConfigWatcher } from '../services/ui-config'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import { loadMcpServers, saveMcpServers, removeMcpServer, readDisabledMcpServers, writeDisabledMcpServers } from '../services/claude-mcp'
import { scanSkills } from '../services/skill-scanner'
import { scanCustomCommands } from '../services/custom-command-scanner'
import type { UISettings, UISessionConfig, SlashCommandCache } from '../services/ui-config'
import { gitServiceManager } from '../services/git-service'
import { createWorktree, getWorktreeStatus, removeWorktree, listWorktrees } from '../services/worktree'
import { usageFetcher } from '../services/usage-fetcher'
import { serviceSession } from '../services/service-session'
import { blockUsageService } from '../services/block-usage'
import type { ApprovalDecision, ModelInfo, SandboxSettings, ProxySettings, PermissionSuggestion, IpcResult } from '../../shared/types'
import { logger } from '../services/logger'
import { deleteSessionFiles, deleteProjectFiles } from '../services/delete-session-files'
import { startSocksBridge, stopSocksBridge } from '../services/socks-bridge'

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

let cachedModels: ModelInfo[] | null = null

const CONTEXT_WINDOW_1M = 1_000_000
const CONTEXT_WINDOW_DEFAULT = 200_000

/**
 * Returns the context window size for a given model value.
 * Checks the cached model list — if the model's description contains "1m" (case-insensitive),
 * it's a 1M-context model. Falls back to 200K.
 */
export function getContextWindowSize(modelValue: string): number {
  if (!cachedModels) return CONTEXT_WINDOW_DEFAULT
  const info = cachedModels.find((m) => m.value === modelValue)
  if (info && /1m/i.test(info.description)) return CONTEXT_WINDOW_1M
  return CONTEXT_WINDOW_DEFAULT
}

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
      generateSessionTitle(desc: string, opts?: { persist?: boolean }): Promise<{ title?: string | null } | unknown>
    }
    const result = await handle.generateSessionTitle(conversationText, { persist: false })
    const title = result && typeof result === 'object' && 'title' in result
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
        const betaMessage = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined
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
  if (cachedModels) return cachedModels

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
    const models = await (q as unknown as { supportedModels(): Promise<ModelInfo[]> }).supportedModels()
    cachedModels = models
    return models
  } finally {
    abort.abort()
  }
}

const SESSION_IPC_CHANNELS = [
  'session:pick-folder', 'session:create', 'session:rekey', 'session:send',
  'session:cancel', 'session:interrupt', 'session:approval-response', 'session:watch-background',
  'session:unwatch-background', 'session:read-background-range', 'session:stop-task',
  'session:background-task', 'session:dequeue-message',
  'session:set-permission-mode', 'session:set-model', 'session:set-effort',
  'session:get-models', 'session:generate-title', 'session:generate-commit-message',
  'session:write-custom-title', 'session:get-plan-content', 'session:get-session-log-path',
  'session:delete-session', 'session:delete-project',
  'session:list-directories', 'session:load-history', 'session:load-subagent-history',
  'session:build-subagent-file-map', 'session:load-background-output',
  'session:watch-session', 'session:unwatch-session',
  'config:load-settings', 'config:save-settings', 'config:load-sessions',
  'config:save-sessions', 'config:load-slash-commands', 'config:save-slash-commands',
  'config:scan-custom-commands', 'config:load-skill-details',
  'session:send-to-teammate', 'session:broadcast-to-team', 'session:get-team-info',
  'session:open-teams-view',
  'git:check-repo', 'git:status', 'git:branches', 'git:checkout', 'git:create-branch',
  'git:file-patch', 'git:file-contents', 'git:stage-file', 'git:unstage-file', 'git:discard-file',
  'git:stage-all', 'git:unstage-all', 'git:commit', 'git:push', 'git:push-with-upstream', 'git:pull', 'git:fetch',
  'git:start-watching', 'git:stop-watching',
  'file:list-dir',
  'usage:fetch', 'usage:fetch-block',
  'claude:load-permissions', 'claude:save-permissions',
  'mcp:status', 'mcp:toggle', 'mcp:reconnect', 'mcp:set-servers',
  'mcp:load-servers', 'mcp:save-servers', 'mcp:remove-server',
  'mcp:read-disabled', 'mcp:toggle-disabled',
  'worktree:create', 'worktree:status', 'worktree:remove', 'worktree:list',
  'app:quit-confirm',
  'session:sandbox-violation',
  'voice:start-server', 'voice:stop-server', 'voice:start-recording', 'voice:stop-recording',
  'proxy:test-connection'
]

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

/** Build a proxy URL from proxy settings. */
function buildProxyUrl(proxy: ProxySettings): string {
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : ''
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
  return `${scheme}://${auth}${proxy.hostname}:${proxy.port}`
}

/**
 * Apply or clear proxy environment variables based on settings.
 *
 * - HTTP proxy: sets HTTP_PROXY directly (CLI's bundled https-proxy-agent handles it)
 * - SOCKS5 proxy: starts a local HTTP CONNECT bridge that tunnels through SOCKS5,
 *   because the CLI has no native SOCKS5 support
 */
export async function applyProxyEnv(proxy: ProxySettings | undefined): Promise<void> {
  if (proxy?.enabled && proxy.hostname) {
    if (proxy.type === 'socks5') {
      // Start local HTTP bridge → SOCKS5
      try {
        const port = await startSocksBridge({
          socksHost: proxy.hostname,
          socksPort: proxy.port,
          username: proxy.username || undefined,
          password: proxy.password || undefined
        })
        const bridgeUrl = `http://127.0.0.1:${port}`
        process.env.HTTP_PROXY = bridgeUrl
        process.env.HTTPS_PROXY = bridgeUrl
        process.env.ALL_PROXY = bridgeUrl
        logger.info('Proxy', `SOCKS5 proxy via bridge: socks5://${proxy.hostname}:${proxy.port} → ${bridgeUrl}`)
      } catch (err) {
        logger.error('Proxy', `Failed to start SOCKS5 bridge: ${err instanceof Error ? err.message : err}`)
        // Clear env vars so we don't leave stale config
        delete process.env.HTTP_PROXY
        delete process.env.HTTPS_PROXY
        delete process.env.ALL_PROXY
      }
    } else {
      // HTTP proxy: direct
      await stopSocksBridge()
      const url = buildProxyUrl(proxy)
      process.env.HTTP_PROXY = url
      process.env.HTTPS_PROXY = url
      process.env.ALL_PROXY = url
      logger.info('Proxy', `HTTP proxy enabled: ${proxy.hostname}:${proxy.port}`)
    }
  } else {
    await stopSocksBridge()
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.ALL_PROXY
  }
}

/**
 * Test proxy connectivity by making a real HTTPS request through the proxy
 * to api.anthropic.com. A 401 (Unauthorized) proves the proxy works — we're
 * testing the tunnel, not the API key.
 */
async function testProxyConnection(proxy: ProxySettings): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const http = await import('node:http')
  const tls = await import('node:tls')
  const net = await import('node:net')

  const start = Date.now()
  const TARGET_HOST = 'api.anthropic.com'
  const TARGET_PORT = 443
  const TIMEOUT_MS = 10_000

  /** Upgrade a raw socket to TLS, send a GET, and check the HTTP status. */
  function verifyThroughTls(rawSocket: import('node:net').Socket): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
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
          resolve({ ok: false, latencyMs: Date.now() - start, error: 'Unexpected response from server' })
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
        const methods = proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
        socket.write(methods)
      })

      let phase: 'greeting' | 'auth' | 'connect' = 'greeting'

      socket.on('data', async (data: Buffer) => {
        if (phase === 'greeting') {
          if (data.length < 2 || data[0] !== 0x05) {
            clearTimeout(timer)
            socket.destroy()
            resolve({ ok: false, latencyMs: Date.now() - start, error: 'Invalid SOCKS5 greeting response' })
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
            resolve({ ok: false, latencyMs: Date.now() - start, error: 'SOCKS5 proxy rejected authentication methods' })
          }
        } else if (phase === 'auth') {
          if (data.length < 2 || data[1] !== 0x00) {
            clearTimeout(timer)
            socket.destroy()
            resolve({ ok: false, latencyMs: Date.now() - start, error: 'SOCKS5 authentication failed' })
            return
          }
          // Auth succeeded — send connect request
          phase = 'connect'
          socket.write(buildSocks5ConnectRequest(TARGET_HOST, TARGET_PORT))
        } else if (phase === 'connect') {
          if (data.length < 2 || data[0] !== 0x05) {
            clearTimeout(timer)
            socket.destroy()
            resolve({ ok: false, latencyMs: Date.now() - start, error: 'Invalid SOCKS5 connect response' })
            return
          }
          if (data[1] !== 0x00) {
            const errors: Record<number, string> = {
              0x01: 'general failure', 0x02: 'connection not allowed',
              0x03: 'network unreachable', 0x04: 'host unreachable',
              0x05: 'connection refused', 0x06: 'TTL expired',
              0x07: 'command not supported', 0x08: 'address type not supported'
            }
            clearTimeout(timer)
            socket.destroy()
            resolve({ ok: false, latencyMs: Date.now() - start, error: `SOCKS5: ${errors[data[1]] || `error 0x${data[1].toString(16)}`}` })
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
      ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') }
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
        resolve({ ok: false, latencyMs: Date.now() - start, error: `Proxy returned HTTP ${res.statusCode}` })
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
export function getSessionManager(): SessionManager | null { return sharedManager }

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
    async (_event, routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string, thinkingMode?: string) => {
      const settings = loadSettings() as Record<string, unknown>
      const sandboxConfig = (settings.sandbox as SandboxSettings) || undefined
      await applyProxyEnv((settings.proxy as ProxySettings) || undefined)
      manager.create(routingId, win, cwd, effort, resumeSessionId, permissionMode, model, sandboxConfig, thinkingMode)
      // Notify all extra windows (remote bridge) that a session was created
      for (const w of ClaudeSession.getExtraWindows()) {
        if (!w.isDestroyed()) w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
      }
    }
  )

  ipcMain.handle('session:rekey', (_event, oldId: string, newId: string) => {
    manager.rekey(oldId, newId)
  })

  ipcMain.handle('session:send', (_event, routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) => {
    const session = manager.get(routingId)
    if (!session) throw new Error(`No session for routingId: ${routingId}`)
    // Check before run() — if session already active, the message will be queued
    const queued = session.willQueue
    session.run(prompt, attachments)
    // Relay user message back to all renderers (local + remote) as the single source of truth.
    // Include queued flag so renderers show it as pending (not in chat) until consumed.
    const payload = { prompt, attachments, queued }
    if (!win.isDestroyed()) {
      win.webContents.send('session:user-message', routingId, payload)
    }
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('session:user-message', routingId, payload)
    }
  })

  ipcMain.handle('session:cancel', (_event, routingId: string) => {
    manager.cancel(routingId)
  })

  ipcMain.handle('session:interrupt', async (_event, routingId: string) => {
    await manager.interrupt(routingId)
  })

  ipcMain.handle(
    'session:approval-response',
    (_event, routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]) => {
      manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
    }
  )

  ipcMain.handle('session:watch-background', (_e, routingId: string, toolUseId: string) => {
    manager.get(routingId)?.watchBackground(toolUseId)
  })

  ipcMain.handle('session:unwatch-background', (_e, routingId: string, toolUseId: string) => {
    manager.get(routingId)?.unwatchBackground(toolUseId)
  })

  ipcMain.handle(
    'session:read-background-range',
    (_e, routingId: string, toolUseId: string, offset: number, length: number) => {
      return manager.get(routingId)?.readBackgroundRange(toolUseId, offset, length) ?? ''
    }
  )

  ipcMain.handle('session:stop-task', async (_e, routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) {
      return { success: false, error: 'No active session' }
    }
    return await session.stopTask(toolUseId)
  })

  ipcMain.handle('session:background-task', async (_e, routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) {
      return { success: false, error: 'No active session' }
    }
    return await session.backgroundTask(toolUseId)
  })

  ipcMain.handle('session:dequeue-message', async (_e, routingId: string, value: string) => {
    const session = manager.get(routingId)
    if (!session) return { removed: 0 }
    return await session.dequeueMessage(value)
  })

  ipcMain.handle('session:ask-side-question', async (_e, routingId: string, question: string) => {
    const session = manager.get(routingId)
    if (!session) return null
    return await session.askSideQuestion(question)
  })

  ipcMain.handle('session:set-permission-mode', async (_e, routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  // Voice input handlers
  ipcMain.handle('voice:start-server', safeHandler(async (_e: unknown, routingId: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.voiceStartServer()
  }))

  ipcMain.handle('voice:stop-server', safeHandler(async (_e: unknown, routingId: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.voiceStopServer()
  }))

  ipcMain.handle('voice:start-recording', safeHandler(async (_e: unknown, routingId: string, language: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.voiceStartRecording(language)
  }))

  ipcMain.handle('voice:stop-recording', safeHandler(async (_e: unknown, routingId: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.voiceStopRecording()
  }))

  // Proxy test connection
  ipcMain.handle('proxy:test-connection', safeHandler(async (_e: unknown, proxy: ProxySettings) => {
    return await testProxyConnection(proxy)
  }))

  ipcMain.handle('session:set-model', async (_e, routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  ipcMain.handle('session:set-effort', (_e, routingId: string, effort: string) => {
    manager.get(routingId)?.setEffort(effort)
  })

  ipcMain.handle('session:set-thinking-mode', (_e, routingId: string, mode: string) => {
    manager.get(routingId)?.setThinkingMode(mode)
  })

  ipcMain.handle('session:get-models', async () => {
    return await fetchModels()
  })

  ipcMain.handle('session:generate-title', async (_e, conversationText: string) => {
    return await generateTitle(conversationText)
  })

  ipcMain.handle('session:generate-commit-message', async (_e, diff: string) => {
    return await generateCommitMessage(diff)
  })

  ipcMain.handle('session:write-custom-title', async (_e, sessionId: string, projectKey: string, title: string) => {
    const filePath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`)
    const entry = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
    await fs.promises.appendFile(filePath, entry + '\n', { mode: 0o600 })
  })

  ipcMain.handle('session:delete-session', safeHandler(async (_e: unknown, sessionId: string, projectKey: string) => {
    await deleteSessionFiles(sessionId, projectKey)
  }))

  ipcMain.handle('session:delete-project', safeHandler(async (_e: unknown, projectKey: string) => {
    await deleteProjectFiles(projectKey)
  }))

  ipcMain.handle('session:get-plan-content', (_e, routingId: string) => {
    return manager.get(routingId)?.getPlanContent() ?? null
  })

  ipcMain.handle('session:get-session-log-path', (_e, routingId: string) => {
    return manager.get(routingId)?.getSessionLogPath() ?? null
  })

  ipcMain.handle('session:list-directories', async () => {
    return await listDirectories()
  })

  ipcMain.handle('file:list-dir', async (_e, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const HIDDEN_NAMES = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.next', '.cache'])
      const result: Array<{ name: string; isDirectory: boolean }> = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || HIDDEN_NAMES.has(entry.name)) continue
        result.push({ name: entry.name, isDirectory: entry.isDirectory() || entry.isSymbolicLink() })
      }
      // Sort: directories first, then alphabetical within each group
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      // Check if this directory is a filesystem root (parent resolves to itself)
      // Return resolved path in POSIX format so renderer can rewrite relative dirs
      const resolved = path.resolve(dirPath)
      const isRoot = path.dirname(resolved) === resolved
      const resolvedPosix = resolved.replace(/\\/g, '/').replace(/\/$/, '')
      return { entries: result, isRoot, resolvedPath: resolvedPosix }
    } catch {
      return { entries: [], isRoot: false, resolvedPath: '' }
    }
  })

  ipcMain.handle('session:load-history', async (_e, sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  ipcMain.handle('session:load-subagent-history', async (_e, sessionId: string, projectKey: string, agentId: string) => {
    return await loadSubagentHistory(sessionId, projectKey, agentId)
  })

  ipcMain.handle('session:build-subagent-file-map', (_e, sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
    return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
  })

  ipcMain.handle('session:load-background-output', (_e, projectKey: string, taskId: string, outputFile?: string) => {
    return loadBackgroundOutput(projectKey, taskId, outputFile)
  })

  ipcMain.handle('session:watch-session', (_e, routingId: string, sessionId: string, projectKey: string) => {
    watchSession(routingId, sessionId, projectKey, win)
  })

  ipcMain.handle('session:unwatch-session', (_e, routingId: string) => {
    unwatchSession(routingId)
  })

  // UI config persistence (~/.claude/ui/)
  ipcMain.handle('config:load-settings', () => loadSettings())
  ipcMain.handle('config:save-settings', (_e, settings: UISettings) => {
    saveSettings(settings)
    // Propagate usage refresh interval change
    if (typeof (settings as Record<string, unknown>).usageRefreshSecs === 'number') {
      usageFetcher.setIntervalSecs((settings as Record<string, unknown>).usageRefreshSecs as number)
    }
    // Propagate analytics refresh interval change
    if (typeof (settings as Record<string, unknown>).analyticsRefreshSecs === 'number') {
      blockUsageService.setDebounceSecs((settings as Record<string, unknown>).analyticsRefreshSecs as number)
    }
    // Apply log level + filter changes immediately
    {
      const raw = settings as Record<string, unknown>
      const level = typeof raw.logLevel === 'string' ? raw.logLevel : undefined
      const filter = typeof raw.logFilter === 'string' ? raw.logFilter : undefined
      if (level !== undefined || filter !== undefined) {
        logger.applyFilter(filter ?? '', level as 'debug' | 'info' | 'warn' | 'error' | undefined)
      }
    }
    // Apply proxy env var changes immediately (async — bridge start/stop)
    applyProxyEnv((settings as Record<string, unknown>).proxy as ProxySettings | undefined).catch(
      (err) => logger.error('Proxy', `Failed to apply proxy settings: ${err}`)
    )
    // Propagate session idle timeout change
    const timeoutMins = (settings as Record<string, unknown>).sessionTimeoutMins
    if (typeof timeoutMins === 'number') {
      manager.setSessionTimeout(timeoutMins * 60 * 1000)
    }
    // Notify remote clients of settings change
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('config:settings-changed', settings)
    }
  })
  ipcMain.handle('config:load-sessions', () => loadSessionConfig())
  ipcMain.handle('config:save-sessions', (_e, config: UISessionConfig) => {
    saveSessionConfig(config)
    // Notify remote clients of session config change
    for (const w of ClaudeSession.getExtraWindows()) {
      if (!w.isDestroyed()) w.webContents.send('config:sessions-changed', config)
    }
  })
  ipcMain.handle('config:load-slash-commands', () => loadSlashCommands())
  ipcMain.handle('config:save-slash-commands', (_e, commands: SlashCommandCache[]) => saveSlashCommands(commands))
  ipcMain.handle('config:scan-custom-commands', (_e, cwd: string) => scanCustomCommands(cwd))
  ipcMain.handle('config:load-skill-details', (_e, cwd: string) => scanSkills(cwd))

  // Claude permission settings (allow/deny/ask rules)
  ipcMain.handle('claude:load-permissions', (_e, scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd))
  ipcMain.handle('claude:save-permissions', async (_e, scope: string, permissions: unknown, cwd?: string) => {
    saveClaudePermissions(scope as 'user' | 'project' | 'local', permissions as never, cwd)

    // Hot-reload: tell running CLI sessions to re-read settings from disk.
    // The CLI's file watcher is disabled in SDK mode, so writing to disk
    // alone doesn't propagate.  notifySettingsChanged() sends an empty
    // apply_flag_settings({}) which triggers the CLI's settings-change
    // subscriber to invalidate its cache and re-read all sources from disk,
    // respecting managed policies and the normal priority hierarchy.
    manager.forEach((session) => {
      if (!cwd || session.cwd === cwd || scope === 'user') {
        session.notifySettingsChanged().catch(() => {})
      }
    })
  })

  // MCP server management (via SDK Query object)
  ipcMain.handle('mcp:status', async (_e, routingId: string) => {
    const session = manager.get(routingId)
    if (!session) return []
    return await session.mcpServerStatus()
  })

  ipcMain.handle('mcp:toggle', safeHandler(async (_e: unknown, routingId: string, serverName: string, enabled: boolean) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.mcpToggleServer(serverName, enabled)
  }))

  ipcMain.handle('mcp:reconnect', safeHandler(async (_e: unknown, routingId: string, serverName: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.mcpReconnectServer(serverName)
  }))

  ipcMain.handle('mcp:set-servers', safeHandler(async (_e: unknown, routingId: string, servers: Record<string, unknown>) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    return await session.mcpSetServers(servers)
  }))

  // MCP config file read/write (direct file access, no session needed)
  ipcMain.handle('mcp:load-servers', (_e, scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd))
  ipcMain.handle('mcp:save-servers', (_e, scope: string, servers: Record<string, unknown>, cwd?: string) =>
    saveMcpServers(scope as 'user' | 'project' | 'local', servers as never, cwd))
  ipcMain.handle('mcp:remove-server', (_e, scope: string, serverName: string, cwd?: string) =>
    removeMcpServer(scope as 'user' | 'project' | 'local', serverName, cwd))

  // MCP disabled state (direct ~/.claude.json access, no session needed)
  ipcMain.handle('mcp:read-disabled', (_e, cwd: string) => {
    return readDisabledMcpServers(cwd)
  })

  ipcMain.handle('mcp:toggle-disabled', async (_e, cwd: string, serverName: string, enabled: boolean) => {
    const disabled = readDisabledMcpServers(cwd)
    let updated: string[]
    if (enabled) {
      updated = disabled.filter(n => n !== serverName)
    } else {
      updated = disabled.includes(serverName) ? disabled : [...disabled, serverName]
    }
    writeDisabledMcpServers(cwd, updated)
  })

  // Teammate inbox handlers
  ipcMain.handle(
    'session:send-to-teammate',
    async (_e, _routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string) => {
      const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
      await fs.promises.mkdir(inboxDir, { recursive: true })
      const inboxPath = path.join(inboxDir, `${sanitizedAgentName}.json`)
      let items: unknown[] = []
      try {
        const raw = await fs.promises.readFile(inboxPath, 'utf-8')
        items = JSON.parse(raw)
      } catch (err) { logger.warn('IPC', `Failed to read teammate inbox: ${inboxPath}`, err) }
      items.push({ from: 'user', text: message, timestamp: new Date().toISOString(), read: false })
      await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
    }
  )

  ipcMain.handle(
    'session:broadcast-to-team',
    async (_e, _routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string) => {
      const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
      await fs.promises.mkdir(inboxDir, { recursive: true })
      const entry = { from: 'user', text: message, timestamp: new Date().toISOString(), read: false }
      for (const name of sanitizedAgentNames) {
        const inboxPath = path.join(inboxDir, `${name}.json`)
        let items: unknown[] = []
        try {
          const raw = await fs.promises.readFile(inboxPath, 'utf-8')
          items = JSON.parse(raw)
        } catch (err) { logger.warn('IPC', `Failed to read teammate inbox: ${inboxPath}`, err) }
        items.push(entry)
        await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
      }
    }
  )

  // Team info query (pull-based)
  ipcMain.handle('session:get-team-info', (_e, routingId: string) => {
    return manager.getTeamInfo(routingId)
  })

  // Teams-view window
  let teamsViewWindow: BrowserWindow | null = null
  ipcMain.handle('session:open-teams-view', (_e, _routingId: string) => {
    if (teamsViewWindow && !teamsViewWindow.isDestroyed()) {
      teamsViewWindow.focus()
      return
    }
    teamsViewWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      title: 'Agent Monitor',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    ClaudeSession.addExtraWindow(teamsViewWindow)
    teamsViewWindow.on('closed', () => {
      if (teamsViewWindow) ClaudeSession.removeExtraWindow(teamsViewWindow)
      teamsViewWindow = null
    })

    // Load with ?view=teams-view&routingId=<id> query params
    const { is } = require('@electron-toolkit/utils')
    const searchParams = `view=teams-view&routingId=${encodeURIComponent(_routingId)}`
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      teamsViewWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '?' + searchParams)
    } else {
      teamsViewWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { search: searchParams })
    }
  })

  // -------------------------------------------------------------------------
  // Git integration IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle('git:check-repo', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.isGitRepo()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:status', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getStatus()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:branches', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getBranches()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:checkout', safeHandler(async (_e: unknown, cwd: string, branch: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.checkout(branch)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:create-branch', safeHandler(async (_e: unknown, cwd: string, name: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.createBranch(name)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:file-patch', safeHandler(async (_e: unknown, cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getFilePatch(filePath, staged, ignoreWhitespace)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:file-contents', safeHandler(async (_e: unknown, cwd: string, filePath: string, staged: boolean) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getFileContents(filePath, staged)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:stage-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.stageFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:unstage-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.unstageFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:discard-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.discardFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:stage-all', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.stageAll()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:unstage-all', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.unstageAll()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:commit', safeHandler(async (_e: unknown, cwd: string, message: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.commit(message)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:push', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.push()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:push-with-upstream', safeHandler(async (_e: unknown, cwd: string, branch: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.pushWithUpstream(branch)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:pull', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.pull()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:fetch', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.fetch()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

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
      for (const w of ClaudeSession.getExtraWindows()) {
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

  ipcMain.handle('worktree:create', safeHandler(async (_e: unknown, cwd: string, name: string) => {
    return await createWorktree(cwd, name)
  }))

  ipcMain.handle('worktree:status', safeHandler(async (_e: unknown, worktreePath: string, originalHead: string) => {
    return await getWorktreeStatus(worktreePath, originalHead)
  }))

  ipcMain.handle('worktree:remove', safeHandler(async (_e: unknown, worktreePath: string, branch: string, gitRoot: string) => {
    await removeWorktree(worktreePath, branch, gitRoot)
  }))

  ipcMain.handle('worktree:list', safeHandler(async (_e: unknown, cwd: string) => {
    return await listWorktrees(cwd)
  }))

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher(win)

  // Watch ~/.claude/ui/ config files for cross-instance sync
  startConfigWatcher(win, () => ClaudeSession.getExtraWindows())

  const savedSettings = loadSettings() as Record<string, unknown>

  // Apply saved session idle timeout
  if (typeof savedSettings.sessionTimeoutMins === 'number') {
    manager.setSessionTimeout(savedSettings.sessionTimeoutMins * 60 * 1000)
  }
  // Apply saved log level + filter (merged with CLAUDE_UI_LOG env var)
  {
    const level = typeof savedSettings.logLevel === 'string' ? savedSettings.logLevel as 'debug' | 'info' | 'warn' | 'error' : undefined
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
    // Try active user sessions first (they're already running)
    const sessions: import('../services/claude-session').ClaudeSession[] = []
    manager.forEach((s) => sessions.push(s))
    for (const session of sessions) {
      try {
        const data = await session.getUsage()
        if (data !== null) return data
      } catch { /* try next session */ }
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
    blockUsageService.recalculate().catch((err) => { logger.error('BlockUsage', 'Initial recalculation failed', err) })
    blockUsageService.startWatching()
  } else {
    logger.info('IPC', 'Dev mode — skipping block usage writes (set CLAUDE_UI_DEV_USAGE=1 to enable)')
  }

  // IPC handlers — always registered so the renderer never gets "no handler" errors.
  ipcMain.handle('usage:fetch', async () => {
    return usageFetcher.fetch()
  })

  ipcMain.handle('usage:fetch-block', async () => {
    return blockUsageService.getData() ?? (await blockUsageService.recalculate())
  })

  // Mockup preview — read HTML from mockup directory
  ipcMain.handle('mockup:read-html', safeHandler(async (_e: unknown, cwd: string, directory: string) => {
    const htmlPath = path.join(cwd, '.claude', 'ui', 'mockups', directory, 'index.html')
    return fs.promises.readFile(htmlPath, 'utf-8')
  }))

  // Mockup file watcher — watches a mockup directory for changes
  const mockupWatchers = new Map<string, { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }>()

  ipcMain.handle('mockup:watch', (_e: unknown, cwd: string, directory: string) => {
    const key = `${cwd}:${directory}`
    if (mockupWatchers.has(key)) return // already watching

    const dirPath = path.join(cwd, '.claude', 'ui', 'mockups', directory)
    if (!fs.existsSync(dirPath)) return

    const entry = { watcher: null! as fs.FSWatcher, debounceTimer: null as ReturnType<typeof setTimeout> | null }

    entry.watcher = fs.watch(dirPath, { recursive: false }, (_event, filename) => {
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
      for (const w of ClaudeSession.getExtraWindows()) {
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
