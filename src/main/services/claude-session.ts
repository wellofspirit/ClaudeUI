import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { computeTokenMetrics, buildSubagentFileMap } from './session-history'
import { isAgentTool } from '../../shared/types'
import { unwatchAllSubagents } from './subagent-watcher'
import { saveSlashCommands } from './ui-config'
import { loadMcpServers, readDisabledMcpServers } from './claude-mcp'
import { logger } from './logger'
import { getContextWindowSize } from '../ipc/session.ipc'

/** In production, cli.js is unpacked from the asar — resolve its real path */
export function getCliJsPath(): string | undefined {
  const appPath = app.getAppPath()
  if (!appPath.includes('app.asar')) return undefined // dev mode
  const unpacked = appPath.replace('app.asar', 'app.asar.unpacked')
  return path.join(unpacked, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
}

/**
 * Resolve the Electron Helper binary for spawning child processes.
 *
 * On macOS, spawning `process.execPath` (the main Electron binary) causes a
 * dock icon flash. The Electron Helper binary has `LSUIElement=1` in its
 * Info.plist, so macOS treats it as a background process — no dock icon.
 *
 * Path: ClaudeUI.app/Contents/Frameworks/ClaudeUI Helper.app/Contents/MacOS/ClaudeUI Helper
 */
function getElectronHelperPath(): string {
  if (process.platform !== 'darwin') return process.execPath

  // process.execPath = .../ClaudeUI.app/Contents/MacOS/ClaudeUI
  const contentsDir = path.dirname(path.dirname(process.execPath))
  const appName = path.basename(process.execPath) // "ClaudeUI"
  const helperPath = path.join(
    contentsDir,
    'Frameworks',
    `${appName} Helper.app`,
    'Contents',
    'MacOS',
    `${appName} Helper`
  )

  // Fall back to main binary if helper doesn't exist (e.g., dev mode)
  if (!fs.existsSync(helperPath)) return process.execPath
  return helperPath
}

/**
 * SDK options for resolving the CLI executable in production.
 *
 * The SDK spawns `cli.js` via `spawn("node", [cliPath, ...])` by default,
 * but macOS GUI apps don't have a system `node` in PATH (especially on fresh
 * machines). We use Electron's own Node.js runtime with ELECTRON_RUN_AS_NODE=1
 * so the spawn is self-contained. On macOS we use the Helper binary to avoid
 * dock icon flashes.
 */
export function getSdkExecutableOpts(): Record<string, unknown> {
  const cliPath = getCliJsPath()
  if (!cliPath) return {} // dev mode — let SDK use default resolution
  return {
    pathToClaudeCodeExecutable: cliPath,
    executable: getElectronHelperPath(),
    executableArgs: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}
import type {
  ChatMessage,
  ContentBlock,
  McpServerConfig,
  SessionStatus,
  ApprovalDecision,
  PendingApproval,
  SandboxSettings,
  PermissionSuggestion
} from '../../shared/types'

interface ApprovalResult {
  decision: ApprovalDecision
  answers?: Record<string, string>
  updatedPermissions?: PermissionSuggestion[]
}

interface PendingApprovalEntry {
  resolve: (result: ApprovalResult) => void
}

/**
 * Push-based async iterable for feeding user messages into the SDK's
 * streaming input mode. This keeps the CLI subprocess alive so background
 * agents can report back via task_notification.
 */
class MessageChannel<T> {
  private queue: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private isDone = false

  push(msg: T): void {
    if (this.isDone) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.queue.push(msg)
    }
  }

  end(): void {
    this.isDone = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false }
    }
    if (this.isDone) {
      return { value: undefined as T, done: true }
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

const AGENT_ID_RE = /(?:agentId|agent_id):\s*(\S+)/
const TASK_ID_RE = /task_id:\s*(\S+)/
const BG_CMD_ID_RE = /Command running in background with ID:\s*([\w-]+)/
const OUTPUT_FILE_RE = /Output is being written to:\s*(.+)/

const TAIL_SIZE = 64 * 1024

interface BackgroundPoller {
  interval?: ReturnType<typeof setInterval>
  filePath: string
  lastSize: number
  done: boolean
}

export class ClaudeSession {
  private static extraWindows = new Set<BrowserWindow>()
  static addExtraWindow(win: BrowserWindow): void { this.extraWindows.add(win) }
  static removeExtraWindow(win: BrowserWindow): void { this.extraWindows.delete(win) }
  static getExtraWindows(): Set<BrowserWindow> { return this.extraWindows }

  /** Return a snapshot of the current team state (pull-based, for TeamsView) */
  getTeamInfo(): { routingId: string; teamName: string | null; sessionId: string | null; projectKey: string | null; teammates: Array<{ toolUseId: string; name: string; sanitizedName: string; teamName: string; sanitizedTeamName: string; agentId: string; fileId: string; status: 'running' | 'completed' | 'failed' | 'stopped' }> } {
    const projectKey = this.cwd ? this.cwd.replace(/[/.]/g, '-') : null

    // Resolve JSONL fileIds — use stable names (team-streaming patch) first,
    // fall back to prompt-based search for unpatched sessions
    let fileMap: Record<string, string> = {}
    if (this.sessionId && projectKey && this._detectedTeammates.length > 0) {
      const taskPrompts: Record<string, string> = {}
      for (const t of this._detectedTeammates) {
        if (t.prompt) taskPrompts[t.toolUseId] = t.prompt
      }
      if (Object.keys(taskPrompts).length > 0) {
        fileMap = buildSubagentFileMap(this.sessionId, projectKey, taskPrompts)
      }
    }

    return {
      routingId: this.routingId,
      teamName: this._teamName,
      sessionId: this.sessionId,
      projectKey,
      teammates: this._detectedTeammates.map((t) => ({
        ...t,
        // Stable filename from team-streaming patch: name--team
        // Falls back to prompt-based fileMap, then raw agentId
        fileId: (t.name && t.teamName) ? `${t.name}--${t.teamName}` : (fileMap[t.toolUseId] || t.agentId),
        status: this._teammateStatuses.get(t.toolUseId) || 'running'
      }))
    }
  }

  private sessionId: string | null = null
  private abortController: AbortController | null = null
  private isProcessing = false
  private wasInterrupted = false
  private pendingApprovals = new Map<string, PendingApprovalEntry>()
  private taskIdMap = new Map<string, string>() // agentId → toolUseId
  private pendingTeammates = new Map<string, { name: string; teamName: string; prompt?: string }>() // toolUseId → { name, teamName, prompt }
  private _teamName: string | null = null
  private _detectedTeammates: Array<{ toolUseId: string; name: string; teamName: string; agentId: string; sanitizedName: string; sanitizedTeamName: string; prompt?: string }> = []
  private _teammateStatuses = new Map<string, 'running' | 'completed' | 'failed' | 'stopped'>()
  private teammateIdToToolUse = new Map<string, string>() // teammate_id ("name@team") → toolUseId
  private backgroundFilePaths = new Map<string, string>() // toolUseId → filePath (permanent)
  private backgroundPollers = new Map<string, BackgroundPoller>() // toolUseId → poller state
  private _initMcpServers: Array<{ name: string; status: string }> = [] // cached from init message
  private _mcpAllServers: Record<string, McpServerConfig> = {} // full config loaded at session start
  private _mcpDisabledServers = new Set<string>() // servers disabled via toggle
  private win: BrowserWindow
  routingId: string
  readonly cwd: string
  private totalCostUsd = 0
  private messageChannel: MessageChannel<unknown> | null = null
  private activeQuery: {
    interrupt(): Promise<void>
    setPermissionMode(mode: string): Promise<void>
    setModel(model?: string): Promise<void>
    stopTask(taskId: string): Promise<void>
    backgroundTask(taskId: string): Promise<unknown>
    dequeueMessage(value: string): Promise<{ removed: number }>
    getUsage(): Promise<Record<string, unknown>>
    // MCP methods
    mcpServerStatus(): Promise<unknown[]>
    toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
    reconnectMcpServer(serverName: string): Promise<void>
    setMcpServers(servers: Record<string, unknown>): Promise<unknown>
    // Permission hot-reload
    applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  } | null = null
  private slug: string | null = null
  private permissionMode: string = 'default'
  private effort: string
  private model: string = 'default'
  private resumeSessionId: string | undefined
  private statusLineTimer: ReturnType<typeof setTimeout> | null = null
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private inactivityTimeoutMs = 15 * 60 * 1000 // default 15 min, 0 = disabled
  private sandboxConfig: SandboxSettings | null = null

  // In-memory token accumulators — updated from each assistant message's usage
  private accInputTokens = 0
  private accOutputTokens = 0
  private accCachedTokens = 0
  private accTotalDurationMs = 0
  private accTotalApiDurationMs = 0
  private lastContextLength = 0

  constructor(routingId: string, win: BrowserWindow, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string, sandboxConfig?: SandboxSettings) {
    this.routingId = routingId
    this.win = win
    this.cwd = cwd
    this.effort = effort || 'medium'
    this.resumeSessionId = resumeSessionId
    if (permissionMode) this.permissionMode = permissionMode
    if (model) this.model = model
    if (sandboxConfig) this.sandboxConfig = sandboxConfig
    this.sendStatus()
  }

  get status(): SessionStatus {
    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd
    }
  }

  /** Update the inactivity timeout. Pass 0 to disable. */
  setInactivityTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms
    // Re-evaluate: if idle, restart timer with new duration; if active, timer is already cleared
    if (!this.isProcessing) this.resetInactivityTimer()
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('ClaudeSession', `Idle timeout (${this.inactivityTimeoutMs / 60000} min) — auto-disconnecting`)
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  /** Whether a prompt sent now will be queued (session actively processing a turn) */
  get willQueue(): boolean {
    return this.isProcessing
  }

  async run(prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>): Promise<void> {
    this.clearInactivityTimer()
    this.isProcessing = true
    this.wasInterrupted = false
    this.sendStatus()

    // Build content: plain string when text-only, ContentBlockParam[] when attachments present
    let content: string | Array<Record<string, unknown>> = prompt
    if (attachments && attachments.length > 0) {
      const blocks: Array<Record<string, unknown>> = []
      for (const att of attachments) {
        if (att.mediaType === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: att.mediaType, data: att.base64Data }
          })
        } else {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.base64Data }
          })
        }
      }
      if (prompt) {
        blocks.push({ type: 'text', text: prompt })
      }
      content = blocks
    }

    // SDK streaming input format — must match SDKUserMessage type
    // (session_id and parent_tool_use_id are required by the CLI parser)
    const sdkMessage = {
      type: 'user' as const,
      session_id: this.sessionId || '',
      message: { role: 'user' as const, content },
      parent_tool_use_id: null
    }

    if (this.messageChannel) {
      // Session already active — push to existing channel
      this.messageChannel.push(sdkMessage)
      return
    }

    // First run — start persistent session with streaming input mode.
    // Passing an AsyncIterable (instead of a string) keeps the CLI subprocess
    // alive so background agents can report back via task_notification.
    const channel = new MessageChannel<unknown>()
    this.messageChannel = channel
    channel.push(sdkMessage)
    this.abortController = new AbortController()

    // Collect stderr chunks so we can include them in error messages
    const stderrChunks: string[] = []

    try {
      const execOpts = getSdkExecutableOpts()
      const cliPath = execOpts.pathToClaudeCodeExecutable as string | undefined
      if (cliPath) {
        const cliExists = fs.existsSync(cliPath)
        logger.debug('ClaudeSession', `CLI path: ${cliPath} (exists: ${cliExists})`)
        if (!cliExists) {
          this.send('session:error', `CLI not found at: ${cliPath}`)
          return
        }
      }
      // Load MCP servers from config files and pass explicitly via mcpServers.
      // This supplements the SDK's own settingSources config loading. While the
      // mcp-status patch ensures plugin MCP servers are properly awaited before
      // mcp_status responds, passing config-file servers via mcpServers ensures
      // they're always available even if settingSources parsing differs.
      // The SDK deduplicates by name, so there are no duplicate connections.
      this._mcpAllServers = {}
      this._mcpDisabledServers.clear()
      for (const scope of ['user', 'project', 'local'] as const) {
        try {
          const servers = loadMcpServers(scope, this.cwd)
          Object.assign(this._mcpAllServers, servers)
        } catch {
          // Scope may not apply (e.g., project/local without cwd)
        }
      }

      // Read disabledMcpServers from ~/.claude.json's project entry for logging.
      // The CLI persists disabled state here via the TR() check. The SDK reads
      // this internally and marks servers as disabled.
      //
      // IMPORTANT: We pass ALL servers (including disabled) via mcpServers.
      // The SDK's TR() function checks disabledMcpServers from ~/.claude.json
      // and marks them as disabled (type: "disabled") in the client list.
      // We must NOT remove them — they need to be in the client list for
      // toggleMcpServer(name, true) to find them when re-enabling.
      const disabledNames = readDisabledMcpServers(this.cwd)
      for (const name of disabledNames) {
        this._mcpDisabledServers.add(name)
      }

      if (Object.keys(this._mcpAllServers).length > 0) {
        logger.debug('ClaudeSession', `Loaded ${Object.keys(this._mcpAllServers).length} MCP server(s): ${Object.keys(this._mcpAllServers).join(', ')}`)
      }
      if (this._mcpDisabledServers.size > 0) {
        logger.debug('ClaudeSession', `Disabled MCP server(s) (from ~/.claude.json): ${[...this._mcpDisabledServers].join(', ')}`)
      }

      const q = sdkQuery({
        prompt: channel as AsyncIterable<never>,
        options: {
          ...execOpts,
          cwd: this.cwd,
          model: this.model,
          permissionMode: this.permissionMode as 'default',
          ...(this.sandboxConfig?.enabled ? {
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: this.sandboxConfig.autoAllowBashIfSandboxed,
              allowUnsandboxedCommands: this.sandboxConfig.allowUnsandboxedCommands,
              excludedCommands: this.sandboxConfig.excludedCommands,
              // Only pass network config when restrictions are needed.
              // Omitting the network key entirely lets the SDK skip domain filtering,
              // which is what "restrictNetwork: false" means.
              ...(this.sandboxConfig.network.restrictNetwork ? {
                network: {
                  allowLocalBinding: this.sandboxConfig.network.allowLocalBinding,
                  allowedDomains: this.sandboxConfig.network.allowedDomains,
                  ...(this.sandboxConfig.network.allowManagedDomainsOnly
                    ? { allowManagedDomainsOnly: true } : {}),
                  ...(this.sandboxConfig.network.allowAllUnixSockets
                    ? { allowAllUnixSockets: true } : {}),
                  ...(this.sandboxConfig.network.allowUnixSockets.length > 0
                    ? { allowUnixSockets: this.sandboxConfig.network.allowUnixSockets } : {})
                }
              } : {
                // No network restrictions — only pass through binding/socket options if set
                ...(this.sandboxConfig.network.allowLocalBinding ||
                    this.sandboxConfig.network.allowAllUnixSockets ||
                    this.sandboxConfig.network.allowUnixSockets.length > 0
                  ? {
                    network: {
                      allowLocalBinding: this.sandboxConfig.network.allowLocalBinding,
                      ...(this.sandboxConfig.network.allowAllUnixSockets
                        ? { allowAllUnixSockets: true } : {}),
                      ...(this.sandboxConfig.network.allowUnixSockets.length > 0
                        ? { allowUnixSockets: this.sandboxConfig.network.allowUnixSockets } : {})
                    }
                  } : {})
              }),
              filesystem: {
                ...(this.sandboxConfig.filesystem.allowWrite.length > 0
                  ? { allowWrite: this.sandboxConfig.filesystem.allowWrite } : {}),
                ...(this.sandboxConfig.filesystem.denyWrite.length > 0
                  ? { denyWrite: this.sandboxConfig.filesystem.denyWrite } : {}),
                ...(this.sandboxConfig.filesystem.denyRead.length > 0
                  ? { denyRead: this.sandboxConfig.filesystem.denyRead } : {})
              }
            }
          } : {}),
          settingSources: ['user', 'project', 'local'],
          ...(Object.keys(this._mcpAllServers).length > 0
            ? { mcpServers: this._mcpAllServers as Record<string, never> }
            : {}),
          abortController: this.abortController,
          includePartialMessages: true,
          thinking: { type: 'enabled', budgetTokens: 10000 },
          effort: this.effort as 'low' | 'medium' | 'high',
          stderr: (chunk) => {
            const text = chunk.toString().trim()
            if (text) {
              logger.error('SDK', `stderr: ${text}`)
              stderrChunks.push(text)
            }
          },
          ...(this.resumeSessionId ? { resume: this.resumeSessionId } : this.sessionId ? { resume: this.sessionId } : {}),
          canUseTool: async (toolName, input, opts) => {
            const requestId = uuid()
            const approval: PendingApproval = {
              requestId,
              toolName,
              input,
              suggestions: opts.suggestions as PendingApproval['suggestions'],
              decisionReason: opts.decisionReason,
              blockedPath: opts.blockedPath,
            }
            this.send('session:approval-request', approval)

            const { decision, answers, updatedPermissions } = await new Promise<ApprovalResult>((resolve) => {
              this.pendingApprovals.set(requestId, { resolve })

              opts.signal.addEventListener('abort', () => {
                this.pendingApprovals.delete(requestId)
                resolve({ decision: 'deny' })
              })
            })

            this.pendingApprovals.delete(requestId)

            if (decision === 'allow') {
              const updatedInput = answers ? { ...input, answers } : input
              // updatedPermissions originates from SDK suggestions and round-trips
              // through IPC with loose string types — cast back to SDK's union types
              return {
                behavior: 'allow' as const,
                updatedInput,
                ...(updatedPermissions?.length
                  ? { updatedPermissions: updatedPermissions as unknown as import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[] }
                  : {})
              }
            }
            const message = answers?.feedback || 'User denied'
            return { behavior: 'deny' as const, message }
          }
        }
      })

      this.activeQuery = q as unknown as {
        interrupt(): Promise<void>
        setPermissionMode(mode: string): Promise<void>
        setModel(model?: string): Promise<void>
        stopTask(taskId: string): Promise<void>
        backgroundTask(taskId: string): Promise<unknown>
        dequeueMessage(value: string): Promise<{ removed: number }>
        getUsage(): Promise<Record<string, unknown>>
        mcpServerStatus(): Promise<unknown[]>
        toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
        reconnectMcpServer(serverName: string): Promise<void>
        setMcpServers(servers: Record<string, unknown>): Promise<unknown>
        applyFlagSettings(settings: Record<string, unknown>): Promise<void>
      }

      for await (const message of q) {
        if (!message || typeof message !== 'object') continue

        const msg = message as Record<string, unknown>
        const type = msg.type as string

        // Capture session_id from first message
        if ('session_id' in msg && msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id as string

          // Extract slash commands from init before sendStatus triggers a rekey
          if (type === 'system' && (msg.subtype as string) === 'init') {
            // CLI-only commands that produce no output through the SDK
            const CLI_ONLY = new Set(['context', 'cost', 'login', 'logout', 'release-notes', 'doctor'])
            const raw = (msg.slash_commands as string[]) || []
            const slashCommands = raw
              .filter((name) => !CLI_ONLY.has(name))
              .map((name) => ({ name: name.startsWith('/') ? name : '/' + name }))
            this.send('session:slash-commands', slashCommands)
            saveSlashCommands(slashCommands)

            // Extract skill names from init
            const skillNames = (msg.skills as string[]) || []
            this.send('session:skills', skillNames)

            // Extract MCP server statuses from init and cache for the dialog
            const mcpServers = (msg.mcp_servers as Array<{ name: string; status: string }>) || []
            this._initMcpServers = mcpServers
            logger.debug('ClaudeSession', `init mcp_servers (${mcpServers.length}): ${JSON.stringify(mcpServers).slice(0, 500)}`)
            if (mcpServers.length > 0) {
              this.send('session:mcp-servers', mcpServers)
            }

          }

          this.sendStatus()
        }

        // Capture slug for plan file resolution
        if ('slug' in msg && msg.slug && !this.slug) {
          this.slug = msg.slug as string
        }


        // Any assistant or stream content means we're processing
        if ((type === 'assistant' || type === 'stream_event') && !this.isProcessing) {
          this.isProcessing = true
          this.sendStatus()
        }

        if (type === 'assistant') {
          const parentToolUseId = msg.parent_tool_use_id as string | undefined
          const teammateToolUseId = this.resolveTeammateToolUseId(msg)
          const routingId = parentToolUseId || teammateToolUseId
          const isSidechain = !!routingId
          const chatMsg = this.transformAssistantMessage(msg)

          // Accumulate usage from every assistant message (main + sidechain)
          const hadUsage = this.accumulateUsage(msg, isSidechain)

          if (chatMsg) {
            if (routingId) {
              this.send('session:subagent-message', { toolUseId: routingId, message: chatMsg })
            } else {
              this.send('session:message', chatMsg)
              // Only update status line when usage actually changed (final message per API call)
              if (hadUsage) {
                this.scheduleStatusLineUpdate()
              }
            }
          }
        } else if (type === 'user') {
          await this.handleUserMessage(msg)
        } else if (type === 'stream_event') {
          const parentToolUseId = msg.parent_tool_use_id as string | undefined
          const teammateToolUseId = this.resolveTeammateToolUseId(msg)
          const routingId = parentToolUseId || teammateToolUseId
          const event = msg.event as Record<string, unknown> | undefined
          if (event) {
            const eventType = event.type as string
            if (eventType === 'content_block_delta') {
              const delta = event.delta as Record<string, unknown> | undefined
              if (delta) {
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  if (routingId) {
                    this.send('session:subagent-stream', { toolUseId: routingId, type: 'text', text: delta.text })
                  } else {
                    this.send('session:stream', { type: 'text', text: delta.text })
                  }
                } else if (
                  delta.type === 'thinking_delta' &&
                  typeof delta.thinking === 'string'
                ) {
                  if (routingId) {
                    this.send('session:subagent-stream', { toolUseId: routingId, type: 'thinking', text: delta.thinking })
                  } else {
                    this.send('session:stream', { type: 'thinking', text: delta.thinking })
                  }
                }
              }
            }
          }
        } else if (type === 'tool_progress') {
          this.send('session:task-progress', {
            toolUseId: (msg.tool_use_id as string) || '',
            toolName: (msg.tool_name as string) || '',
            parentToolUseId: (msg.parent_tool_use_id as string) || null,
            elapsedTimeSeconds: (msg.elapsed_time_seconds as number) || 0
          })
        } else if (type === 'system') {
          const subtype = msg.subtype as string | undefined
          if (subtype === 'status') {
            const newMode = msg.permissionMode as string | undefined
            if (newMode && newMode !== this.permissionMode) {
              this.permissionMode = newMode
              this.send('session:permission-mode', newMode)
            }
          } else if (subtype === 'task_notification') {
            const taskId = (msg.task_id as string) || ''
            const outputFile = (msg.output_file as string) || ''
            // Correlate with task by agentId
            const matchedToolUseId = this.taskIdMap.get(taskId) || null
            if (matchedToolUseId) {
              this.markBackgroundDone(matchedToolUseId)
              this.taskIdMap.delete(taskId)
              const taskStatus = (msg.status as string) || 'completed'
              const statusMap: Record<string, 'completed' | 'failed' | 'stopped'> = { completed: 'completed', failed: 'failed', stopped: 'stopped' }
              this._teammateStatuses.set(matchedToolUseId, statusMap[taskStatus] || 'completed')
            }

            // Extract usage from the patched system message (task-notification-usage patch)
            const rawUsage = msg.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | null
            const usage = rawUsage ? {
              totalTokens: rawUsage.total_tokens || 0,
              toolUses: rawUsage.tool_uses || 0,
              durationMs: rawUsage.duration_ms || 0
            } : undefined

            const sysNotification = {
              taskId,
              toolUseId: matchedToolUseId,
              status: (msg.status as string) || 'completed',
              outputFile,
              summary: (msg.summary as string) || '',
              usage
            }
            this.send('session:task-notification', sysNotification)
          } else if (subtype === 'queued_command_consumed') {
            const prompt = (msg.prompt as string) || ''
            this.send('session:steer-consumed', { prompt })
          }
        } else if (type === 'control_response') {
          const response = msg.response as Record<string, unknown> | undefined
          if (response) {
            const subtype = response.subtype as string
            if (subtype === 'error') {
              const errText = typeof response.error === 'string'
                ? response.error
                : JSON.stringify(response.error, null, 2)
              logger.error('ClaudeSession', `Control response error: ${errText}`)
              this.send('session:error', `SDK control error: ${errText}`)
            }
          }
        } else if (type === 'result') {
          const cost = (msg.total_cost_usd as number) || 0
          this.totalCostUsd += cost
          this.isProcessing = false

          // Handle error results
          const subtype = msg.subtype as string | undefined
          if (subtype && subtype !== 'success') {
            // When the user clicked Stop, the SDK sends error results as it
            // tears down the interrupted turn.  These are not real failures —
            // suppress them entirely.
            if (!this.wasInterrupted) {
              const errors = (msg.errors as string[]) || []
              const stderrContext = stderrChunks.length > 0
                ? '\n\nCLI stderr:\n' + stderrChunks.slice(-20).join('\n')
                : ''
              if (errors.length) {
                logger.error('ClaudeSession', `Result error: ${errors.join('; ')}`)
                this.send('session:error', errors.join('; ') + stderrContext)
              } else {
                const fallback = `Session ended with status: ${subtype}`
                logger.error('ClaudeSession', fallback)
                this.send('session:error', fallback + stderrContext)
              }
            }
          }

          // Accumulate duration from result
          const resultDurationMs = (msg.duration_ms as number) || 0
          const resultApiDurationMs = (msg.duration_api_ms as number) || 0
          this.accTotalDurationMs += resultDurationMs
          this.accTotalApiDurationMs += resultApiDurationMs

          this.send('session:result', {
            totalCostUsd: this.totalCostUsd,
            durationMs: resultDurationMs,
            result: (msg.result as string) || ''
          })
          this.sendStatus()
          this.resetInactivityTimer()

          // Cancel any pending debounced update — we'll send one immediately
          if (this.statusLineTimer) {
            clearTimeout(this.statusLineTimer)
            this.statusLineTimer = null
          }

          // Send accumulator-based status line immediately so the UI updates
          // without waiting for the JSONL read (which may not be fully flushed yet)
          this.send('session:status-line', this.buildStatusLineFromAccumulators())

          // Then try to reconcile from JSONL with a delay to let the SDK flush.
          // Only overwrite accumulators if JSONL returns meaningful data.
          const logPath = this.getSessionLogPath()
          if (logPath) {
            setTimeout(() => {
              computeTokenMetrics(logPath, this.model).then((metrics) => {
                if (metrics.totalTokens === 0 && metrics.totalCostUsd === 0) return // JSONL not ready yet
                this.accInputTokens = metrics.totalInputTokens
                this.accOutputTokens = metrics.totalOutputTokens
                this.accCachedTokens = metrics.cachedTokens
                this.accTotalDurationMs = metrics.totalDurationMs
                this.accTotalApiDurationMs = metrics.totalApiDurationMs
                this.lastContextLength = metrics.contextWindowSize
                this.send('session:status-line', metrics)
              }).catch((err) => { logger.warn('ClaudeSession', 'JSONL reconciliation failed', err) })
            }, 500) // delay to let SDK flush JSONL to disk
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      const stderrContext = stderrChunks.length > 0 ? `\nCollected stderr:\n${stderrChunks.join('\n')}` : ''
      logger.error('ClaudeSession', `SDK error: ${errorMsg}${stderrContext}`, err)
      if (!errorMsg.includes('abort') && errorMsg !== '') {
        // Build a structured error message:
        // Line 1: human-readable summary
        // Rest: stack trace + CLI stderr (expandable in the UI)
        const parts: string[] = []

        // For CLI crashes, lead with a clear summary instead of the raw SDK error
        if (errorMsg.includes('process exited with code')) {
          const code = errorMsg.match(/code (\d+)/)?.[1] || '?'
          parts.push(`CLI process crashed (exit code ${code})`)
        } else {
          parts.push(errorMsg)
        }

        if (stack) parts.push('\nStack trace:\n' + stack)
        if (stderrChunks.length > 0) {
          parts.push('\nCLI stderr:\n' + stderrChunks.slice(-30).join('\n'))
        }

        this.send('session:error', parts.join('\n'))
      }
    } finally {
      this.messageChannel?.end()
      this.messageChannel = null
      this.activeQuery = null
      this.abortController = null
      this.isProcessing = false
      this.sendStatus()
      this.resetInactivityTimer()
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(mode)
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model
    if (this.activeQuery) {
      await this.activeQuery.setModel(model)
    }
    // Recalculate status line with new context window size
    this.send('session:status-line', this.buildStatusLineFromAccumulators())
  }

  setEffort(effort: string): void {
    this.effort = effort
  }

  async dequeueMessage(value: string): Promise<{ removed: number }> {
    if (!this.activeQuery) return { removed: 0 }
    return await this.activeQuery.dequeueMessage(value)
  }

  /**
   * Fetch account usage via the CLI's internal OAuth usage API.
   * Returns the raw API response (e.g., { five_hour, seven_day, ... })
   * or null if no active query.
   */
  async getUsage(): Promise<Record<string, unknown> | null> {
    if (!this.activeQuery) return null
    try {
      return await this.activeQuery.getUsage()
    } catch (err) {
      logger.warn('ClaudeSession', 'getUsage failed', err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Permission rules hot-reload
  // ---------------------------------------------------------------------------

  /**
   * Notify the running CLI session that settings files changed on disk so it
   * re-reads them and rebuilds its internal `toolPermissionContext`.
   *
   * The CLI's file watcher is disabled in SDK mode (`isRemoteMode`), so
   * writing to settings.json alone doesn't propagate.  We work around this
   * by sending an empty `apply_flag_settings({})` control message — the merge
   * is a no-op (nothing injected into the flag layer) but the CLI still fires
   * `notifyChange("flagSettings")`, which invalidates its settings cache and
   * triggers the subscriber to re-read all sources from disk.
   *
   * This approach is safe for managed/enterprise policies because we don't
   * inject any rules into the flag layer — the CLI re-evaluates its own
   * setting sources, respecting `allowManagedPermissionRulesOnly` and the
   * normal priority hierarchy.
   */
  async notifySettingsChanged(): Promise<void> {
    if (!this.activeQuery) {
      logger.debug('ClaudeSession', 'notifySettingsChanged: no active query, skipping')
      return
    }
    try {
      await this.activeQuery.applyFlagSettings({})
      logger.debug('ClaudeSession', 'notifySettingsChanged: CLI notified')
    } catch (err) {
      logger.warn('ClaudeSession', 'notifySettingsChanged failed', err)
    }
  }

  // ---------------------------------------------------------------------------
  // MCP server management (delegated to SDK Query object)
  // ---------------------------------------------------------------------------

  async mcpServerStatus(): Promise<unknown[]> {
    if (!this.activeQuery) {
      logger.debug('ClaudeSession', 'mcpServerStatus: no activeQuery, returning cached init servers')
      return this._initMcpServers
    }
    try {
      const result = await this.activeQuery.mcpServerStatus()
      // Log each server's name and status for debugging
      const summary = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>).map(s => `${s.name}:${s.status}`).join(', ')
        : 'not-array'
      logger.debug('ClaudeSession', `mcpServerStatus: ${Array.isArray(result) ? result.length : 0} servers → [${summary}]`)
      logger.debug('ClaudeSession', `mcpServerStatus raw: ${JSON.stringify(result).slice(0, 1000)}`)
      return result
    } catch (err) {
      logger.error('ClaudeSession', 'mcpServerStatus failed, returning cached init servers', err)
      return this._initMcpServers
    }
  }

  async mcpToggleServer(serverName: string, enabled: boolean): Promise<void> {
    if (!this.activeQuery) throw new Error('No active session')

    // Use the SDK's native toggleMcpServer which:
    // 1. Updates disabledMcpServers in ~/.claude.json (persists across restarts)
    // 2. Actually disconnects/reconnects the MCP server process
    // 3. Updates internal client state (type: "disabled" / "connected")
    logger.debug('ClaudeSession', `mcpToggle: ${serverName} → ${enabled ? 'enable' : 'disable'}`)

    // Log pre-toggle state from ~/.claude.json
    const preDis = readDisabledMcpServers(this.cwd)
    logger.debug('ClaudeSession', `mcpToggle PRE: disabledMcpServers=[${preDis.join(', ')}]`)

    try {
      await this.activeQuery.toggleMcpServer(serverName, enabled)
      logger.debug('ClaudeSession', `mcpToggle: SDK toggleMcpServer completed successfully`)
    } catch (err) {
      logger.error('ClaudeSession', `mcpToggle: SDK toggleMcpServer FAILED`, err)
      throw err
    }

    // Log post-toggle state
    const postDis = readDisabledMcpServers(this.cwd)
    logger.debug('ClaudeSession', `mcpToggle POST: disabledMcpServers=[${postDis.join(', ')}]`)

    // Verify the toggle had the expected effect
    if (enabled && postDis.includes(serverName)) {
      logger.error('ClaudeSession', `mcpToggle BUG: enabled=${enabled} but ${serverName} is still in disabledMcpServers!`)
    }
    if (!enabled && !postDis.includes(serverName)) {
      logger.error('ClaudeSession', `mcpToggle BUG: enabled=${enabled} but ${serverName} is NOT in disabledMcpServers!`)
    }

    // Also query status to see the SDK's view
    try {
      const status = await this.activeQuery.mcpServerStatus()
      const summary = Array.isArray(status)
        ? (status as Array<Record<string, unknown>>).map(s => `${s.name}:${s.status}`).join(', ')
        : 'not-array'
      logger.debug('ClaudeSession', `mcpToggle POST-STATUS: [${summary}]`)
    } catch {
      // Non-critical
    }
  }

  async mcpReconnectServer(serverName: string): Promise<void> {
    if (!this.activeQuery) throw new Error('No active session')
    logger.debug('ClaudeSession', `mcpReconnect: ${serverName}`)
    await this.activeQuery.reconnectMcpServer(serverName)

    // Query status after reconnect
    try {
      const status = await this.activeQuery.mcpServerStatus()
      const summary = Array.isArray(status)
        ? (status as Array<Record<string, unknown>>).map(s => `${s.name}:${s.status}`).join(', ')
        : 'not-array'
      logger.debug('ClaudeSession', `mcpReconnect POST-STATUS: [${summary}]`)
    } catch {
      // Non-critical
    }
  }

  async mcpSetServers(servers: Record<string, unknown>): Promise<unknown> {
    if (!this.activeQuery) throw new Error('No active session')
    logger.debug('ClaudeSession', `mcpSetServers: setting [${Object.keys(servers).join(', ')}]`)
    const result = await this.activeQuery.setMcpServers(servers)
    logger.debug('ClaudeSession', `mcpSetServers result: ${JSON.stringify(result).slice(0, 500)}`)
    return result
  }

  /**
   * Extract usage from an assistant message and accumulate in-memory counters.
   * Returns true if usage was found and accumulated.
   */
  private accumulateUsage(msg: Record<string, unknown>, isSidechain: boolean): boolean {
    const betaMessage = msg.message as Record<string, unknown> | undefined
    if (!betaMessage) return false
    const usage = betaMessage.usage as Record<string, number> | undefined
    if (!usage) return false

    const inputTokens = usage.input_tokens || 0
    const outputTokens = usage.output_tokens || 0
    const cacheRead = usage.cache_read_input_tokens || 0
    const cacheCreation = usage.cache_creation_input_tokens || 0

    this.accInputTokens += inputTokens
    this.accOutputTokens += outputTokens
    this.accCachedTokens += cacheRead + cacheCreation

    // Context length from the most recent non-sidechain assistant message
    if (!isSidechain) {
      this.lastContextLength = inputTokens + cacheRead + cacheCreation
    }

    return true
  }

  /** Context window size based on the currently selected model. */
  private get contextWindowSize(): number {
    return getContextWindowSize(this.model)
  }

  /** Build StatusLineData from in-memory accumulators (zero I/O) */
  private buildStatusLineFromAccumulators(): import('../../shared/types').StatusLineData {
    const ctxWindow = this.contextWindowSize
    const usedPct = this.lastContextLength > 0 ? Math.round((this.lastContextLength / ctxWindow) * 100) : null
    return {
      totalCostUsd: this.totalCostUsd,
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: this.accTotalApiDurationMs,
      totalInputTokens: this.accInputTokens,
      totalOutputTokens: this.accOutputTokens,
      cachedTokens: this.accCachedTokens,
      totalTokens: this.accInputTokens + this.accOutputTokens + this.accCachedTokens,
      contextWindowSize: this.lastContextLength,
      usedPercentage: usedPct,
      remainingPercentage: usedPct !== null ? 100 - usedPct : null
    }
  }

  /** Throttled status line update from in-memory accumulators (zero I/O) */
  private scheduleStatusLineUpdate(): void {
    if (this.statusLineTimer) return // already scheduled
    this.statusLineTimer = setTimeout(() => {
      this.statusLineTimer = null
      this.send('session:status-line', this.buildStatusLineFromAccumulators())
    }, 50)
  }

  getSessionLogPath(): string | null {
    if (!this.sessionId) return null
    // Project key mirrors the SDK's derivation: replace / and . with -
    const projectKey = this.cwd.replace(/[/.]/g, '-')
    return path.join(os.homedir(), '.claude', 'projects', projectKey, `${this.sessionId}.jsonl`)
  }

  getPlanContent(): string | null {
    const plansDir = path.join(os.homedir(), '.claude', 'plans')

    // Try slug-based lookup first
    if (this.slug) {
      const planPath = path.join(plansDir, `${this.slug}.md`)
      try {
        return fs.readFileSync(planPath, 'utf-8')
      } catch (err) {
        logger.warn('ClaudeSession', `Failed to read plan file: ${planPath}`, err)
      }
    }

    // Fallback: find the most recently modified .md file in plans dir
    try {
      const files = fs.readdirSync(plansDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const full = path.join(plansDir, f)
          return { path: full, mtime: fs.statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length > 0) {
        return fs.readFileSync(files[0].path, 'utf-8')
      }
    } catch (err) {
      logger.warn('ClaudeSession', 'Plans directory unreadable', err)
    }

    return null
  }

  resolveApproval(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]): void {
    const entry = this.pendingApprovals.get(requestId)
    if (entry) {
      entry.resolve({ decision, answers, updatedPermissions })
    }
  }

  cancel(): void {
    // Deny all pending approvals
    for (const [, entry] of this.pendingApprovals) {
      entry.resolve({ decision: 'deny' })
    }
    this.pendingApprovals.clear()

    this.wasInterrupted = true
    this.clearInactivityTimer()
    this.stopAllBackgroundPollers()
    unwatchAllSubagents()

    // End the message channel before aborting so the SDK's streamInput
    // loop can unblock and the CLI subprocess exits cleanly
    this.messageChannel?.end()
    this.abortController?.abort()
    this.abortController = null
    this.isProcessing = false
    this.send('session:status', { ...this.status, state: 'disconnected' })
  }

  /** Interrupt the current turn without killing the session.
   *  Mirrors pressing Escape in the real CLI — the CLI aborts the active
   *  API call / tool execution, yields tombstone messages, and returns to idle. */
  async interrupt(): Promise<void> {
    if (this.activeQuery) {
      this.wasInterrupted = true

      // Deny pending approvals so the SDK's canUseTool callbacks unblock
      for (const [, entry] of this.pendingApprovals) {
        entry.resolve({ decision: 'deny' })
      }
      this.pendingApprovals.clear()

      await this.activeQuery.interrupt()
    }
  }

  async stopTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
    // Reverse lookup: toolUseId → task_id
    let taskId: string | null = null
    for (const [tid, tuid] of this.taskIdMap.entries()) {
      if (tuid === toolUseId) {
        taskId = tid
        break
      }
    }

    if (!taskId) {
      // Foreground tasks don't have a taskIdMap entry yet (detectTaskMapping runs
      // on tool results, which haven't arrived for running foreground tasks).
      // Use interrupt() to cancel the current turn — this mirrors pressing Escape
      // in the real CLI: the CLI aborts the active API call/tool execution, yields
      // tombstone messages (tool_result with is_error + "[Request interrupted by
      // user for tool use]"), and returns to idle. The session stays alive.
      if (!this.activeQuery) {
        return { success: false, error: 'No active session' }
      }
      try {
        this.wasInterrupted = true
        await this.activeQuery.interrupt()
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }

    if (!this.activeQuery) {
      return { success: false, error: 'No active session' }
    }

    try {
      await this.activeQuery.stopTask(taskId)

      // The SDK's TaskStop calls the notification sender (HDY → VB), but VB
      // enqueues to the CLI's output queue which is only consumed during model
      // turns.  Since TaskStop runs inside a control-message handler (no active
      // turn), the notification never reaches us.  Synthesize it directly.
      this.markBackgroundDone(toolUseId)
      this._teammateStatuses.set(toolUseId, 'stopped')
      this.taskIdMap.delete(taskId)

      this.send('session:task-notification', {
        taskId,
        toolUseId,
        status: 'stopped',
        outputFile: '',
        summary: '',
        usage: undefined
      })

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  async backgroundTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
    // Pass toolUseId directly — the CLI handler searches tasks by toolUseId property.
    // We don't use taskIdMap here because foreground tasks may not have a mapping yet
    // (detectTaskMapping runs on tool results, which haven't arrived for running tasks).
    if (!this.activeQuery) {
      return { success: false, error: 'No active session' }
    }

    try {
      await this.activeQuery.backgroundTask(toolUseId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  private transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
    const betaMessage = msg.message as Record<string, unknown> | undefined
    if (!betaMessage) return null

    const content = betaMessage.content as Array<Record<string, unknown>> | undefined
    if (!content || !Array.isArray(content)) return null

    const blocks: ContentBlock[] = content.map((block) => {
      const blockType = block.type as string
      if (blockType === 'text') {
        return { type: 'text' as const, text: block.text as string }
      } else if (blockType === 'tool_use') {
        return {
          type: 'tool_use' as const,
          toolName: block.name as string,
          toolInput: block.input as Record<string, unknown>,
          toolUseId: block.id as string
        }
      } else if (blockType === 'tool_result') {
        const resultContent = block.content
        let text = ''
        if (typeof resultContent === 'string') {
          text = resultContent
        } else if (Array.isArray(resultContent)) {
          text = resultContent
            .map((c: Record<string, unknown>) => (c.text as string) || '')
            .join('\n')
        }
        return {
          type: 'tool_result' as const,
          toolUseId: block.tool_use_id as string,
          toolResult: text,
          isError: block.is_error as boolean
        }
      } else if (blockType === 'thinking') {
        return { type: 'thinking' as const, text: block.thinking as string }
      }
      return { type: 'text' as const, text: JSON.stringify(block) }
    })

    // Detect teammate Task tool_use blocks and TeamCreate
    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.toolUseId) continue
      if (isAgentTool(block.toolName) && block.toolInput?.name && block.toolInput?.team_name) {
        this.pendingTeammates.set(block.toolUseId, {
          name: String(block.toolInput.name),
          teamName: String(block.toolInput.team_name),
          prompt: block.toolInput.prompt ? String(block.toolInput.prompt) : undefined
        })
      }
      if (block.toolName === 'TeamCreate' && block.toolInput?.team_name) {
        const newTeam = String(block.toolInput.team_name)
        // Clear stale teammates and watchers from any previous team in this session
        if (newTeam !== this._teamName) {
          this._detectedTeammates = []
          this.pendingTeammates.clear()
          this.teammateIdToToolUse.clear()
          unwatchAllSubagents()
        }
        this._teamName = newTeam
        this.send('session:team-created', { teamName: this._teamName })
      }
      if (block.toolName === 'TeamDelete') {
        this._teamName = null
        this._detectedTeammates = []
        this.pendingTeammates.clear()
        this.teammateIdToToolUse.clear()
        this._teammateStatuses.clear()
        unwatchAllSubagents()
        this.send('session:team-deleted', {})
      }
    }

    // Use the BetaMessage id for deduplication of partial messages
    const messageId = (betaMessage.id as string) || (msg.uuid as string) || uuid()

    return {
      id: messageId,
      role: 'assistant',
      content: blocks,
      timestamp: Date.now()
    }
  }

  /**
   * Handle SDK user messages. Two cases:
   *
   * 1. Array content with tool_result blocks → extract tool results (normal flow)
   * 2. String content with <task-notification> XML → background agent completed.
   *    The SDK injects this as a synthetic user message so the model can respond.
   *    We parse the notification, resolve the background task, and insert the
   *    message into the conversation so the assistant's response has context.
   */
  private async handleUserMessage(msg: Record<string, unknown>): Promise<void> {
    const messageParam = msg.message as Record<string, unknown> | undefined
    if (!messageParam) return

    const parentToolUseId = msg.parent_tool_use_id as string | undefined
    const teammateToolUseId = this.resolveTeammateToolUseId(msg)
    const routingId = parentToolUseId || teammateToolUseId
    const content = messageParam.content

    // Case 1: Array content — extract tool_result blocks
    if (Array.isArray(content)) {
      this.extractToolResultsFromContent(content, routingId)
      return
    }

    // Case 2: String content — check for task notification
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      await this.handleTaskNotificationUserMessage(msg, content)
    }
  }

  private extractToolResultsFromContent(
    content: Array<Record<string, unknown>>,
    parentToolUseId?: string
  ): void {
    for (const block of content) {
      if (typeof block !== 'object' || !block) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') continue

      const toolUseId = b.tool_use_id as string
      if (!toolUseId) continue

      let resultText = ''
      const blockContent = b.content
      if (typeof blockContent === 'string') {
        resultText = blockContent
      } else if (Array.isArray(blockContent)) {
        resultText = blockContent
          .map((c: Record<string, unknown>) => (c.text as string) || '')
          .join('\n')
      }

      // Record agentId→toolUseId mapping for task notifications
      if (!parentToolUseId) {
        this.detectTaskMapping(toolUseId, resultText)
      }

      if (parentToolUseId) {
        this.send('session:subagent-tool-result', {
          toolUseId: parentToolUseId,
          toolResultToolUseId: toolUseId,
          result: resultText,
          isError: !!(b.is_error)
        })
      } else {
        this.send('session:tool-result', {
          toolUseId,
          result: resultText,
          isError: !!(b.is_error)
        })
      }

      // Parse sandbox violations from tool results
      if (resultText.includes('<sandbox_violations>')) {
        const match = resultText.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/)
        if (match) {
          const lines = match[1].trim().split('\n').filter(Boolean)
          for (const line of lines) {
            this.send('session:sandbox-violation', line.trim())
          }
        }
      }
    }
  }

  /**
   * When a background agent completes, the SDK injects a user message with
   * <task-notification> XML (see session log line 12 of 45d85f49-...).
   * We parse it to resolve the background task and insert the message
   * into the conversation.
   */
  private async handleTaskNotificationUserMessage(
    msg: Record<string, unknown>,
    content: string
  ): Promise<void> {
    const taskId = this.extractXmlTag(content, 'task-id')
    const status = this.extractXmlTag(content, 'status') || 'completed'
    const summary = this.extractXmlTag(content, 'summary') || ''
    const outputFile = ''

    // Extract <usage> block if present (background agents include this on completion)
    const usageBlock = this.extractXmlTag(content, 'usage')
    let usage: { totalTokens: number; toolUses: number; durationMs: number } | undefined
    if (usageBlock) {
      const getNum = (key: string): number => {
        const m = usageBlock.match(new RegExp(`${key}:\\s*(\\d+)`))
        return m ? Number(m[1]) : 0
      }
      usage = {
        totalTokens: getNum('total_tokens'),
        toolUses: getNum('tool_uses'),
        durationMs: getNum('duration_ms')
      }
    }

    if (taskId) {
      const matchedToolUseId = this.taskIdMap.get(taskId) || null
      if (matchedToolUseId) {
        this.markBackgroundDone(matchedToolUseId)
        this.taskIdMap.delete(taskId)
        const statusMap: Record<string, 'completed' | 'failed' | 'stopped'> = { completed: 'completed', failed: 'failed', stopped: 'stopped' }
        this._teammateStatuses.set(matchedToolUseId, statusMap[status] || 'completed')
      }

      const notification = {
        taskId,
        toolUseId: matchedToolUseId,
        status,
        outputFile,
        summary,
        usage
      }
      this.send('session:task-notification', notification)
    }

    // Insert the synthetic user message into the conversation so the
    // assistant's response (which follows) has visible context
    const chatMsg: ChatMessage = {
      id: (msg.uuid as string) || uuid(),
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now()
    }
    this.send('session:message', chatMsg)
  }

  /**
   * Resolve a teammate_id from the team-streaming patch to a toolUseId.
   * The patch sends messages with teammate_id = "name@team" (e.g., "ts-advocate@lang-debate").
   * Returns the corresponding toolUseId, or undefined if this isn't a teammate message.
   */
  private resolveTeammateToolUseId(msg: Record<string, unknown>): string | undefined {
    const teammateId = msg.teammate_id as string | undefined
    if (!teammateId) return undefined
    return this.teammateIdToToolUse.get(teammateId)
  }

  private extractXmlTag(xml: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    const match = xml.match(re)
    return match ? match[1].trim() : null
  }

  private detectTaskMapping(toolUseId: string, resultText: string): void {
    const agentMatch = resultText.match(AGENT_ID_RE)
    const taskIdMatch = resultText.match(TASK_ID_RE)
    const bgCmdMatch = resultText.match(BG_CMD_ID_RE)
    const agentId = agentMatch?.[1] || taskIdMatch?.[1] || bgCmdMatch?.[1] || ''

    if (agentId) {
      this.taskIdMap.set(agentId, toolUseId)

      // Check if this is a teammate we're tracking
      const pending = this.pendingTeammates.get(toolUseId)
      if (pending) {
        const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '-')
        const teammateData = {
          toolUseId,
          name: pending.name,
          teamName: pending.teamName,
          agentId,
          sanitizedName: sanitize(pending.name),
          sanitizedTeamName: sanitize(pending.teamName),
          prompt: pending.prompt
        }
        this._detectedTeammates.push(teammateData)
        this.send('session:teammate-detected', teammateData)
        this.pendingTeammates.delete(toolUseId)

        // Register teammate_id → toolUseId mapping for the team-streaming patch.
        // The patch forwards messages with teammate_id = "name@team".
        const teammateId = `${pending.name}@${pending.teamName}`
        this.teammateIdToToolUse.set(teammateId, toolUseId)
      }
    }

    // Record output file path for background commands (permanent — survives completion).
    // This works for both Task tools (with agentId) and background Bash (may lack agentId).
    const outputMatch = resultText.match(OUTPUT_FILE_RE)
    if (outputMatch) {
      const filePath = outputMatch[1].trim()
      this.backgroundFilePaths.set(toolUseId, filePath)
      // Create dormant poller entry (no interval until watched)
      if (!this.backgroundPollers.has(toolUseId)) {
        this.backgroundPollers.set(toolUseId, { filePath, lastSize: 0, done: false })
      }
    }
  }

  /** Read the last TAIL_SIZE bytes from a file, returning { tail, totalSize } */
  private readTail(filePath: string): { tail: string; totalSize: number } {
    try {
      const stat = fs.statSync(filePath)
      const totalSize = stat.size
      if (totalSize <= TAIL_SIZE) {
        return { tail: fs.readFileSync(filePath, 'utf-8'), totalSize }
      }
      // Read only the last TAIL_SIZE bytes
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(TAIL_SIZE)
        fs.readSync(fd, buf, 0, TAIL_SIZE, totalSize - TAIL_SIZE)
        return { tail: buf.toString('utf-8'), totalSize }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      logger.warn('ClaudeSession', `readTail failed for ${filePath}`, err)
      return { tail: '', totalSize: 0 }
    }
  }

  watchBackground(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    if (poller.done) {
      // Task already finished — single tail read, send with done: true
      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: true })
      return
    }

    // Always send current tail immediately (even if already polling from another watcher)
    const { tail, totalSize } = this.readTail(poller.filePath)
    if (totalSize > 0) {
      poller.lastSize = totalSize
      this.send('session:background-output', { toolUseId, tail, totalSize, done: false })
    }

    // Start polling if not already active
    if (poller.interval) return
    poller.interval = setInterval(() => {
      this.pollBackgroundFile(toolUseId)
    }, 500)
  }

  unwatchBackground(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return
    if (poller.interval) {
      clearInterval(poller.interval)
      poller.interval = undefined
    }
  }

  readBackgroundRange(toolUseId: string, offset: number, length: number): string {
    const filePath = this.backgroundFilePaths.get(toolUseId)
    if (!filePath) return ''
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(length)
        const bytesRead = fs.readSync(fd, buf, 0, length, offset)
        return buf.toString('utf-8', 0, bytesRead)
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      logger.warn('ClaudeSession', `readBackgroundRange failed for toolUseId=${toolUseId}`, err)
      return ''
    }
  }

  private pollBackgroundFile(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    try {
      const stat = fs.statSync(poller.filePath)
      if (stat.size <= poller.lastSize) return
      poller.lastSize = stat.size

      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: false })
    } catch (err) {
      logger.warn('ClaudeSession', `pollBackgroundFile failed for toolUseId=${toolUseId}`, err)
    }
  }

  private markBackgroundDone(toolUseId: string): void {
    const poller = this.backgroundPollers.get(toolUseId)
    if (!poller) return

    poller.done = true
    if (poller.interval) {
      // User is watching — do final read and stop
      clearInterval(poller.interval)
      poller.interval = undefined
      const { tail, totalSize } = this.readTail(poller.filePath)
      this.send('session:background-output', { toolUseId, tail, totalSize, done: true })
    }
    // If dormant (user not watching), just mark done — next watchBackground will do single read
  }

  private stopAllBackgroundPollers(): void {
    this.backgroundPollers.forEach((poller) => {
      if (poller.interval) clearInterval(poller.interval)
    })
    this.backgroundPollers.clear()
    this.backgroundFilePaths.clear()
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, this.routingId, data)
    }
    for (const w of ClaudeSession.extraWindows) {
      if (!w.isDestroyed()) w.webContents.send(channel, this.routingId, data)
    }
  }

  private sendStatus(): void {
    this.send('session:status', this.status)
  }
}
