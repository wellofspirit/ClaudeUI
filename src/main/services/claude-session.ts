import { query as sdkQuery } from '../sdk'
import type {
  QueryHandle,
  SDKMessage,
  AssistantMessage,
  StreamEventMessage,
  SystemMessage,
  ResultMessage,
  ToolProgressMessage,
  RateLimitEventMessage,
  BashOutputMessage,
  ControlResponseMessage
} from '../sdk'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import { computeTokenMetrics } from './session-history'
import { cwdToProjectKey } from '../../shared/project-key'
import { transformAssistantMessage } from './assistant-message'
import { classifyApiError } from './api-error'
import { VoiceClient } from './voice-client'
import { startRecording, stopRecording } from './voice-capture'
import { unwatchAllSubagents } from './subagent-watcher'
import { saveSlashCommands } from './ui-config'
import { loadMcpServers, readDisabledMcpServers } from './claude-mcp'
import { scanSkills } from './skill-scanner'
import { logger } from './logger'
import { getContextWindowSize } from './context-window'
import { usageFetcher } from './usage-fetcher'
import { createMermaidServer } from './mermaid-tool'
import { createMockupServer } from './mockup-tool'
import { createCollabServer } from './collab-tool'
import { crossEngineDispatcher, crossEngineDispatchAvailable } from './cross-engine-dispatcher'
import { claudeAuthProvider } from '../auth/ClaudeAuthProvider'
import { accountManager } from './account-manager'
import { equivalentCostUsd } from '../../shared/pricing'
import { resolveUsageProvider } from './usage-provider'
import {
  getClassifier,
  stopClassifier,
  isSafeTool,
  buildTranscript,
  type TranscriptMessage
} from './auto-classifier'
import {
  resolveThinkingMode,
  resolveClaudeCapabilities,
  type ThinkingMode
} from '../../shared/model-capabilities'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'

import { locateBunClaude, getCliVersion } from '../sdk'

/**
 * Path to the rebundled Bun standalone binary (has cli.js embedded).
 * Vendored at `vendor/claude-cli/bun-claude[.exe]` — built by
 * `scripts/rebundle-cli.mjs` during `bun run ensure-cli`.
 */
export function getCliJsPath(): string {
  return locateBunClaude()
}

/** Vendored CLI version, read from vendor/claude-cli/version.json. */
export function getSdkVersion(): string {
  return getCliVersion()
}

/**
 * cli.js compares retracted_message_uuids against frame uuids truncated to 24
 * chars (its `JWK` constant) so per-block derived uuids resolve to their base
 * frame. Mirror that here. See docs/protocol/04-system-subtypes.md §4.20.
 */
const RETRACTION_UUID_PREFIX_LEN = 24

/**
 * SDK options for the CLI spawn. The executable is our rebundled Bun binary;
 * it runs natively, carries all of Anthropic's bundled assets (ripgrep,
 * native addons, helper scripts), and does not need `ELECTRON_RUN_AS_NODE`
 * or a `NODE_PATH` injection.
 */
export function getSdkExecutableOpts(): Record<string, unknown> {
  const bunClaude = locateBunClaude()
  return {
    pathToClaudeCodeExecutable: bunClaude,
    executable: bunClaude,
    executableArgs: [],
    standaloneExecutable: true,
    env: {}
  }
}
import type {
  ChatMessage,
  McpServerConfig,
  SessionStatus,
  ApprovalDecision,
  PendingApproval,
  SandboxSettings,
  PermissionSuggestion,
  AccountRef,
  ModelCostEntry,
  EngineId
} from '../../shared/types'
import { claudeModel } from '../../shared/types'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'

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

  /** True once end() has been called — pushes silently no-op from here on, so
   *  callers (run()'s send path, H17) must (re-)establish a fresh channel
   *  rather than push into this one. */
  get isEnded(): boolean {
    return this.isDone
  }

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

export class ClaudeSession extends BaseSession {
  readonly engineId = 'claude' as const

  get capabilities(): ResolvedCapabilities {
    const base = resolveClaudeCapabilities(this.model)
    // ADR-030/ADR-033 M4-A: the static flag is true (both directions ship),
    // but the HONEST per-session value also requires the opencode binary to
    // actually be vendored — otherwise there is no possible dispatch target.
    return {
      ...base,
      crossEngineDispatch: base.crossEngineDispatch && crossEngineDispatchAvailable('claude')
    }
  }

  private sessionId: string | null = null
  /**
   * Wire-frame uuid → ChatMessage id, keyed by the first 24 chars of the uuid
   * (cli.js's own retraction matching truncates to 24 so per-block derived
   * uuids resolve to their base frame). Used to evict refused partials when a
   * model_refusal_fallback arrives with retracted_message_uuids.
   */
  private wireUuidToMessageId = new Map<string, string>()
  private abortController: AbortController | null = null
  private isProcessing = false
  private wasInterrupted = false
  private pendingApprovals = new Map<string, PendingApprovalEntry>()
  private taskIdMap = new Map<string, string>() // agentId → toolUseId
  private backgroundFilePaths = new Map<string, string>() // toolUseId → filePath (permanent)
  private backgroundPollers = new Map<string, BackgroundPoller>() // toolUseId → poller state
  private pendingBackgroundWatches = new Set<string>() // toolUseId waiting for poller registration
  private _initMcpServers: Array<{ name: string; status: string }> = [] // cached from init message
  private _mcpAllServers: Record<string, McpServerConfig> = {} // full config loaded at session start
  private _mcpDisabledServers = new Set<string>() // servers disabled via toggle
  /**
   * Cost tracking — base + live overlay (Slice B fix for the pre-existing
   * cumulative double-count bug: `total_cost_usd`/`modelUsage` are CUMULATIVE
   * WITHIN one cli.js process and reset to zero on `--resume`, so a naive `+=`
   * on every `result` re-adds the whole running total on turn 2+).
   *
   * - costBaseUsd / modelCostBase: everything that happened BEFORE the
   *   CURRENT cli.js process — seeded once from the resume transcript at
   *   construction (see reconcileAccumulatorsFromTranscript's seedCost param),
   *   and folded forward across a same-object respawn (a ClaudeSession CAN
   *   spawn cli.js more than once: run() takes the "first run" branch again
   *   whenever messageChannel is null, e.g. after cancel()'s idle-timeout
   *   teardown followed by a later session:send on the same routingId/object —
   *   see the fold in run()'s finally block).
   * - liveTotalCostUsd / liveModelCosts: the latest `result` message's
   *   cumulative values for the CURRENT process — REPLACED (never added) on
   *   every result, per the wire semantics above.
   *
   * Reported totalCostUsd = costBaseUsd + liveTotalCostUsd; per-model = the
   * base map merged with the live map, summed per model id.
   */
  private costBaseUsd = 0
  private modelCostBase = new Map<string, number>()
  private liveTotalCostUsd = 0
  private liveModelCosts = new Map<string, number>()
  private messageChannel: MessageChannel<unknown> | null = null
  /**
   * Set once by dispose() — the object has been permanently retired (replaced
   * under its routingId by SessionManager.create, or torn down at app quit).
   * Distinct from cancel(), which tears down the current cli.js process but
   * leaves the object usable for a later run() (idle timeout / user Stop). A
   * disposed object must NOT emit on the shared routingId or re-arm its idle
   * timer — otherwise its late run()-finally / idle-fired cancel() would clobber
   * the LIVE session that now owns the routingId (M-CL3).
   */
  private disposed = false
  /**
   * Set by cancel() (user Stop / idle timeout), cleared at the start of every
   * run(). cancel() broadcasts a terminal `disconnected` status; without this
   * flag the dying run's finally then re-emits its computed `idle` status a
   * moment later (the abort it triggers only reaches the parked for-await
   * asynchronously), clobbering `disconnected`, and re-arms the inactivity
   * timer cancel() just cleared. The disposed/superseded fences don't cover a
   * plain cancel(), so this guards that path specifically.
   */
  private cancelled = false
  /** Single source of truth for query method signatures: the SDK layer's
   *  QueryHandle. Previously duplicated here as an inline interface; drift
   *  between the two kept biting us when new methods shipped. */
  private activeQuery: QueryHandle | null = null
  /** Resolved once the query handle is available to callers that want to
   *  drive control methods without spawning a polling loop. Replaces the
   *  old 100ms-poll + 15s-deadline dance in ensureActiveQuery(). */
  private activeQueryPromise: Promise<QueryHandle> | null = null
  private resolveActiveQuery: ((handle: QueryHandle) => void) | null = null
  private rejectActiveQuery: ((err: Error) => void) | null = null
  private slug: string | null = null
  private permissionMode: string = 'default'
  private effort: string
  private thinkingMode: 'adaptive' | 'enabled' | 'disabled'
  private model: string = 'default'
  /** Canonical model id reported by system/init — what the `default` alias
   *  (and other server-resolved aliases) actually map to. Used to resolve the
   *  context window when `this.model` is an ambiguous alias. */
  private resolvedModelId: string | null = null
  private resumeSessionId: string | undefined
  /** Fork ("branch off") seeding: when set on creation, the FIRST run resumes
   *  `resumeSessionId` truncated to this line uuid with `--fork-session`, so a
   *  brand-new session UUID is minted carrying messages 1..N. Cleared once the
   *  fork has materialized (sessionId established) so later turns resume the
   *  new session normally. See resolveForkAnchor() in session-history.ts. */
  private resumeSessionAt: string | undefined
  private forkSession = false
  private statusLineTimer: ReturnType<typeof setTimeout> | null = null
  private sandboxConfig: SandboxSettings | null = null
  private voiceClient: VoiceClient | null = null
  private voiceServerPort: number | null = null

  // In-memory token accumulators — updated from each assistant message's usage
  private accInputTokens = 0
  private accOutputTokens = 0
  private accCachedTokens = 0
  private accTotalDurationMs = 0
  private accTotalApiDurationMs = 0
  private lastContextLength = 0
  /** Epoch ms when the currently in-flight turn started; null while idle. */
  private turnStartedAtMs: number | null = null

  constructor(routingId: string, win: BrowserWindow, cwd: string, opts: EngineSpawnOptions = {}) {
    const {
      effort,
      resumeSessionId,
      permissionMode,
      model,
      sandboxConfig,
      thinkingMode,
      resumeSessionAt,
      forkSession
    } = opts
    super(routingId, win, cwd)
    this.effort = effort || 'medium'
    this.thinkingMode =
      thinkingMode === 'adaptive' || thinkingMode === 'enabled' || thinkingMode === 'disabled'
        ? thinkingMode
        : 'adaptive'
    this.resumeSessionId = resumeSessionId
    this.resumeSessionAt = resumeSessionAt
    this.forkSession = !!forkSession && !!resumeSessionAt
    if (permissionMode) this.permissionMode = permissionMode
    if (model) this.model = model
    if (sandboxConfig) this.sandboxConfig = sandboxConfig
    this.sendStatus()

    // Slice C (ADR-033 cross-engine dispatch): seed durable dispatched-cost
    // rows unconditionally — a fresh session simply gets zero rows back, so
    // this is safe regardless of whether resumeSessionId is set.
    this.seedDispatchedCosts()

    // Resume seeding: the post-result reconciliation only runs after a turn
    // completes, so a RESUMED session's accumulators would otherwise sit at 0
    // until then — and the turn-start status-line emission (run()/dispatch)
    // would clobber the renderer's history-loaded statusLine with zeros (a
    // visible backwards jump at prompt-send). Seed once from the resume
    // target's transcript, async and non-blocking; the Math.max duration
    // guard inside makes a late-arriving seed safe even if a turn has already
    // started. Forks are excluded: the source transcript still contains the
    // post-anchor turns the fork truncates away, and the max() guard would
    // make that over-count permanent — a fork's fresh transcript reconciles
    // normally after its first result instead.
    if (this.resumeSessionId && !this.forkSession) {
      void this.reconcileAccumulatorsFromTranscript(
        this.transcriptPathFor(this.resumeSessionId),
        true
      )
    }
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  /** costBaseUsd + liveTotalCostUsd (see the field doc comment for the split). */
  private get totalCostUsd(): number {
    return this.costBaseUsd + this.liveTotalCostUsd
  }

  /** modelCostBase merged with liveModelCosts, summed per model id. */
  private get modelCosts(): ModelCostEntry[] {
    const merged = new Map<string, number>(this.modelCostBase)
    for (const [modelId, cost] of this.liveModelCosts) {
      merged.set(modelId, (merged.get(modelId) ?? 0) + cost)
    }
    return [...merged.entries()].map(([modelId, costUsd]) => ({
      engineId: 'claude' as const,
      modelId,
      costUsd
    }))
  }

  get status(): SessionStatus {
    // Resolve session.account from the auth provider probe + active accountId (ADR-021 / Phase 4).
    // The provider caches the cli.js init signal — no credential-file reads.
    const activeAccountId = this.resolveActiveAccountId()
    const account: AccountRef | null = claudeAuthProvider.buildAccountRef(activeAccountId)

    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.sessionId,
      model: this.model ? claudeModel(this.model) : null,
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      account,
      ...this.baseStatusFields()
    }
  }

  /** Resolve the active multi-account ID for the current session, if any. */
  private resolveActiveAccountId(): string | null {
    try {
      const st = accountManager.getState()
      return st.enabled ? st.activeId : null
    } catch {
      return null
    }
  }

  /** Get the SDK session UUID (available after first message exchange). */
  getSessionId(): string | null {
    return this.sessionId
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info(
          'ClaudeSession',
          `Idle timeout (${this.inactivityTimeoutMs / 60000} min) — auto-disconnecting`
        )
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  /** Slice C — re-emit the status line so a dispatched-cost update reaches the
   *  TopBar tooltip live (BaseSession.addDispatchedCost's hook). */
  protected override onDispatchedCostsChanged(): void {
    this.send('session:status-line', this.buildStatusLineFromAccumulators())
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    this.clearInactivityTimer()
    // A fresh run reactivates a session a prior cancel() retired — re-enable the
    // finally's status emit / idle-timer re-arm (see the `cancelled` field doc).
    this.cancelled = false

    // null prompt = spawn-only mode (for voice server, etc.)
    // Just ensure the SDK process is running without sending a message.
    const spawnOnly = prompt === null

    if (!spawnOnly) {
      // Only the idle→processing transition marks a new turn start. A queued
      // prompt sent while a turn is already in flight (run() called again
      // before the channel push above returns) must NOT reset the in-flight
      // turn's start time.
      const wasIdle = !this.isProcessing
      this.isProcessing = true
      this.wasInterrupted = false
      if (wasIdle) {
        this.turnStartedAtMs = Date.now()
      }
      this.sendStatus()
      if (wasIdle) {
        this.send('session:status-line', this.buildStatusLineFromAccumulators())
      }
    }

    // Build SDK message (skip if spawn-only)
    let sdkMessage: Record<string, unknown> | null = null
    if (!spawnOnly) {
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

      sdkMessage = {
        type: 'user' as const,
        session_id: this.sessionId || '',
        message: { role: 'user' as const, content },
        parent_tool_use_id: null
      }
    }

    if (this.messageChannel && !this.messageChannel.isEnded) {
      // Session already active — push message (or no-op for spawn-only)
      if (sdkMessage) {
        this.messageChannel.push(sdkMessage)
      } else {
        // hardening-6: run() cleared the idle timer above. A pushed message
        // starts a turn whose `result` re-arms it; a spawn-only run(null)
        // (voice server, etc.) starts nothing, so without this the timer stays
        // disarmed forever and the cli.js child is never reaped.
        this.resetInactivityTimer()
      }
      return
    }

    // H17: the channel exists but is ENDED — cancel() (user Stop, or an
    // idle-timeout auto-cancel firing as the user hit Enter) ended it, but the
    // run()-finally that nulls it hasn't executed yet. Pushing here would
    // silently vanish AFTER sendPrompt already broadcast session:user-message.
    // Fall through to the first-run branch to (re-)establish a fresh cli.js
    // process; the run()-finally of the superseded run is fenced by channel
    // identity below so it can't clobber this new run's state.

    // First run — start persistent session with streaming input mode.
    // Passing an AsyncIterable (instead of a string) keeps the CLI subprocess
    // alive so background agents can report back via task_notification.
    const channel = new MessageChannel<unknown>()
    this.messageChannel = channel
    if (sdkMessage) channel.push(sdkMessage)
    this.abortController = new AbortController()
    // Captured for the finally: `this.abortController`/`this.messageChannel` may
    // be REPLACED by a superseding run (H17 re-establish on an ended channel)
    // before this run's for-await unwinds. The finally aborts THIS run's own
    // controller and only touches the shared fields when they still point here.
    const myAbort = this.abortController
    const myChannel = channel

    // Reset the active-query promise for this run. ensureActiveQuery() awaits
    // it instead of polling. Rejection path fires on any failure before
    // sdkQuery() returns (e.g. missing cli.js).
    this.activeQueryPromise = new Promise<QueryHandle>((resolve, reject) => {
      this.resolveActiveQuery = resolve
      this.rejectActiveQuery = reject
    })

    // Collect stderr chunks so we can include them in error messages. Bounded
    // to the last STDERR_MAX_CHUNKS entries (see the push site) so a chatty
    // child can't grow this unbounded for the process lifetime.
    const STDERR_MAX_CHUNKS = 200
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
        logger.debug(
          'ClaudeSession',
          `Loaded ${Object.keys(this._mcpAllServers).length} MCP server(s): ${Object.keys(this._mcpAllServers).join(', ')}`
        )
      }
      if (this._mcpDisabledServers.size > 0) {
        logger.debug(
          'ClaudeSession',
          `Disabled MCP server(s) (from ~/.claude.json): ${[...this._mcpDisabledServers].join(', ')}`
        )
      }

      // Create in-process MCP servers for UI tools
      const uiMcpServer = createMermaidServer()
      const mockupMcpServer = createMockupServer(this.cwd)
      // Cross-engine dispatch (ADR-033): a SEPARATE server so dispatch_agent
      // does NOT ride the auto-allowed `mcp__claude-ui__` prefix — it goes
      // through canUseTool like an ordinary tool. Gated on the named
      // crossEngineDispatchAvailable('claude') capability (ADR-030/M4-A) —
      // same underlying check (opencode binary vendored) as before, but now
      // routed through the honest capability helper instead of a raw proxy.
      const collabServer = crossEngineDispatchAvailable('claude')
        ? createCollabServer({
            engineId: this.engineId,
            getRoutingId: () => this.routingId,
            cwd: this.cwd,
            getAutonomyMode: () => this.permissionMode,
            emit: (channel, data) => this.send(channel, data),
            addDispatchedCost: (engineId: EngineId, modelId: string, costUsd: number) =>
              this.addDispatchedCost(engineId, modelId, costUsd)
          })
        : null

      const q = sdkQuery({
        prompt: channel as AsyncIterable<never>,
        options: {
          ...execOpts,
          cwd: this.cwd,
          model: this.model,
          permissionMode: this.permissionMode as import('../sdk').PermissionMode,
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: `
## Mermaid Diagram Rendering
You have a \`mcp__claude-ui__render_mermaid\` tool that renders Mermaid.js diagrams as interactive SVGs in the chat UI. Use it when a visual diagram would help explain architecture, data flow, state machines, sequences, class relationships, or any visual concept. The tool validates syntax and returns errors if the diagram is malformed — fix the syntax and retry if that happens.

Parameters:
- \`source\` (required): Complete Mermaid diagram syntax
- \`title\` (optional): Caption shown on the diagram card

The diagram appears inline as a dedicated card with rendered SVG and source tabs.

## UI Mockup Preview
You have mockup tools for creating visual UI prototypes that render inline in the chat:

\`mcp__claude-ui-mockup__create_mockup\` — Create a new mockup. Writes HTML to a persistent directory on disk.
- \`html\` (required): HTML body content. Tailwind CSS is automatically available — use utility classes for all styling.
- \`title\` (optional): Title shown on the preview card.
- Returns a directory ID. Use the standard Edit tool on the returned file path for incremental changes.

\`mcp__claude-ui-mockup__show_mockup\` — Display a mockup from disk (useful to show a mockup created in a previous conversation).
- \`directory\` (required): The directory ID from create_mockup.

Workflow: create_mockup → Edit the HTML file for changes (the preview auto-refreshes on file change — no need to call show_mockup after edits).
The mockup appears as an interactive preview card with preview/code tabs and expand-to-panel support.${
              collabServer
                ? `

## Cross-Engine Agent Dispatch
You have a \`mcp__claude-ui-collab__dispatch_agent\` tool that delegates a task to an agent on a different engine (opencode, fronting non-Anthropic models such as GPT or Gemini). Useful when the user asks for another model's perspective (e.g. a second review of a diff). The result includes a session_id — pass it back to continue the same agent. The model list is user-configured; requires user approval per call.`
                : ''
            }`
          },
          ...(this.sandboxConfig?.enabled
            ? {
                sandbox: {
                  enabled: true,
                  autoAllowBashIfSandboxed: this.sandboxConfig.autoAllowBashIfSandboxed,
                  allowUnsandboxedCommands: this.sandboxConfig.allowUnsandboxedCommands,
                  excludedCommands: this.sandboxConfig.excludedCommands,
                  // Only pass network config when restrictions are needed.
                  // Omitting the network key entirely lets the SDK skip domain filtering,
                  // which is what "restrictNetwork: false" means.
                  ...(this.sandboxConfig.network.restrictNetwork
                    ? {
                        network: {
                          allowLocalBinding: this.sandboxConfig.network.allowLocalBinding,
                          allowedDomains: this.sandboxConfig.network.allowedDomains,
                          ...(this.sandboxConfig.network.allowManagedDomainsOnly
                            ? { allowManagedDomainsOnly: true }
                            : {}),
                          ...(this.sandboxConfig.network.allowAllUnixSockets
                            ? { allowAllUnixSockets: true }
                            : {}),
                          ...(this.sandboxConfig.network.allowUnixSockets.length > 0
                            ? { allowUnixSockets: this.sandboxConfig.network.allowUnixSockets }
                            : {})
                        }
                      }
                    : {
                        // No network restrictions — only pass through binding/socket options if set
                        ...(this.sandboxConfig.network.allowLocalBinding ||
                        this.sandboxConfig.network.allowAllUnixSockets ||
                        this.sandboxConfig.network.allowUnixSockets.length > 0
                          ? {
                              network: {
                                allowLocalBinding: this.sandboxConfig.network.allowLocalBinding,
                                ...(this.sandboxConfig.network.allowAllUnixSockets
                                  ? { allowAllUnixSockets: true }
                                  : {}),
                                ...(this.sandboxConfig.network.allowUnixSockets.length > 0
                                  ? {
                                      allowUnixSockets: this.sandboxConfig.network.allowUnixSockets
                                    }
                                  : {})
                              }
                            }
                          : {})
                      }),
                  filesystem: {
                    ...(this.sandboxConfig.filesystem.allowWrite.length > 0
                      ? { allowWrite: this.sandboxConfig.filesystem.allowWrite }
                      : {}),
                    ...(this.sandboxConfig.filesystem.denyWrite.length > 0
                      ? { denyWrite: this.sandboxConfig.filesystem.denyWrite }
                      : {}),
                    ...(this.sandboxConfig.filesystem.denyRead.length > 0
                      ? { denyRead: this.sandboxConfig.filesystem.denyRead }
                      : {})
                  }
                }
              }
            : {}),
          settingSources: ['user', 'project', 'local'],
          settings: {
            permissions: {
              allow: [`Edit(${this.cwd}/.claude/ui/**)`, `Write(${this.cwd}/.claude/ui/**)`]
            }
          },
          mcpServers: {
            ...(this._mcpAllServers as Record<string, never>),
            'claude-ui': uiMcpServer as never,
            'claude-ui-mockup': mockupMcpServer as never,
            // Deliberately NOT in allowedTools and NOT auto-allowed in
            // canUseTool — dispatch_agent must hit the normal approval path.
            ...((collabServer ? { 'claude-ui-collab': collabServer } : {}) as Record<
              string,
              never
            >)
          },
          allowedTools: ['mcp__claude-ui__*', 'mcp__claude-ui-mockup__*'],
          abortController: this.abortController,
          includePartialMessages: true,
          thinking: this.buildThinkingConfig(),
          effort: this.effort as 'low' | 'medium' | 'high',
          stderr: (chunk) => {
            const text = chunk.toString().trim()
            if (text) {
              // Route Voice:Patch logs to debug instead of error
              for (const line of text.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed) continue
                if (trimmed.includes('[Voice:Patch]')) {
                  logger.debug('Voice', trimmed)
                } else {
                  logger.error('SDK', `stderr: ${trimmed}`)
                }
              }
              stderrChunks.push(text)
              // Bound retention: only the last handful is ever surfaced (error
              // display slices -30/-20). A chatty child would otherwise grow
              // this array for the whole process lifetime. 200 keeps ample
              // crash-diagnostic context while capping memory.
              if (stderrChunks.length > STDERR_MAX_CHUNKS) {
                stderrChunks.splice(0, stderrChunks.length - STDERR_MAX_CHUNKS)
              }
            }
          },
          // Resume precedence: once cli.js has minted a stable sessionId
          // (post-init), always resume THAT — critical for forks, where the
          // new branch's id differs from the source we resumed/truncated from.
          // Before init, fall back to the requested resume target (the source
          // session for a fork, or self for a plain historical resume).
          ...(this.sessionId
            ? { resume: this.sessionId }
            : this.resumeSessionId
              ? { resume: this.resumeSessionId }
              : {}),
          // Fork truncation applies only on the FIRST run, against the source
          // transcript. After init, sessionId is set and we resume the new
          // branch in place — no re-fork, no re-truncate.
          ...(this.forkSession && this.resumeSessionAt && !this.sessionId
            ? { resumeSessionAt: this.resumeSessionAt, forkSession: true }
            : {}),
          canUseTool: async (toolName, input, opts) => {
            // Auto-allow our in-process UI tools (mermaid, etc.) — no user approval needed
            if (toolName.startsWith('mcp__claude-ui__')) {
              return { behavior: 'allow' as const, updatedInput: input }
            }

            // --- Local auto mode: classify tool calls instead of prompting user ---
            if (this.permissionMode === 'localAuto') {
              // Fast path: safe tools are always allowed
              if (isSafeTool(toolName)) {
                logger.debug('AutoClassifier', `Fast-path allow: ${toolName}`)
                return { behavior: 'allow' as const, updatedInput: input }
              }

              try {
                const transcriptMsgs: TranscriptMessage[] = this.messageHistory.map((m) => ({
                  role: m.role,
                  content: m.content.map((b) => ({
                    type: b.type,
                    ...('text' in b ? { text: b.text } : {}),
                    ...('toolName' in b ? { toolName: b.toolName, toolInput: b.toolInput } : {}),
                    ...('toolResult' in b ? { toolResult: b.toolResult } : {})
                  }))
                }))
                const transcript = buildTranscript(transcriptMsgs)

                const classifier = getClassifier(this.routingId)
                const result = await classifier.classify(toolName, input, transcript)

                logger.debug(
                  'AutoClassifier',
                  `${result.shouldBlock ? 'BLOCK' : 'ALLOW'} ${toolName}: ${result.reason}`
                )

                if (!result.shouldBlock) {
                  return { behavior: 'allow' as const, updatedInput: input }
                }

                // Blocked — notify UI and deny
                return { behavior: 'deny' as const, message: `Auto mode blocked: ${result.reason}` }
              } catch (err) {
                // Classifier failed — fall through to manual approval
                logger.warn(
                  'AutoClassifier',
                  `Classifier failed for ${toolName}, falling back to manual approval: ${err}`
                )
              }
            }

            // A cancel/interrupt during the await above (the localAuto
            // classifier), or one racing this callback's entry, may have ALREADY
            // fired opts.signal's 'abort'. The listener added below only fires on
            // a FUTURE abort, so without this pre-check the approval promise would
            // hang forever and its card would linger in the UI. Bail before we
            // even surface a request.
            if (opts.signal.aborted) {
              return { behavior: 'deny' as const, message: 'Cancelled' }
            }

            const requestId = uuid()
            const approval: PendingApproval = {
              requestId,
              // Forward cli.js's tool_use_id so the renderer can bind this
              // approval to a specific tool_use block rather than matching
              // by toolName+input signature (which collapses repeated
              // identical calls and shows the prompt on every old card).
              toolUseId: opts.toolUseId,
              toolName,
              input,
              suggestions: opts.suggestions as PendingApproval['suggestions'],
              decisionReason: opts.decisionReason,
              blockedPath: opts.blockedPath
            }
            this.send('session:approval-request', approval)

            const { decision, answers, updatedPermissions } = await new Promise<ApprovalResult>(
              (resolve) => {
                this.pendingApprovals.set(requestId, { resolve })

                opts.signal.addEventListener(
                  'abort',
                  () => {
                    this.pendingApprovals.delete(requestId)
                    resolve({ decision: 'deny' })
                  },
                  { once: true }
                )
              }
            )

            this.pendingApprovals.delete(requestId)

            if (decision === 'allow') {
              const updatedInput = answers ? { ...input, answers } : input
              // updatedPermissions originates from SDK suggestions and round-trips
              // through IPC with loose string types — cast back to SDK's union types
              return {
                behavior: 'allow' as const,
                updatedInput,
                ...(updatedPermissions?.length
                  ? {
                      updatedPermissions:
                        updatedPermissions as unknown as import('../sdk').PermissionUpdate[]
                    }
                  : {})
              }
            }
            const message = answers?.feedback || 'User denied'
            return { behavior: 'deny' as const, message }
          }
        }
      })

      this.activeQuery = q
      this.resolveActiveQuery?.(q)
      this.resolveActiveQuery = null
      this.rejectActiveQuery = null

      // Drive the proactive sign-in banner (ADR-014) from the initialize
      // response's `account`. NOT from the system/init `apiKeySource`: that
      // reports the *API-key* source, which is legitimately "none" for every
      // logged-in *subscription* (OAuth-token) user — using it as a login signal
      // falsely flags subscribers as logged out. A present `account.email` is the
      // reliable "logged in" signal; absent = show the banner.
      void q
        .initializationResult()
        .then((init) => {
          const account = (init as Record<string, unknown>)?.account as
            | Record<string, unknown>
            | undefined
          // `account.email` present = logged in (subscription or API key). A
          // logged-out cli.js returns an account with no email (tokenSource
          // "none"); an expired-but-cached login still has an email — that 401s
          // on send and is handled by the reactive auth card, not this banner.
          const loggedIn = !!(account && account.email)
          const authSource = loggedIn ? 'authenticated' : 'none'

          // Update the ClaudeAuthProvider probe cache from the cli.js init signal.
          // This is the ONLY source of auth detection — no credential-file reads
          // (preserves ADR-014 Keychain-prompt avoidance).
          const oauthAccount = account
            ? {
                email: (account.email as string | null) ?? null,
                organization: (account.organization as string | null) ?? null,
                subscriptionType: (account.subscriptionType as string | null) ?? null,
                tokenSource: (account.tokenSource as string | null) ?? null,
                apiKeySource: (account.apiKeySource as string | null) ?? null,
                apiProvider: (account.apiProvider as string | null) ?? null
              }
            : null
          claudeAuthProvider.updateAuthSource(authSource, oauthAccount)

          this.send('session:auth-source', authSource)
          // Re-emit status with the freshly-resolved account field.
          this.sendStatus()
        })
        .catch(() => {
          /* leave banner state unchanged on init-result failure */
        })

      for await (const message of q) {
        if (!message || typeof message !== 'object') continue
        await this.dispatchMessage(message as SDKMessage, stderrChunks)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      const stderrContext =
        stderrChunks.length > 0 ? `\nCollected stderr:\n${stderrChunks.join('\n')}` : ''
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
      // A superseding run (H17 re-establish, or a same-object respawn) has
      // already swapped in a fresh channel/controller/query when this no longer
      // holds. In that case this run's teardown must touch ONLY its own child,
      // never the shared fields the new run now owns.
      const superseded = this.messageChannel !== myChannel

      // H16: guarantee THIS run's cli.js child is torn down. If the for-await
      // above exited via a next() rejection, IteratorClose (the handle's
      // return()/killChild) is skipped — abort this run's OWN controller
      // (captured locally) to fire killChild. Idempotent on the normal exit
      // path (child already exited, abort listener already removed) and when
      // cancel() already aborted it.
      myAbort.abort()

      if (!superseded) {
        this.messageChannel?.end()
        this.messageChannel = null
        // Reject any in-flight ensureActiveQuery() awaits so callers don't
        // hang forever on a session that never produced a handle.
        this.rejectActiveQuery?.(new Error('Session ended before query handle was produced'))
        this.resolveActiveQuery = null
        this.rejectActiveQuery = null
        this.activeQueryPromise = null
        this.activeQuery = null
        this.abortController = null
        this.isProcessing = false
        this.turnStartedAtMs = null
      }
      // Respawn-boundary fold (Slice B): a ClaudeSession object CAN spawn
      // cli.js more than once — messageChannel is now null, so the NEXT
      // run() call on this same object takes the "first run" branch again and
      // spawns a fresh process that resumes via `this.sessionId`. That fresh
      // process's modelUsage/total_cost_usd start their cumulative counting
      // over from zero (verified wire fact), so whatever the live overlay held
      // for the process that just ended must be folded into the base now —
      // otherwise the next process's first `result` would REPLACE (not add to)
      // a live overlay that's about to reset, silently dropping this session's
      // cost so far. Folding is a no-op for the externally-visible total
      // (costBaseUsd + liveTotalCostUsd is unchanged by moving value between
      // the two), so this never causes a visible jump — it just protects the
      // next spawn.
      this.costBaseUsd += this.liveTotalCostUsd
      for (const [modelId, cost] of this.liveModelCosts) {
        this.modelCostBase.set(modelId, (this.modelCostBase.get(modelId) ?? 0) + cost)
      }
      this.liveTotalCostUsd = 0
      this.liveModelCosts.clear()
      // M-CL3 / H17: only the run that still owns the shared state may emit
      // status + re-arm the idle timer. A run superseded by a same-object
      // re-establish must leave the new run's status/timer alone; a DISPOSED
      // object (replaced under its routingId) must never emit on the shared
      // routingId or re-arm a timer whose later cancel() would tear down the
      // LIVE session that now owns that routingId.
      if (!superseded && !this.disposed && !this.cancelled) {
        this.sendStatus()
        this.resetInactivityTimer()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message dispatch
  //
  // Split out from the giant for-await switch so each inbound message
  // `type` has a dedicated named method. Behavior is intentionally identical
  // to the inline switch it replaced — nothing here introduces new logic.
  // The dispatch is unmistakably transport-level (message `type`) so every
  // branch stays small and focused on a single wire event.
  // ---------------------------------------------------------------------------

  /** Route a single CLI stream-json message to the appropriate handler.
   *  The `SDKMessage` union is keyed on `type`, so each `case` below
   *  narrows the branch to the matching variant without hand-casting. */
  private async dispatchMessage(msg: SDKMessage, stderrChunks: string[]): Promise<void> {
    const type = msg.type

    // Session-wide bootstrap: capture session_id / slug / init payload.
    // These run regardless of the per-type handler because the first message
    // can arrive under any `type` that includes session_id.
    this.captureSessionBootstrap(msg, type)

    // Any assistant or stream content means we're processing a turn. Covers
    // the queued-prompt case: a second prompt pushed onto the message channel
    // while the first was in flight doesn't get its own run() turn-start (the
    // channel push already happened), so this is where its turn actually
    // starts once cli.js begins working on it.
    if ((type === 'assistant' || type === 'stream_event') && !this.isProcessing) {
      this.isProcessing = true
      this.turnStartedAtMs = Date.now()
      this.sendStatus()
      this.send('session:status-line', this.buildStatusLineFromAccumulators())
    }

    switch (msg.type) {
      case 'assistant':
        this.handleAssistantMessage(msg)
        return
      case 'user':
        await this.handleUserMessage(msg)
        return
      case 'stream_event':
        this.handleStreamEvent(msg)
        return
      case 'tool_progress':
        this.handleToolProgress(msg)
        return
      case 'system':
        this.handleSystemMessage(msg)
        return
      case 'control_response':
        // NOTE: currently unreachable. sdk/query.ts's handleInbound consumes
        // every `control_response` via ControlChannel.handleResponse and returns
        // before pushing to the queue, so dispatchMessage never sees one — the
        // session:error surfacing in handleControlResponse cannot fire from here.
        // Control errors DO surface as rejections of the specific awaited control
        // request. Making the generic surfacing fire would need a control-error
        // hook exposed from the SDK layer (sdk/control.ts); left in place as a
        // forward-compat safety net if query.ts ever routes these up.
        this.handleControlResponse(msg)
        return
      case 'request_usage':
        this.logRequestUsage(msg)
        return
      case 'rate_limit_event':
        this.handleRateLimitEvent(msg)
        return
      case 'bash_output':
        this.handleBashOutput(msg)
        return
      case 'result':
        this.handleResultMessage(msg, stderrChunks)
        return
      default:
        // Unknown top-level type. Swallow — forward-compat; if it matters the
        // wire log has it. Logging here would spam on newly-added stream
        // types; use DEBUG_SDK=1 on the SDK side to surface those.
        return
    }
  }

  /**
   * Extract session_id, init metadata (slash commands, skills, mcp_servers,
   * permissionMode), and slug from whichever message carries them first.
   * cli.js always includes session_id on the first system/init, but other
   * messages may arrive with it too depending on the flow.
   */
  private captureSessionBootstrap(msg: SDKMessage, type: string): void {
    if (msg.session_id && !this.sessionId) {
      this.sessionId = msg.session_id

      if (type === 'system' && (msg as SystemMessage).subtype === 'init') {
        const sys = msg as SystemMessage
        // Resolved canonical model id (e.g. "default" → "claude-opus-4-8"),
        // used to size the context window when this.model is an alias.
        if (sys.model) this.resolvedModelId = sys.model
        // CLI-only commands that produce no output through the SDK
        const CLI_ONLY = new Set(['context', 'cost', 'login', 'logout', 'release-notes', 'doctor'])
        const raw = sys.slash_commands || []
        const slashCommands = raw
          .filter((name) => !CLI_ONLY.has(name))
          .map((name) => ({ name: name.startsWith('/') ? name : '/' + name }))
        this.send('session:slash-commands', slashCommands)
        saveSlashCommands(slashCommands)

        const skillNames = sys.skills || []
        this.send('session:skills', skillNames)

        const mcpServers = sys.mcp_servers || []
        this._initMcpServers = mcpServers
        logger.debug(
          'ClaudeSession',
          `init mcp_servers (${mcpServers.length}): ${JSON.stringify(mcpServers).slice(0, 500)}`
        )
        if (mcpServers.length > 0) {
          this.send('session:mcp-servers', mcpServers)
        }

        // Sync permission mode from init — the CLI may have rejected the
        // requested mode (e.g. auto-mode gate/model check failed) and fallen
        // back to default. Don't overwrite localAuto — SDK runs as acceptEdits
        // underneath.
        const initMode = sys.permissionMode
        if (initMode && initMode !== this.permissionMode && this.permissionMode !== 'localAuto') {
          this.permissionMode = initMode
          this.send('session:permission-mode', initMode)
        }
      }

      this.sendStatus()
    }

    if (msg.slug && !this.slug) {
      this.slug = msg.slug
    }
  }

  private handleAssistantMessage(msg: AssistantMessage): void {
    const parentToolUseId = msg.parent_tool_use_id ?? undefined
    const isSidechain = !!parentToolUseId

    // cli.js surfaces API failures (401/auth, rate_limit, overloaded, …) as a
    // synthetic "assistant" frame. On disk the frame is flagged
    // `isApiErrorMessage`, but the SDK stdout frame omits that field and instead
    // carries a top-level `error` code (e.g. "authentication_failed"); the
    // benign "No response requested." synthetic message has no `error`, so the
    // field's presence is the reliable live discriminator. We emit a structured
    // `api_error` block (matching history-reload rendering and giving the auth
    // variant its Login action) instead of plain text. Main channel only —
    // subagent errors fall through to the normal text path. See ADR-014.
    const isApiErrorFrame = msg.isApiErrorMessage === true || typeof msg.error === 'string'
    if (isApiErrorFrame && !parentToolUseId) {
      const errMsg = this.transformApiErrorMessage(msg)
      if (errMsg) {
        this.upsertMessage(errMsg)
        this.send('session:message', errMsg)
        return
      }
    }

    const chatMsg = transformAssistantMessage(msg)

    // Accumulate usage from every assistant message (main + sidechain)
    const hadUsage = this.accumulateUsage(msg, isSidechain)

    if (chatMsg) {
      if (parentToolUseId) {
        this.send('session:subagent-message', { toolUseId: parentToolUseId, message: chatMsg })
      } else {
        if (typeof msg.uuid === 'string') {
          this.wireUuidToMessageId.set(msg.uuid.slice(0, RETRACTION_UUID_PREFIX_LEN), chatMsg.id)
        }
        this.upsertMessage(chatMsg)
        this.send('session:message', chatMsg)
        // Only update status line when usage actually changed (final message per API call)
        if (hadUsage) this.scheduleStatusLineUpdate()
      }
    }
  }

  private handleStreamEvent(msg: StreamEventMessage): void {
    const routingId = msg.parent_tool_use_id ?? undefined
    const event = msg.event
    if (!event || event.type !== 'content_block_delta') return

    const delta = event.delta
    if (!delta) return

    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      if (routingId) {
        this.send('session:subagent-stream', {
          toolUseId: routingId,
          type: 'text',
          text: delta.text
        })
      } else {
        this.send('session:stream', { type: 'text', text: delta.text })
      }
      return
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      if (routingId) {
        this.send('session:subagent-stream', {
          toolUseId: routingId,
          type: 'thinking',
          text: delta.thinking
        })
      } else {
        this.send('session:stream', { type: 'thinking', text: delta.thinking })
      }
    }
  }

  private handleToolProgress(msg: ToolProgressMessage): void {
    this.send('session:task-progress', {
      toolUseId: msg.tool_use_id || '',
      toolName: msg.tool_name || '',
      parentToolUseId: msg.parent_tool_use_id ?? null,
      elapsedTimeSeconds: msg.elapsed_time_seconds || 0
    })
  }

  private handleSystemMessage(msg: SystemMessage): void {
    if (msg.subtype === 'status') {
      // Don't overwrite localAuto — SDK runs as acceptEdits underneath.
      const newMode = msg.permissionMode
      if (newMode && newMode !== this.permissionMode && this.permissionMode !== 'localAuto') {
        this.permissionMode = newMode
        this.send('session:permission-mode', newMode)
      }
      return
    }
    if (msg.subtype === 'task_notification') {
      this.handleTaskNotification(msg)
      return
    }
    if (msg.subtype === 'task_started') {
      this.handleTaskStarted(msg)
      return
    }
    if (msg.subtype === 'task_updated') {
      this.handleTaskUpdated(msg)
      return
    }
    if (msg.subtype === 'queued_command_consumed') {
      this.send('session:steer-consumed', { prompt: msg.prompt || '' })
      return
    }
    if (msg.subtype === 'model_refusal_fallback' || msg.subtype === 'model_fallback') {
      this.handleModelFallback(msg)
      return
    }
    // Unknown / init / compact_boundary — init is already consumed in
    // captureSessionBootstrap; compact_boundary is informational and not
    // currently surfaced. Fall through silently.
  }

  /**
   * The CLI silently swapped models mid-session: `model_refusal_fallback`
   * (safety refusal → permanent swap for the session) or `model_fallback`
   * (availability error → swap for this turn only). Surface it as a warning
   * banner so the user knows which model is actually answering — without this,
   * the only trace is the `model` field on subsequent assistant messages.
   * Shapes in docs/protocol/04-system-subtypes.md §4.20–4.21.
   */
  private handleModelFallback(msg: SystemMessage): void {
    const fallbackText =
      msg.subtype === 'model_refusal_fallback'
        ? `${msg.original_model || 'The model'} refused this request — switched to ${msg.fallback_model || 'a fallback model'} for the rest of the session.`
        : `${msg.original_model || 'The model'} is unavailable — using ${msg.fallback_model || 'a fallback model'} for this turn.`
    const text = msg.content || fallbackText
    logger.warn(
      'ClaudeSession',
      `${msg.subtype}: ${msg.original_model} -> ${msg.fallback_model} (trigger=${msg.trigger})`
    )
    this.send('session:warning', text)

    // Refusal retraction: evict the refused partial (and its tombstoned tool
    // results) from transcript state. Unknown uuids are a no-op per protocol.
    // Sent even when nothing resolves — the renderer also clears any streamed
    // partial text the retracted message left behind.
    if (msg.subtype === 'model_refusal_fallback') {
      const retracted = msg.retracted_message_uuids ?? []
      const messageIds = [
        ...new Set(
          retracted
            .map((u) => this.wireUuidToMessageId.get(u.slice(0, RETRACTION_UUID_PREFIX_LEN)))
            .filter((id): id is string => !!id)
        )
      ]
      if (messageIds.length > 0) {
        this.messageHistory = this.messageHistory.filter((m) => !messageIds.includes(m.id))
      }
      this.send('session:messages-retracted', { messageIds })
    }
  }

  /**
   * `task_started` is emitted the moment cli.js spawns a background Bash or
   * Agent task — BEFORE the corresponding tool_result arrives. It carries
   * task_id ↔ tool_use_id directly, so we can register the mapping early and
   * stop depending on the regex-extraction inside detectTaskMapping for the
   * notification plumbing. (We still need detectTaskMapping for the output
   * file path, which only ships in tool_result.)
   */
  private handleTaskStarted(msg: SystemMessage): void {
    const taskId = msg.task_id || ''
    const toolUseId = msg.tool_use_id || ''
    if (!taskId || !toolUseId) return
    this.taskIdMap.set(taskId, toolUseId)
  }

  /**
   * `task_updated` is the proactive completion signal for background Bash
   * and Agent tasks. cli.js emits it when the task's status transitions
   * (running → completed/killed/failed), and it arrives via `patch.status`.
   * Without handling this, the tool card stays stuck on "running" forever
   * even though the assistant can see the completed status via BashOutput.
   */
  private handleTaskUpdated(msg: SystemMessage): void {
    const taskId = msg.task_id || ''
    const patch = msg.patch
    if (!taskId || !patch || typeof patch.status !== 'string') return

    const status = patch.status
    // Only act on terminal states. Intermediate transitions (e.g. running →
    // backgrounded) don't imply completion and would wrongly dismiss the UI.
    if (status !== 'completed' && status !== 'killed' && status !== 'failed') return

    const toolUseId = this.taskIdMap.get(taskId) || null
    if (!toolUseId) return

    this.markBackgroundDone(toolUseId)
    this.taskIdMap.delete(taskId)

    // Normalize cli.js's "killed" to the SDK's "stopped" vocabulary so the
    // renderer's resolveToolVisualState treats it uniformly.
    const normalized: 'completed' | 'failed' | 'stopped' =
      status === 'killed' ? 'stopped' : (status as 'completed' | 'failed')

    this.send('session:task-notification', {
      taskId,
      toolUseId,
      status: normalized,
      outputFile: this.backgroundFilePaths.get(toolUseId) || '',
      summary: '',
      usage: undefined
    })
  }

  private handleTaskNotification(msg: SystemMessage): void {
    const taskId = msg.task_id || ''
    const outputFile = msg.output_file || ''
    const matchedToolUseId = this.taskIdMap.get(taskId) || null
    if (matchedToolUseId) {
      this.markBackgroundDone(matchedToolUseId)
      this.taskIdMap.delete(taskId)
    }

    // Extract usage from the patched system message (task-notification-usage patch)
    const rawUsage = msg.usage
    const usage = rawUsage
      ? {
          totalTokens: rawUsage.total_tokens || 0,
          toolUses: rawUsage.tool_uses || 0,
          durationMs: rawUsage.duration_ms || 0
        }
      : undefined

    this.send('session:task-notification', {
      taskId,
      toolUseId: matchedToolUseId,
      status: msg.status || 'completed',
      outputFile,
      summary: msg.summary || '',
      usage
    })
  }

  private handleControlResponse(msg: ControlResponseMessage): void {
    const response = msg.response
    if (!response || response.subtype !== 'error') return
    const errText =
      typeof response.error === 'string' ? response.error : JSON.stringify(response.error, null, 2)
    logger.error('ClaudeSession', `Control response error: ${errText}`)
    this.send('session:error', `SDK control error: ${errText}`)
  }

  private handleRateLimitEvent(msg: RateLimitEventMessage): void {
    // Real-time rate limit data from inference response headers — no extra
    // API call needed. The rate-limit-relay patch injects these after every
    // streaming API call.
    if (msg.header_utilization) {
      usageFetcher.updateFromHeaderUtilization(msg.header_utilization)
    }
  }

  private handleBashOutput(msg: BashOutputMessage): void {
    // Live bash output from the bash-output-streaming patch.
    const toolUseId = msg.tool_use_id || ''
    if (!toolUseId) return
    this.send('session:bash-output', {
      toolUseId,
      output: msg.output || '',
      totalLines: msg.total_lines || 0,
      totalBytes: msg.total_bytes || 0
    })
  }

  private handleResultMessage(msg: ResultMessage, stderrChunks: string[]): void {
    // total_cost_usd / modelUsage are CUMULATIVE WITHIN this cli.js process —
    // REPLACE the live overlay, never add (see the field doc comment on
    // liveTotalCostUsd/liveModelCosts for the full explanation of why `+=`
    // here was a real bug: turn N would re-add the whole running total).
    const cost = msg.total_cost_usd || 0
    this.liveTotalCostUsd = cost

    const modelUsage = msg.modelUsage
    if (modelUsage && typeof modelUsage === 'object') {
      const next = new Map<string, number>()
      for (const [modelId, usage] of Object.entries(modelUsage)) {
        const modelCost = typeof usage?.costUSD === 'number' ? usage.costUSD : 0
        next.set(modelId, modelCost)
      }
      this.liveModelCosts = next
    } else {
      // No per-model breakdown on this result — attribute the whole turn's
      // cost to the currently selected model rather than dropping it.
      this.liveModelCosts = new Map([[this.model, cost]])
    }

    this.isProcessing = false

    // NOTE (Phase 7): Claude usage_event rows are NOT recorded live here.
    // The streaming `usage` is cumulative-within-a-message and the JSONL is the
    // codebase's source of truth for Claude tokens (accInputTokens is overwritten
    // from computeTokenMetrics below). Claude usage_event rows come from the
    // Pass-2 reconciler (block-usage JSONL parse → insertUsageEvents per message,
    // source 'backfill', dedup by message_id) — authoritative + per-message.

    // Handle error results
    const subtype = msg.subtype
    if (subtype && subtype !== 'success') {
      // When the user clicked Stop, the SDK sends error results as it tears
      // down the interrupted turn. These aren't real failures — suppress.
      if (!this.wasInterrupted) {
        const errors = msg.errors || []
        const stderrContext =
          stderrChunks.length > 0 ? '\n\nCLI stderr:\n' + stderrChunks.slice(-20).join('\n') : ''
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

    // Accumulate duration from result — this turn just completed, so it's
    // no longer in flight (turnStartedAtMs → null) and its wall-clock cost
    // moves from the live "in flight" delta into the completed-turns total.
    const resultDurationMs = msg.duration_ms || 0
    const resultApiDurationMs = msg.duration_api_ms || 0
    this.accTotalDurationMs += resultDurationMs
    this.accTotalApiDurationMs += resultApiDurationMs
    this.turnStartedAtMs = null

    this.send('session:result', {
      totalCostUsd: this.totalCostUsd,
      durationMs: resultDurationMs,
      result: msg.result || '',
      sessionId: this.sessionId
    })
    this.sendStatus()
    this.resetInactivityTimer()

    // Cancel any pending debounced update — we'll send one immediately.
    if (this.statusLineTimer) {
      clearTimeout(this.statusLineTimer)
      this.statusLineTimer = null
    }

    // Send accumulator-based status line immediately so the UI updates
    // without waiting for the JSONL read (which may not be fully flushed yet).
    this.send('session:status-line', this.buildStatusLineFromAccumulators())
    this.sendMetering()

    // Then reconcile from JSONL with a delay to let the SDK flush. Only
    // overwrite accumulators if JSONL returns meaningful data.
    const logPath = this.getSessionLogPath()
    if (logPath) {
      setTimeout(() => {
        void this.reconcileAccumulatorsFromTranscript(logPath)

        // Phase 7 Pass 2 — near-live metering: now that the JSONL is flushed,
        // re-run the Claude reconciler so this turn's messages land in
        // usage_event (authoritative per-message parse, dedup by message_id).
        // Lazy import to avoid a static import cycle (usage-reconciler →
        // block-usage → claude-session). Best-effort; never breaks the turn.
        import('./usage-reconciler')
          .then(({ usageReconciler }) => usageReconciler.reconcileClaude())
          .catch(() => {})
      }, 500) // delay to let SDK flush JSONL to disk
    }
  }

  /**
   * Reconcile the in-memory accumulators from a transcript JSONL and re-emit
   * the status line. Shared by the post-result reconciliation (500ms after
   * each turn) and the one-time resume seeding at spawn — both need the same
   * rules:
   * - Skip when the transcript yields nothing (not flushed yet / missing).
   * - Token accumulators + context length are full replacements (the
   *   transcript is the source of truth for the whole session to date).
   * - totalDurationMs is a full reconstruction too (turn-span sums across
   *   every completed turn), but guarded with max() so a conservative read
   *   (e.g. JSONL not fully flushed) can never regress a value already shown
   *   — duration only ever moves forward.
   * - totalApiDurationMs has no transcript-reconstruction path (real
   *   transcripts carry no `result` lines, the only place duration_api_ms
   *   ever appeared), so the live accumulator is left untouched instead of
   *   being clobbered with the permanent 0 computeTokenMetrics returns.
   * - Emit from accumulators (not the raw metrics) so the guarded duration
   *   and preserved API duration actually reach the renderer.
   * - Cost is NEVER touched here unless `seedCost` is set — costBaseUsd /
   *   modelCostBase are seeded ONCE, at construction, from the resume target's
   *   transcript (the recompute path is only for seeding; a live session's
   *   cost comes from cli.js's authoritative `result` messages). The recurring
   *   post-result reconciliation (500ms after every turn) must NOT overwrite
   *   them with the same pricing-table recompute — that would clobber the
   *   authoritative live overlay with a less-precise historical estimate.
   * Best-effort: failures are logged, never thrown.
   */
  private async reconcileAccumulatorsFromTranscript(
    logPath: string,
    seedCost = false
  ): Promise<void> {
    try {
      const metrics = await computeTokenMetrics(logPath, this.model)
      if (metrics.totalTokens === 0 && metrics.totalCostUsd === 0) {
        // A resume seed that finds nothing is suspicious (the transcript we
        // are resuming from should have content) — say so instead of silently
        // no-opping. A wrong projectKey derivation hid behind this guard once.
        if (seedCost) {
          logger.warn('ClaudeSession', `Resume seed found no usable transcript at ${logPath}`)
        }
        return
      }
      this.accInputTokens = metrics.totalInputTokens
      this.accOutputTokens = metrics.totalOutputTokens
      this.accCachedTokens = metrics.cachedTokens
      this.accTotalDurationMs = Math.max(this.accTotalDurationMs, metrics.totalDurationMs)
      this.lastContextLength = metrics.contextWindowSize
      if (seedCost) {
        this.costBaseUsd = metrics.totalCostUsd
        this.modelCostBase = new Map((metrics.modelCosts ?? []).map((m) => [m.modelId, m.costUsd]))
      }
      this.send('session:status-line', this.buildStatusLineFromAccumulators())
      this.sendMetering()
    } catch (err) {
      logger.warn('ClaudeSession', 'JSONL reconciliation failed', err)
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    const previousMode = this.permissionMode

    // localAuto is our own mode — SDK runs as acceptEdits underneath
    if (mode === 'localAuto') {
      this.permissionMode = mode
      this.send('session:permission-mode', mode)
      if (this.activeQuery) {
        await this.activeQuery.setPermissionMode('acceptEdits')
      }
      return
    }

    this.permissionMode = mode
    this.send('session:permission-mode', mode)
    if (this.activeQuery) {
      try {
        // Caller (IPC boundary) ships mode as a plain string; trust the SDK
        // layer to validate against cli.js's permitted set.
        await this.activeQuery.setPermissionMode(mode as import('../sdk').PermissionMode)
      } catch (err) {
        if (mode === 'auto') {
          // SDK rejected auto mode (feature gate / model check) — fall back to local auto
          logger.debug('ClaudeSession', 'SDK rejected auto mode, falling back to localAuto')
          this.permissionMode = 'localAuto'
          this.send('session:permission-mode', 'localAuto')
          await this.activeQuery.setPermissionMode('acceptEdits')
          return
        }
        // Other mode changes that fail — revert to previous
        this.permissionMode = previousMode
        this.send('session:permission-mode', previousMode)
        throw err
      }
    }
  }

  async setModel(model: string): Promise<void> {
    const previousModel = this.model
    this.model = model
    if (this.activeQuery) {
      try {
        await this.activeQuery.setModel(model)
      } catch (err) {
        // Revert on failure — leaving this.model on a model cli.js rejected
        // skews capabilities, context-window sizing and the cost fallback
        // against a model the session isn't actually running (setPermissionMode
        // reverts the same way). Re-emit so the renderer resyncs to the real
        // model, then propagate so the caller sees the failure.
        this.model = previousModel
        this.sendStatus()
        throw err
      }
    }
    // Re-emit status so capabilities (derived from model) are up to date in the renderer.
    this.sendStatus()
    // Recalculate status line with new context window size
    this.send('session:status-line', this.buildStatusLineFromAccumulators())
    this.sendMetering()
  }

  setEffort(effort: string): void {
    this.effort = effort
  }

  setThinkingMode(mode: string): void {
    if (mode === 'adaptive' || mode === 'enabled' || mode === 'disabled') {
      this.thinkingMode = mode
    }
  }

  /**
   * Build the SDK `thinking` option from the session's mode and current model.
   * Always requests `display: 'summarized'` so Opus 4.7+ surfaces reasoning text;
   * the field is silently ignored on models that don't honour it.
   *
   * `adaptive` is auto-coerced to `enabled` when the model lacks adaptive support
   * (older models would otherwise reject the request).
   */
  private buildThinkingConfig():
    | { type: 'adaptive'; display: 'summarized' }
    | { type: 'enabled'; display: 'summarized' }
    | { type: 'disabled' } {
    const resolved: ThinkingMode = resolveThinkingMode(this.model, this.thinkingMode)
    if (resolved === 'disabled') return { type: 'disabled' }
    if (resolved === 'adaptive') return { type: 'adaptive', display: 'summarized' }
    return { type: 'enabled', display: 'summarized' }
  }

  async dequeueMessage(value: string): Promise<{ removed: number }> {
    if (!this.activeQuery) return { removed: 0 }
    return await this.activeQuery.dequeueMessage(value)
  }

  async askSideQuestion(question: string): Promise<string | null> {
    if (!this.activeQuery) return null
    return await this.activeQuery.askSideQuestion(question)
  }

  // ---------------------------------------------------------------------------
  // Voice input
  // ---------------------------------------------------------------------------

  /**
   * Ensure the SDK process is running so control messages can be sent.
   * Calls run(null) which spawns the CLI without sending any prompt —
   * zero API tokens consumed. The CLI loads settings/MCP and waits for
   * input. When a real message is sent later, run() finds the existing
   * channel and just pushes into it.
   */
  private async ensureActiveQuery(): Promise<void> {
    if (this.activeQuery) return
    // Fire-and-forget — run(null) spawns the SDK and drains in background.
    // The run() bootstrap creates activeQueryPromise synchronously before
    // awaiting anything, so we can grab it right after the call.
    this.run(null)
    const pending = this.activeQueryPromise
    if (!pending) throw new Error('SDK session did not initialize a query promise')
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for SDK session to start')), 15_000)
    )
    await Promise.race([pending, deadline])
  }

  /**
   * Start the voice server inside cli.js. Returns the TCP port for audio streaming.
   */
  async voiceStartServer(): Promise<{ port: number }> {
    if (this.voiceServerPort) {
      return { port: this.voiceServerPort }
    }
    await this.ensureActiveQuery()
    const result = await this.activeQuery!.voiceServerStart()
    this.voiceServerPort = result.port
    logger.info('ClaudeSession', `Voice server started on port ${result.port}`)
    return result
  }

  /** Stop the voice server inside cli.js. */
  async voiceStopServer(): Promise<void> {
    if (!this.activeQuery || !this.voiceServerPort) return
    try {
      await this.activeQuery.voiceServerStop()
    } catch (err) {
      logger.warn('ClaudeSession', 'voiceServerStop failed', err)
    }
    if (this.voiceClient) {
      this.voiceClient.destroy()
      this.voiceClient = null
    }
    this.voiceServerPort = null
    logger.info('ClaudeSession', 'Voice server stopped')
  }

  /** Start a voice recording session. */
  async voiceStartRecording(language: string): Promise<void> {
    // Start native audio capture IMMEDIATELY so we don't lose the first
    // seconds of speech while the SDK spawns and the voice server starts.
    const earlyBuffer: Buffer[] = []
    let earlyCaptureStopped = false
    const captureStarted = startRecording((chunk) => {
      if (!earlyCaptureStopped) earlyBuffer.push(chunk)
    })
    if (!captureStarted) {
      this.send('voice:error', 'Failed to start audio capture. Check microphone access.')
      return
    }
    // Notify renderer we're connecting (audio is flowing, just buffering)
    this.win.webContents.send('voice:state', this.routingId, 'connecting')

    try {
      // Ensure voice server is running (may spawn SDK + create TCP server)
      if (!this.voiceServerPort) {
        const result = await this.voiceStartServer()
        if (!result.port) {
          throw new Error('Voice server failed to return a port')
        }
      }

      const port = this.voiceServerPort!
      if (!this.voiceClient) {
        this.voiceClient = new VoiceClient(port, this.win, this.routingId)
      } else {
        this.voiceClient.updatePort(port)
      }

      // Hand off early buffer and start streaming through VoiceClient
      earlyCaptureStopped = true
      await this.voiceClient.startRecording(language, earlyBuffer)
    } catch (err) {
      earlyCaptureStopped = true
      stopRecording()
      this.win.webContents.send('voice:state', this.routingId, 'idle')
      throw err
    }
  }

  /** Stop the current voice recording session. */
  async voiceStopRecording(): Promise<void> {
    if (!this.voiceClient) {
      // If voiceClient never started (still in early capture), just stop recording
      stopRecording()
      this.win.webContents.send('voice:state', this.routingId, 'idle')
      return
    }
    await this.voiceClient.stopRecording()
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
      logger.debug(
        'ClaudeSession',
        'mcpServerStatus: no activeQuery, returning cached init servers'
      )
      return this._initMcpServers
    }
    try {
      const result = await this.activeQuery.mcpServerStatus()
      // Log each server's name and status for debugging
      const summary = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>).map((s) => `${s.name}:${s.status}`).join(', ')
        : 'not-array'
      logger.debug(
        'ClaudeSession',
        `mcpServerStatus: ${Array.isArray(result) ? result.length : 0} servers → [${summary}]`
      )
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
      logger.error(
        'ClaudeSession',
        `mcpToggle BUG: enabled=${enabled} but ${serverName} is still in disabledMcpServers!`
      )
    }
    if (!enabled && !postDis.includes(serverName)) {
      logger.error(
        'ClaudeSession',
        `mcpToggle BUG: enabled=${enabled} but ${serverName} is NOT in disabledMcpServers!`
      )
    }

    // Also query status to see the SDK's view
    try {
      const status = await this.activeQuery.mcpServerStatus()
      const summary = Array.isArray(status)
        ? (status as Array<Record<string, unknown>>).map((s) => `${s.name}:${s.status}`).join(', ')
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
        ? (status as Array<Record<string, unknown>>).map((s) => `${s.name}:${s.status}`).join(', ')
        : 'not-array'
      logger.debug('ClaudeSession', `mcpReconnect POST-STATUS: [${summary}]`)
    } catch {
      // Non-critical
    }
  }

  async mcpSetServers(servers: Record<string, unknown>): Promise<unknown> {
    if (!this.activeQuery) throw new Error('No active session')
    logger.debug('ClaudeSession', `mcpSetServers: setting [${Object.keys(servers).join(', ')}]`)
    // IPC-bounded caller hands us a permissive Record — the shared
    // McpServerConfig is a loose bag, the SDK layer uses a discriminated
    // union. Trust the SDK's splitMcpServers() + cli.js to validate.
    const result = await this.activeQuery.setMcpServers(
      servers as unknown as Parameters<QueryHandle['setMcpServers']>[0]
    )
    logger.debug('ClaudeSession', `mcpSetServers result: ${JSON.stringify(result).slice(0, 500)}`)
    return result
  }

  /** ISession.discoverSkills — Claude scans project/user/plugin skill dirs. */
  discoverSkills(cwd: string): Promise<import('../../shared/types').SkillInfo[]> {
    return scanSkills(cwd)
  }

  /**
   * Log per-request usage data from the request-usage patch to a JSONL file.
   * Each line captures the token breakdown for a single API call, enabling
   * analysis of cache effectiveness and rate-limit cost drivers.
   */
  private logRequestUsage(msg: Record<string, unknown>): void {
    try {
      const logDir = path.join(os.homedir(), '.claude', 'ui', 'usage')
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
      const logPath = path.join(logDir, 'request-usage.jsonl')

      const usage = msg.usage as Record<string, unknown> | undefined
      if (!usage) return

      const entry = {
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        model: (msg.model as string) || this.model || 'unknown',
        usage,
        cwd: this.cwd
      }

      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
    } catch (err) {
      logger.warn('ClaudeSession', `Failed to log request_usage: ${err}`)
    }
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

  /** Context window size based on the currently selected model. The `default`
   *  alias is resolved server-side by cli.js, so its real window is only known
   *  from the canonical id reported in system/init — prefer that when present. */
  private get contextWindowSize(): number {
    const effectiveModel =
      this.model === 'default' && this.resolvedModelId ? this.resolvedModelId : this.model
    return getContextWindowSize(effectiveModel)
  }

  /** Build StatusLineData from in-memory accumulators (zero I/O) */
  private buildStatusLineFromAccumulators(): import('../../shared/types').StatusLineData {
    const ctxWindow = this.contextWindowSize
    const usedPct =
      this.lastContextLength > 0 ? Math.round((this.lastContextLength / ctxWindow) * 100) : null
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
      remainingPercentage: usedPct !== null ? 100 - usedPct : null,
      turnStartedAtMs: this.turnStartedAtMs,
      modelCosts: [...this.modelCosts, ...this.dispatchedCostEntries()]
    }
  }

  /**
   * Build the engine-neutral MeteringSnapshot (Phase 7 Pass 2). Emitted
   * ALONGSIDE StatusLineData — additive, never replaces it. equivalentCostUsd
   * comes from the internal pricing table over the accumulator tokens (the cache
   * split isn't available live, so cacheRead carries the combined cache figure
   * and cacheWrite is 0 — best-effort live metric; the dashboard is the
   * authoritative cost source). window + projection are subscription-gated.
   */
  private buildMeteringSnapshot(): import('../../shared/types').MeteringSnapshot {
    const effectiveModel =
      this.model === 'default' && this.resolvedModelId ? this.resolvedModelId : this.model
    const account = claudeAuthProvider.buildAccountRef(this.resolveActiveAccountId())
    const billingType = account?.billingType ?? 'unknown'

    const tokens = {
      input: this.accInputTokens,
      output: this.accOutputTokens,
      cacheWrite: 0,
      cacheRead: this.accCachedTokens,
      total: this.accInputTokens + this.accOutputTokens + this.accCachedTokens
    }
    const equiv = equivalentCostUsd('anthropic', effectiveModel, {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: tokens.cacheRead
    })

    const snapshot: import('../../shared/types').MeteringSnapshot = {
      engineId: 'claude',
      vendorId: 'anthropic',
      billingType,
      tokens,
      equivalentCostUsd: equiv,
      engineReportedCostUsd: this.totalCostUsd,
      contextWindow: { used: this.lastContextLength, size: this.contextWindowSize }
    }

    // Window is a subscription concept (foundation §7), gated behind a per-account
    // usage provider. Claude/anthropic + subscription → the provider yields the
    // window; apiKey/free/unknown → null (cumulative meter, no window).
    // (The WLS projection stays surfaced via the dashboard's BlockUsageData; it
    // is intentionally omitted here to avoid a block-usage↔claude-session import
    // cycle — the projection field is reserved for a later wiring.)
    const provider = resolveUsageProvider('claude', 'anthropic', billingType)
    const window = provider?.getWindow()
    if (window) {
      snapshot.window = { usedPercent: window.usedPercent, resetsAt: window.resetsAt }
    }

    return snapshot
  }

  /** Emit the metering snapshot. Swallows errors — advisory, never breaks flow. */
  private sendMetering(): void {
    try {
      this.send('session:metering', this.buildMeteringSnapshot())
    } catch {
      /* advisory */
    }
  }

  /** Throttled status line update from in-memory accumulators (zero I/O) */
  private scheduleStatusLineUpdate(): void {
    if (this.statusLineTimer) return // already scheduled
    this.statusLineTimer = setTimeout(() => {
      this.statusLineTimer = null
      this.send('session:status-line', this.buildStatusLineFromAccumulators())
      this.sendMetering()
    }, 50)
  }

  /** Transcript JSONL path for a given session id under this session's cwd.
   *  Project key derivation is the shared `cwdToProjectKey` (replaces EVERY
   *  non-alphanumeric char with '-', matching cli.js's on-disk naming) — the
   *  old inline `/`+`.`-only replace produced a nonexistent path for every
   *  Windows cwd (and any cwd with `_`/space), silently no-opping
   *  reconciliation and resume seeding. */
  private transcriptPathFor(sessionId: string): string {
    return path.join(
      os.homedir(),
      '.claude',
      'projects',
      cwdToProjectKey(this.cwd),
      `${sessionId}.jsonl`
    )
  }

  getSessionLogPath(): string | null {
    if (!this.sessionId) return null
    return this.transcriptPathFor(this.sessionId)
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
      const files = fs
        .readdirSync(plansDir)
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

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const entry = this.pendingApprovals.get(requestId)
    if (entry) {
      // cli.js's canUseTool only understands 'allow' | 'deny'. Coerce
      // 'allowForSession' to 'allow' so the ApprovalDecision union is handled
      // safely (opencode may produce it in Phase 5).
      const coerced: 'allow' | 'deny' = decision === 'allowForSession' ? 'allow' : decision
      entry.resolve({ decision: coerced, answers, updatedPermissions })
    }
  }

  cancel(): void {
    // Retire the object until the next run() — see the `cancelled` field doc.
    // Guards the dying run's finally from re-emitting `idle` over the
    // `disconnected` broadcast below and from re-arming the idle timer.
    this.cancelled = true

    // Deny all pending approvals
    for (const [, entry] of this.pendingApprovals) {
      entry.resolve({ decision: 'deny' })
    }
    this.pendingApprovals.clear()

    this.wasInterrupted = true
    this.clearInactivityTimer()
    this.stopAllBackgroundPollers()
    unwatchAllSubagents()

    // Tear down any cross-engine dispatch targets owned by this session (ADR-033).
    crossEngineDispatcher.disposeFor(this.routingId)

    // Clean up voice resources
    if (this.voiceClient) {
      this.voiceClient.destroy()
      this.voiceClient = null
    }
    this.voiceServerPort = null

    // Stop the auto-mode classifier session (if any)
    stopClassifier(this.routingId)

    // End the message channel before aborting so the SDK's streamInput
    // loop can unblock and the CLI subprocess exits cleanly
    this.messageChannel?.end()
    this.abortController?.abort()
    this.abortController = null
    this.isProcessing = false
    this.turnStartedAtMs = null
    // M-CL3: a dispose()-driven cancel (object replaced under its routingId)
    // must NOT broadcast disconnected on the shared routingId — the LIVE
    // replacement session now owns it and emits its own status. A normal
    // cancel() (user Stop / idle timeout, object stays usable) still surfaces
    // the disconnect.
    if (!this.disposed) {
      this.send('session:status', { ...this.status, state: 'disconnected' })
    }
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

  /**
   * Build a `system` ChatMessage carrying an `api_error` block from an
   * `isApiErrorMessage` assistant frame. Mirrors session-history.ts so live and
   * reloaded transcripts render identically. `errorType` of `'authentication'`
   * drives the renderer's Login action. See ADR-014.
   */
  private transformApiErrorMessage(msg: AssistantMessage): ChatMessage | null {
    const betaMessage = msg.message as Record<string, unknown> | undefined
    const content = betaMessage?.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .map((b: Record<string, unknown>) => (b?.type === 'text' ? (b.text as string) || '' : ''))
        .join('')
        .trim()
    }
    if (!text) text = (msg.error as string) || 'API error'

    return {
      id: (betaMessage?.id as string) || (msg.uuid as string) || `error-${uuid()}`,
      role: 'system',
      content: [
        { type: 'api_error', errorType: classifyApiError(text, msg.error), errorMessage: text }
      ],
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

    const routingId = msg.parent_tool_use_id as string | undefined
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
          isError: !!b.is_error
        })
      } else {
        this.send('session:tool-result', {
          toolUseId,
          result: resultText,
          isError: !!b.is_error
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
    this.upsertMessage(chatMsg)
    this.send('session:message', chatMsg)
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
    }

    // Record output file path for background commands (permanent — survives completion).
    // This works for both Task tools (with agentId) and background Bash (may lack agentId).
    const outputMatch = resultText.match(OUTPUT_FILE_RE)
    if (outputMatch) {
      const filePath = outputMatch[1].trim()
      this.backgroundFilePaths.set(toolUseId, filePath)
      // Create dormant poller entry (no interval until the renderer calls
      // watchBackground). Agent task output files are JSONL transcripts
      // handled by the subagent-streaming patch, not polled here.
      if (!this.backgroundPollers.has(toolUseId)) {
        this.backgroundPollers.set(toolUseId, { filePath, lastSize: 0, done: false })
        // Drain any watch request that raced ahead of the tool_result.
        if (this.pendingBackgroundWatches.delete(toolUseId)) {
          this.watchBackground(toolUseId)
        }
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
    if (!poller) {
      // The tool_result carrying the output file path hasn't arrived yet
      // (detectTaskMapping runs on tool_result). Remember the request so
      // polling auto-starts the moment the poller is registered. Without
      // this, a watchBackground call from the renderer that races ahead of
      // tool_result is silently dropped.
      this.pendingBackgroundWatches.add(toolUseId)
      return
    }

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

  unwatchBackground(_toolUseId: string): void {
    // No-op on the main process side. Polling starts on the first
    // watchBackground call and stops via markBackgroundDone. The renderer's
    // ref-counted watch/unwatch only controls store cleanup; the main process
    // keeps polling so data is ready when the UI reconnects.
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

  /** Upsert a message into the in-memory history (same dedup as the renderer). */
  private upsertMessage(msg: ChatMessage): void {
    const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
    if (idx >= 0) {
      this.messageHistory[idx] = msg
    } else {
      this.messageHistory.push(msg)
    }
  }

  private sendStatus(): void {
    this.send('session:status', this.status)
  }

  /** Dispose: permanently retire the session and release all resources. Unlike
   *  cancel() (which leaves the object usable for a later run() — idle timeout /
   *  user Stop), this marks the object retired so its late run()-finally can't
   *  emit status / re-arm the idle timer on a routingId a replacement now owns
   *  (M-CL3). Sets the flag BEFORE cancel() so cancel()'s own status emit is
   *  suppressed too. */
  dispose(): void {
    this.disposed = true
    this.cancel()
  }
}
