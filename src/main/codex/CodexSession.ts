/**
 * CodexSession — concrete ISession backend that spawns `codex app-server`,
 * performs the handshake, and maps Codex protocol notifications onto the
 * existing `session:*` IPC contract so the renderer shows a Codex chat.
 *
 * Structural template: src/main/services/claude-session.ts
 * Protocol client:     src/main/codex/CodexAppServerClient.ts
 * Notification mapper: src/main/codex/mapCodexEvent.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import { randomUUID } from 'node:crypto'

import type { BrowserWindow } from 'electron'
import type { ApprovalDecision, PermissionSuggestion, SessionCapabilities } from '../../shared/types'
import { CODEX_CAPABILITIES } from '../../shared/types'
import { BaseSession } from '../providers/BaseSession'
import { logger } from '../services/logger'
import { locateCodex } from './locate'
import { CodexAppServerClient } from './CodexAppServerClient'
import { CodexSpawnError } from './codexQuery'
import {
  makeAssemblyState,
  mapAgentMessageDelta,
  mapReasoningTextDelta,
  mapReasoningSummaryTextDelta,
  mapCommandExecutionOutputDelta,
  mapItemStarted,
  mapItemCompleted,
  mapTokenUsageUpdated,
  mapTurnCompleted,
  mapErrorNotification,
  mapPlanUpdated,
  type CodexAssemblyState,
} from './mapCodexEvent'
import type {
  V2AskForApproval,
  V2SandboxPolicy,
  V2UserInput,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  PermissionsRequestApprovalResponse,
  McpServerElicitationRequestResponse,
} from './protocol/schema'

// ---------------------------------------------------------------------------
// Deferred helper (approval resolution)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Permission-mode → Codex policy mapping
// ---------------------------------------------------------------------------

function toApprovalPolicy(permissionMode: string): V2AskForApproval {
  switch (permissionMode) {
    case 'acceptEdits':
    case 'auto':
      return 'on-request'
    case 'bypassPermissions':
      return 'never'
    default:
      // 'default' | 'plan' | anything else → untrusted (ask for everything)
      return 'untrusted'
  }
}

// thread/start uses the SandboxMode string
function toSandboxMode(permissionMode: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (permissionMode) {
    case 'acceptEdits':
    case 'auto':
      return 'workspace-write'
    case 'bypassPermissions':
      return 'danger-full-access'
    default:
      return 'read-only'
  }
}

// turn/start uses the SandboxPolicy object
function toSandboxPolicy(permissionMode: string): V2SandboxPolicy {
  switch (permissionMode) {
    case 'acceptEdits':
    case 'auto':
      return { type: 'workspaceWrite' }
    case 'bypassPermissions':
      return { type: 'dangerFullAccess' }
    default:
      return { type: 'readOnly' }
  }
}

// ---------------------------------------------------------------------------
// Reasoning effort clamp
// ---------------------------------------------------------------------------

/**
 * Codex's accepted `reasoningEffort` values, verified empirically against the
 * vendored binary's `model/list` (every model reports supportedReasoningEfforts
 * = [low, medium, high, xhigh]). ClaudeUI's effort set additionally includes
 * `max`, which Codex rejects with a 4xx — so we omit any effort outside this
 * set rather than forward it.
 *
 * NOTE: the live binary accepts `xhigh` but NOT `minimal` — this differs from
 * an earlier assumption. Sourced from the real `model/list` response.
 *
 * TODO(phase5): the model/effort picker should source Codex's own levels
 * (per-model `supportedReasoningEfforts`) instead of reusing Claude's set.
 */
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

function clampEffort(effort: string | undefined): string | undefined {
  if (effort && CODEX_REASONING_EFFORTS.has(effort)) return effort
  return undefined
}

// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a ClaudeUI model alias for Codex wire calls. Returns undefined for
 * falsy input OR the literal `'default'` (ClaudeUI's alias) — Codex has no
 * `'default'` model and rejects it with HTTP 400 ("The 'default' model is not
 * supported when using Codex with a ChatGPT account."). Omitting the field
 * makes Codex use the account's own default. A real slug passes through.
 *
 * Exported for unit testing; `CodexSession.codexModel()` delegates here.
 */
export function normalizeCodexModel(model: string | undefined): string | undefined {
  if (!model || model === 'default') return undefined
  return model
}

// ---------------------------------------------------------------------------
// Error classification for thread/resume fallback
// ---------------------------------------------------------------------------

/**
 * Whether a thread/resume failure should fall back to a fresh thread/start.
 * Intentionally lenient — the broad `includes('thread')` match catches most
 * "thread not found / unknown thread" phrasings across codex versions.
 * TODO(phase6): tighten to specific JSON-RPC error codes once the resume
 * error contract is pinned.
 */
function isRecoverableThreadResumeError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    msg.includes('not found') ||
    msg.includes('thread') ||
    msg.includes('does not exist') ||
    msg.includes(String(-32004)) || // common "session not found" codes
    msg.includes(String(-32001))
  )
}

// ---------------------------------------------------------------------------
// CodexSession
// ---------------------------------------------------------------------------

export class CodexSession extends BaseSession {
  readonly provider = 'codex' as const
  readonly capabilities: SessionCapabilities = CODEX_CAPABILITIES

  // --- internal state ---
  private sessionId: string | null = null
  private threadId: string | null = null
  private activeTurnId: string | null = null
  private running = false
  /** Set once dispose() runs. Suppresses any further IPC emission so events
   *  (notifications, approval prompts) that resolve after teardown are dropped. */
  private disposed = false

  private child: ChildProcessWithoutNullStreams | null = null
  private client: CodexAppServerClient | null = null

  private permissionMode: string
  private model: string | undefined
  private effort: string | undefined
  private resumeSessionId: string | undefined
  private forkSession: boolean = false

  // Pending approval deferreds: requestId → Deferred<{ decision: string } | { answers: unknown }>
  private pendingApprovals = new Map<string, Deferred<Record<string, unknown>>>()

  /**
   * Assembly state. Token accumulators (totalInputTokens, etc.) are
   * session-level and intentionally persist across turns. The per-turn Maps
   * (itemText, commandOutput) are explicitly cleared by resetTurnState() at the
   * start of each run() so a turn that ends abnormally (process exit,
   * turn/start failure) can't leak stale item buffers into the next turn.
   */
  private assemblyState: CodexAssemblyState = makeAssemblyState()

  constructor(
    routingId: string,
    win: BrowserWindow,
    cwd: string,
    effort?: string,
    resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    // sandboxConfig, thinkingMode, resumeSessionAt — unused by Codex
    _sandboxConfig?: unknown,
    _thinkingMode?: string,
    _resumeSessionAt?: string,
    forkSession?: boolean
  ) {
    super(routingId, win, cwd)
    this.permissionMode = permissionMode ?? 'default'
    this.model = model
    this.effort = effort
    this.resumeSessionId = resumeSessionId
    this.forkSession = !!forkSession
  }

  // ---------------------------------------------------------------------------
  // ISession implementation
  // ---------------------------------------------------------------------------

  get willQueue(): boolean {
    return this.running
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    // Ensure spawned + handshake done. run() is called fire-and-forget by the
    // session:send IPC, so a spawn/handshake failure must be surfaced to the
    // renderer here — rethrowing would become an unhandled promise rejection.
    // spawnAndHandshake() has already torn down its half-open connection (#3),
    // leaving this.client null, so a subsequent run() re-spawns cleanly.
    if (!this.client) {
      try {
        await this.spawnAndHandshake()
      } catch (err) {
        this.running = false
        this.resetInactivityTimer()
        const msg =
          err instanceof CodexSpawnError
            ? 'Codex CLI not found. Install it (or check your PATH) and try again.'
            : err instanceof Error
              ? err.message
              : String(err)
        this.send('session:error', msg)
        this.send('session:status', {
          state: 'error',
          sessionId: this.sessionId,
          model: this.model ?? null,
          cwd: this.cwd,
          totalCostUsd: 0,
          ...this.baseStatusFields(),
        })
        return
      }
    }

    if (prompt === null) {
      // spawn-only, no turn to start
      return
    }

    // Re-entrancy guard: a Codex thread allows only one active turn. The
    // session-manager normally queues via willQueue, but guard here too so a
    // double run() can't fire a second turn/start (which Codex rejects) and
    // then corrupt the running flag on the failed-turn catch path.
    if (this.running) {
      logger.warn('CodexSession', `run() called while a turn is already active (routingId=${this.routingId}); ignoring`)
      return
    }

    this.running = true
    this.clearInactivityTimer()
    // Clear per-turn assembly buffers (NOT the session-level token totals).
    this.resetTurnState()
    this.assemblyState.turnStartMs = Date.now()

    this.send('session:status', {
      state: 'running',
      sessionId: this.sessionId,
      model: this.model ?? null,
      cwd: this.cwd,
      totalCostUsd: 0,
      ...this.baseStatusFields(),
    })

    // Build input array: text + image attachments
    const input: V2UserInput[] = []
    input.push({ type: 'text', text: prompt })

    if (attachments) {
      for (const att of attachments) {
        if (att.mediaType.startsWith('image/')) {
          // Codex expects a data URL for image inputs
          const dataUrl = `data:${att.mediaType};base64,${att.base64Data}`
          input.push({ type: 'image', url: dataUrl })
        }
      }
    }

    const effort = clampEffort(this.effort)
    const model = this.codexModel()

    try {
      const resp = await this.client!.request('turn/start', {
        threadId: this.threadId!,
        input,
        approvalPolicy: toApprovalPolicy(this.permissionMode),
        sandboxPolicy: toSandboxPolicy(this.permissionMode),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }, { timeoutMs: 0 })

      this.activeTurnId = resp.turn?.id ?? null
    } catch (err) {
      this.running = false
      this.resetInactivityTimer()
      const msg = err instanceof Error ? err.message : String(err)
      this.send('session:error', msg)
      this.send('session:status', {
        state: 'error',
        sessionId: this.sessionId,
        model: this.model ?? null,
        cwd: this.cwd,
        totalCostUsd: 0,
        ...this.baseStatusFields(),
      })
    }
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.threadId || !this.activeTurnId) return
    try {
      await this.client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      })
    } catch {
      // Ignore interrupt errors — the turn may have already completed
    }
  }

  cancel(): void {
    this.dispose()
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    _updatedPermissions?: PermissionSuggestion[]
  ): void {
    const deferred = this.pendingApprovals.get(requestId)
    if (!deferred) return
    this.pendingApprovals.delete(requestId)

    if (answers && Object.keys(answers).length > 0) {
      // User-input response
      deferred.resolve({ answers })
    } else {
      // Pass the raw UI decision through; each handler maps it to its own
      // Codex response shape (command/file use a decision enum; permissions
      // use a permissions+scope object).
      deferred.resolve({ decision })
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model
  }

  /**
   * Normalize the model for Codex wire calls (thread/start, thread/resume,
   * turn/start). Delegates to {@link normalizeCodexModel}: omits ClaudeUI's
   * `'default'` alias and falsy values so Codex falls back to the account's
   * default model (Codex 400s on `model: 'default'`).
   */
  private codexModel(): string | undefined {
    return normalizeCodexModel(this.model)
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
  }

  /**
   * Clear the per-turn assembly buffers (accumulated agentMessage text and
   * buffered command output) at the start of a new turn. Token accumulators
   * are deliberately left intact — they track session-level totals.
   */
  private resetTurnState(): void {
    this.assemblyState.itemText.clear()
    this.assemblyState.commandOutput.clear()
  }

  dispose(): void {
    this.disposed = true
    this.clearInactivityTimer()
    this.running = false

    // Settle all pending approvals as declined (resolved, not rejected).
    for (const [, deferred] of this.pendingApprovals) {
      deferred.resolve({ decision: 'decline' })
    }
    this.pendingApprovals.clear()

    if (this.client) {
      try { this.client.dispose() } catch { /* ignore */ }
      this.client = null
    }
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch { /* ignore */ }
      this.child = null
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn + handshake
  // ---------------------------------------------------------------------------

  private async spawnAndHandshake(): Promise<void> {
    const bin = locateCodex()

    // Do NOT synthesize a CODEX_HOME default. `codex login` writes
    // auth.json under codex's own default ($HOME/.codex); forcing
    // CODEX_HOME=$HOME makes codex look for auth.json in $HOME instead and
    // every turn fails with 401 Missing bearer authentication. Inherit the
    // environment as-is — a real CODEX_HOME (if set) already flows through
    // ...process.env. A settings-driven override is a later phase.
    const child = spawn(bin, ['app-server'], {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    this.child = child

    // Drain stderr: surface ERROR lines as warnings
    const stderrRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
    stderrRl.on('line', (line) => {
      if (!line.trim()) return
      if (process.env.DEBUG_CODEX) {
        console.error('[codex stderr]', line)
      }
      const upper = line.toUpperCase()
      if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('PANIC')) {
        this.send('session:warning', `[codex] ${line}`)
      }
    })

    child.on('exit', (code, signal) => {
      stderrRl.close()
      if (this.running) {
        this.running = false
        this.send('session:error', `Codex process exited unexpectedly (code=${code}, signal=${signal})`)
        this.send('session:status', {
          state: 'error',
          sessionId: this.sessionId,
          model: this.model ?? null,
          cwd: this.cwd,
          totalCostUsd: 0,
          ...this.baseStatusFields(),
        })
      }
    })

    const client = new CodexAppServerClient(child.stdin, child.stdout)
    this.client = client

    // Wire up notification handlers
    this.wireNotificationHandlers(client)
    this.wireServerRequestHandlers(client)

    // Any failure from here on (RPC timeout, thread/start rejection, missing
    // thread id) must leave the session in a clean re-spawnable state: a dead
    // client + zombie child would otherwise survive on this.client/this.child
    // and make the next run() skip spawnAndHandshake() and fire turn/start on a
    // broken connection. Tear both down and rethrow so the next run() retries
    // from scratch.
    let threadId: string | null = null
    try {
      // 1. initialize
      const initResp = await client.request('initialize', {
        clientInfo: { name: 'ClaudeUI', version: '1.0' },
        capabilities: { experimentalApi: true },
      })
      void initResp // captured for CODEX_HOME / userAgent if needed later

      // 2. notify initialized
      client.notify('initialized', undefined)

      // 3. thread/fork, thread/start, or thread/resume
      const model = this.codexModel()

      if (this.forkSession && this.resumeSessionId) {
        try {
          const forkResp = await client.request('thread/fork', {
            threadId: this.resumeSessionId,
            approvalPolicy: toApprovalPolicy(this.permissionMode),
            sandbox: toSandboxMode(this.permissionMode),
            ...(model ? { model } : {}),
          })
          threadId = forkResp.thread?.id ?? null
        } catch (err) {
          if (!isRecoverableThreadResumeError(err)) throw err
          // Source thread gone — fall through to a fresh thread/start
        }
      } else if (this.resumeSessionId) {
        try {
          const resumeResp = await client.request('thread/resume', {
            threadId: this.resumeSessionId,
            approvalPolicy: toApprovalPolicy(this.permissionMode),
            sandbox: toSandboxMode(this.permissionMode),
            ...(model ? { model } : {}),
          })
          threadId = resumeResp.thread?.id ?? null
        } catch (err) {
          if (!isRecoverableThreadResumeError(err)) throw err
          // Thread not found — fall through to fresh thread/start
        }
      }

      if (!threadId) {
        const startResp = await client.request('thread/start', {
          cwd: this.cwd,
          approvalPolicy: toApprovalPolicy(this.permissionMode),
          sandbox: toSandboxMode(this.permissionMode),
          ...(model ? { model } : {}),
        })
        threadId = startResp.thread?.id ?? null
      }

      if (!threadId) {
        throw new Error('Codex app-server did not return a thread ID')
      }
    } catch (err) {
      // Clean up the half-open connection before rethrowing.
      try { this.client?.dispose() } catch { /* ignore */ }
      this.client = null
      try { this.child?.kill('SIGTERM') } catch { /* ignore */ }
      this.child = null
      throw err
    }

    this.threadId = threadId
    this.sessionId = threadId

    // Rekey routingId so the session-manager can track this session by its
    // real UUID. The renderer's existing rekey path listens on session:status
    // with a non-null sessionId.
    this.send('session:status', {
      state: 'idle',
      sessionId: this.sessionId,
      model: this.model ?? null,
      cwd: this.cwd,
      totalCostUsd: 0,
      ...this.baseStatusFields(),
    })

    this.resetInactivityTimer()
  }

  // ---------------------------------------------------------------------------
  // Notification wiring
  // ---------------------------------------------------------------------------

  private wireNotificationHandlers(client: CodexAppServerClient): void {
    const emit = (emissions: ReturnType<typeof mapAgentMessageDelta>) => this.emitMapped(emissions)

    client.handleServerNotification('item/agentMessage/delta', (params) => {
      emit(mapAgentMessageDelta(params, this.assemblyState))
    })

    client.handleServerNotification('item/reasoning/textDelta', (params) => {
      emit(mapReasoningTextDelta(params, this.assemblyState))
    })

    client.handleServerNotification('item/reasoning/summaryTextDelta', (params) => {
      emit(mapReasoningSummaryTextDelta(params, this.assemblyState))
    })

    client.handleServerNotification('item/commandExecution/outputDelta', (params) => {
      emit(mapCommandExecutionOutputDelta(params, this.assemblyState))
    })

    client.handleServerNotification('item/started', (params) => {
      emit(mapItemStarted(params, this.assemblyState))
    })

    client.handleServerNotification('item/completed', (params) => {
      emit(mapItemCompleted(params, this.assemblyState))
    })

    client.handleServerNotification('thread/tokenUsage/updated', (params) => {
      emit(mapTokenUsageUpdated(params, this.assemblyState))
    })

    client.handleServerNotification('turn/completed', (params) => {
      const mapped = mapTurnCompleted(params, this.assemblyState)
      this.emitMapped(mapped)
      // Transition to idle after result
      this.running = false
      const failed = params.turn?.status === 'failed'
      this.send('session:status', {
        state: failed ? 'error' : 'idle',
        sessionId: this.sessionId,
        model: this.model ?? null,
        cwd: this.cwd,
        totalCostUsd: 0,
        ...this.baseStatusFields(),
      })
      this.activeTurnId = null
      this.resetInactivityTimer()
    })

    client.handleServerNotification('error', (params) => {
      emit(mapErrorNotification(params, this.assemblyState))
      // A non-retryable error is terminal for the turn: Codex may not follow it
      // with turn/completed, so clear running here (mirroring the turn/completed
      // failed path) or the session stays stuck 'running' — willQueue would then
      // silently swallow every future prompt.
      const willRetry = typeof params.willRetry === 'boolean' ? params.willRetry : false
      if (!willRetry) {
        this.running = false
        this.activeTurnId = null
        this.send('session:status', {
          state: 'error',
          sessionId: this.sessionId,
          model: this.model ?? null,
          cwd: this.cwd,
          totalCostUsd: 0,
          ...this.baseStatusFields(),
        })
        this.resetInactivityTimer()
      }
    })

    client.handleServerNotification('thread/started', (params) => {
      // thread/started may carry an updated thread.id — capture it
      const newId = params.thread?.id
      if (newId && newId !== this.threadId) {
        this.threadId = newId
        this.sessionId = newId
      }
    })

    client.handleServerNotification('turn/plan/updated', (params) => {
      emit(mapPlanUpdated(params, this.assemblyState))
    })

    client.handleServerNotification('turn/diff/updated', (_params) => {
      // TODO(follow-up): surface diff preview
    })

    // Generic warning notifications from Codex (V2WarningNotification has .message: string)
    client.handleServerNotification('warning', (params) => {
      if (params.message) this.send('session:warning', params.message)
    })

    client.handleServerNotification('guardianWarning', (params) => {
      if (params.message) this.send('session:warning', `[guardian] ${params.message}`)
    })
  }

  /**
   * Map the raw UI ApprovalDecision to the Codex command/file decision enum.
   *   allow            → 'accept'
   *   allowForSession  → 'acceptForSession'
   *   anything else    → 'decline'  (covers 'deny' and the dispose-time 'decline')
   */
  private mapToCodexCommandDecision(raw: string | undefined): 'accept' | 'acceptForSession' | 'decline' {
    if (raw === 'allow') return 'accept'
    if (raw === 'allowForSession') return 'acceptForSession'
    return 'decline'
  }

  private wireServerRequestHandlers(client: CodexAppServerClient): void {
    // item/commandExecution/requestApproval
    client.handleServerRequest('item/commandExecution/requestApproval', async (params) => {
      if (this.disposed) return { decision: 'decline' as CommandExecutionApprovalDecision }
      const requestId = randomUUID()
      const toolInput: Record<string, unknown> = {}
      if (params.command !== undefined) toolInput.command = params.command
      if (params.reason !== undefined) toolInput.reason = params.reason

      const deferred = makeDeferred<Record<string, unknown>>()
      this.pendingApprovals.set(requestId, deferred)

      this.send('session:approval-request', {
        requestId,
        toolUseId: params.itemId,
        toolName: 'Shell',
        input: toolInput,
      })

      const resolution = await deferred.promise
      const decision = this.mapToCodexCommandDecision(resolution.decision as string | undefined) as CommandExecutionApprovalDecision
      return { decision }
    })

    // item/fileChange/requestApproval
    client.handleServerRequest('item/fileChange/requestApproval', async (params) => {
      if (this.disposed) return { decision: 'decline' as FileChangeApprovalDecision }
      const requestId = randomUUID()
      const toolInput: Record<string, unknown> = {}
      if (params.reason !== undefined) toolInput.reason = params.reason

      const deferred = makeDeferred<Record<string, unknown>>()
      this.pendingApprovals.set(requestId, deferred)

      this.send('session:approval-request', {
        requestId,
        toolUseId: params.itemId,
        toolName: 'ApplyPatch',
        input: toolInput,
      })

      const resolution = await deferred.promise
      const decision = this.mapToCodexCommandDecision(resolution.decision as string | undefined) as FileChangeApprovalDecision
      return { decision }
    })

    // item/permissions/requestApproval
    client.handleServerRequest('item/permissions/requestApproval', async (params): Promise<PermissionsRequestApprovalResponse> => {
      if (this.disposed) return { permissions: {} }
      const requestId = randomUUID()

      const deferred = makeDeferred<Record<string, unknown>>()
      this.pendingApprovals.set(requestId, deferred)

      this.send('session:approval-request', {
        requestId,
        toolUseId: params.itemId,
        toolName: 'Permissions',
        input: { reason: params.reason, permissions: params.permissions },
      })

      const resolution = await deferred.promise
      const raw = resolution.decision as string | undefined
      if (raw === 'allow') {
        return { permissions: params.permissions, scope: 'turn' }
      }
      if (raw === 'allowForSession') {
        return { permissions: params.permissions, scope: 'session' }
      }
      // deny / decline / anything else
      return { permissions: {} }
    })

    // mcpServer/elicitation/request
    // Interactive MCP elicitation UI is deferred to a later MCP work phase.
    // For now, immediately decline to avoid wedging the turn with methodNotFound.
    client.handleServerRequest('mcpServer/elicitation/request', async (_params): Promise<McpServerElicitationRequestResponse> => {
      return { action: 'decline' }
    })

    // item/tool/requestUserInput
    client.handleServerRequest('item/tool/requestUserInput', async (params) => {
      if (this.disposed) return { answers: {} }
      const requestId = randomUUID()
      const toolInput: Record<string, unknown> = { questions: params.questions }

      const deferred = makeDeferred<Record<string, unknown>>()
      this.pendingApprovals.set(requestId, deferred)

      this.send('session:approval-request', {
        requestId,
        toolUseId: params.itemId,
        toolName: 'UserInput',
        input: toolInput,
      })

      const resolution = await deferred.promise
      // For user-input: answers map back to the Codex response shape
      if (resolution.answers) {
        // Convert Record<string,string> → Record<string, {answers:[string]}>
        const rawAnswers = resolution.answers as Record<string, string>
        const codexAnswers: Record<string, { answers: string[] }> = {}
        for (const [k, v] of Object.entries(rawAnswers)) {
          codexAnswers[k] = { answers: [v] }
        }
        return { answers: codexAnswers }
      }
      // If declined, return empty answers
      return { answers: {} }
    })
  }

  // ---------------------------------------------------------------------------
  // Emit helper
  // ---------------------------------------------------------------------------

  private emitMapped(emissions: ReturnType<typeof mapAgentMessageDelta>): void {
    // Drop any emission produced by a notification that resolved after teardown.
    if (this.disposed) return
    if (emissions.stream) {
      this.send('session:stream', emissions.stream)
    }
    if (emissions.message) {
      this.send('session:message', emissions.message)
      this.messageHistory.push(emissions.message)
    }
    if (emissions.toolResult) {
      this.send('session:tool-result', emissions.toolResult)
    }
    if (emissions.statusLine) {
      this.send('session:status-line', emissions.statusLine)
    }
    if (emissions.result) {
      this.send('session:result', emissions.result)
    }
    if (emissions.plan !== undefined) {
      this.send('session:plan', emissions.plan)
    }
    if (emissions.alertKind === 'error' && emissions.alertText) {
      this.send('session:error', emissions.alertText)
    } else if (emissions.alertKind === 'warning' && emissions.alertText) {
      this.send('session:warning', emissions.alertText)
    }
  }
}
