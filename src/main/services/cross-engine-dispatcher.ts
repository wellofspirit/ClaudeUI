/**
 * Cross-engine agent dispatch (ADR-033).
 *
 * A single main-process service owning all `dispatch_agent` logic: target
 * creation, guards (concurrency cap, per-dispatch timeout, model allowlist),
 * approval forwarding, result await, and cancellation.
 *
 * Targets are headless dispatcher-owned mini-sessions built on engine client
 * primitives — NOT SessionManager/ISession. The v1 direction is Claude →
 * opencode: targets use OpencodeClient directly (the askSideQuestion / judge
 * precedent), with a synchronous `POST /session/{id}/message` per turn.
 *
 * All failures come back as `isError` tool text — nothing throws across the
 * MCP boundary.
 */
import { resolve as resolvePath } from 'node:path'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { buildRuleset } from '../opencode/OpencodeSession'
import type { PermissionRule } from '../opencode/OpencodeSession'
import { parseModelString } from '../opencode/model-discovery'
import { loadEngineConfig } from './ui-config'
import { sendProgress } from '../sdk'
import type { SdkToolExtra } from '../sdk'
import { logger } from './logger'
import type {
  ApprovalDecision,
  EngineConfig,
  EngineId,
  PendingApproval,
  PermissionSuggestion
} from '../../shared/types'

// ── Public surface ────────────────────────────────────────────────────────────

export interface DispatchContext {
  fromEngine: EngineId
  fromRoutingId: string
  cwd: string
  /** Dispatching session's permission mode (Claude-style string). */
  autonomyMode: string
  /** Re-emits under the dispatching session's routing (BaseSession.send). */
  emit: (channel: string, data: unknown) => void
  extra?: SdkToolExtra
}

export interface DispatchRequest {
  engine: EngineId
  prompt: string
  model?: string
  sessionId?: string
}

export interface DispatchResult {
  text: string
  sessionId: string
  isError?: boolean
}

/**
 * Structural subset of OpencodeClient the dispatcher uses — injectable so
 * tests can stub the transport without HTTP.
 */
export interface DispatchTargetClient {
  createSession(req?: { title?: string }): Promise<{ id: string }>
  patchSession(
    sessionId: string,
    patch: { permission?: Array<{ permission: string; pattern: string; action: string }> }
  ): Promise<unknown>
  prompt(
    sessionId: string,
    req: {
      model?: { providerID: string; modelID: string }
      parts: Array<{ type: 'text'; text: string }>
    }
  ): Promise<unknown>
  deleteSession(sessionId: string): Promise<boolean>
  abortSession(sessionId: string): Promise<boolean>
  replyPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string
  ): Promise<unknown>
  subscribeEvents(
    signal?: AbortSignal
  ): AsyncGenerator<{ id: string; type: string; properties: Record<string, unknown> }>
}

export interface DispatcherDeps {
  serverManager: {
    acquire(cwd: string): Promise<{ baseUrl: string; authHeader: string }>
    release(cwd: string): void
  }
  makeClient: (baseUrl: string, authHeader: string) => DispatchTargetClient
  loadEngineConfig: (engineId: string) => EngineConfig
  maxConcurrent?: number
  dispatchTimeoutMs?: number
  heartbeatMs?: number
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Reserved requestId prefix routing approvals to the dispatcher (ADR-033). */
export const XENG_REQUEST_PREFIX = 'xeng:'

const MAX_CONCURRENT = 3
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 15 * 1000

/** A live dispatch target — persists across turns for `session_id` continuation. */
interface TargetEntry {
  sessionId: string
  fromRoutingId: string
  cwd: string
  cwdKey: string
  client: DispatchTargetClient
  /** Latest dispatching context — used to forward approvals mid-turn. */
  ctx: DispatchContext
}

/** One shared server connection (+ SSE loop) per cwd with live targets. */
interface ConnRecord {
  client: DispatchTargetClient
  sseAbort: AbortController
  targetCount: number
}

interface PendingForwardedApproval {
  /** Raw opencode permission id (no prefix). */
  permissionId: string
  targetSessionId: string
  client: DispatchTargetClient
  emit: (channel: string, data: unknown) => void
}

function errorResult(text: string, sessionId = ''): DispatchResult {
  return { text, sessionId, isError: true }
}

export class CrossEngineDispatcher {
  private readonly deps: DispatcherDeps
  private readonly maxConcurrent: number
  private readonly dispatchTimeoutMs: number
  private readonly heartbeatMs: number

  /** Keyed by target (opencode) session id. */
  private targets = new Map<string, TargetEntry>()
  /** Keyed by resolved cwd. */
  private connections = new Map<string, ConnRecord>()
  /** Keyed by prefixed requestId ('xeng:<permission id>'). */
  private pendingApprovals = new Map<string, PendingForwardedApproval>()
  private activeDispatches = 0

  constructor(deps: DispatcherDeps) {
    this.deps = deps
    this.maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT
    this.dispatchTimeoutMs = deps.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  }

  /** For tests: current in-flight dispatch count. */
  get inFlightCount(): number {
    return this.activeDispatches
  }

  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    try {
      return await this.dispatchInner(req, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('CrossEngineDispatcher', `dispatch failed: ${msg}`)
      return errorResult(`Dispatch failed: ${msg}`, req.sessionId ?? '')
    }
  }

  private async dispatchInner(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    // ── Guards ────────────────────────────────────────────────────────────
    if (req.engine === ctx.fromEngine) {
      return errorResult(
        `dispatch_agent targets a different engine — this session already runs on "${ctx.fromEngine}". ` +
          'Use your own tools (or a native subagent) for same-engine work.'
      )
    }
    if (req.engine !== 'opencode') {
      return errorResult(`Dispatching into engine "${req.engine}" is not supported yet.`)
    }
    if (this.activeDispatches >= this.maxConcurrent) {
      return errorResult(
        `Too many concurrent dispatches (max ${this.maxConcurrent}). Wait for one to finish and retry.`
      )
    }

    // Reserve the slot SYNCHRONOUSLY, before the first await: Claude can issue
    // several dispatch_agent calls in one assistant turn, whose handlers run
    // concurrently — checking the cap without reserving would let them all
    // pass. Every path from here on releases the slot via the finally below.
    this.activeDispatches++
    try {
      return await this.resolveAndRun(req, ctx)
    } finally {
      this.activeDispatches--
    }
  }

  /** Everything past the guards — runs with an activeDispatches slot held. */
  private async resolveAndRun(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    // ── Model resolution ──────────────────────────────────────────────────
    const dispatchCfg = this.deps.loadEngineConfig(req.engine).dispatch
    const model = req.model ?? dispatchCfg?.defaultModel
    if (!model) {
      return errorResult(
        'No model is configured for cross-engine dispatch into opencode. Ask the user to set ' +
          'Engines › opencode › Cross-engine dispatch (the `dispatch.defaultModel` field in ' +
          '~/.claude/ui/engines/opencode.json), or pass `model` explicitly.'
      )
    }
    const allowed = dispatchCfg?.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(model)) {
      return errorResult(
        `Model "${model}" is not in the user-configured allowlist for opencode dispatch. ` +
          `Allowed models: ${allowed.join(', ')}`
      )
    }

    // ── Target resolution ─────────────────────────────────────────────────
    let entry: TargetEntry
    if (req.sessionId) {
      const existing = this.targets.get(req.sessionId)
      if (!existing || existing.fromRoutingId !== ctx.fromRoutingId) {
        return errorResult(
          `Unknown dispatch session "${req.sessionId}" — it may have been disposed. ` +
            'Start a fresh dispatch without session_id.'
        )
      }
      existing.ctx = ctx
      entry = existing
    } else {
      entry = await this.createTarget(ctx)
    }

    // ── Run the turn ──────────────────────────────────────────────────────
    // Progress heartbeat: resets opencode's MCP callTool timeout on the
    // reverse direction later, and feeds TaskCard progress. Harmless no-op
    // for Claude-side dispatch today (in-process MCP sets no progressToken).
    let beats = 0
    const heartbeat = setInterval(() => {
      beats++
      void sendProgress(ctx.extra, {
        progress: beats,
        message: 'Dispatched agent is still working…'
      }).catch(() => {})
    }, this.heartbeatMs)

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const signal = ctx.extra?.signal
    let abortListener: (() => void) | undefined

    type Raced =
      | { kind: 'ok'; resp: unknown }
      | { kind: 'err'; err: unknown }
      | { kind: 'timeout' }
      | { kind: 'abort' }

    const promptPromise: Promise<Raced> = entry.client
      .prompt(entry.sessionId, {
        model: parseModelString(model),
        parts: [{ type: 'text', text: req.prompt }]
      })
      .then(
        (resp): Raced => ({ kind: 'ok', resp }),
        (err): Raced => ({ kind: 'err', err })
      )
    const timeoutPromise = new Promise<Raced>((resolve) => {
      timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), this.dispatchTimeoutMs)
    })
    const abortPromise: Promise<Raced> = signal
      ? signal.aborted
        ? Promise.resolve({ kind: 'abort' })
        : new Promise((resolve) => {
            abortListener = (): void => resolve({ kind: 'abort' })
            signal.addEventListener('abort', abortListener, { once: true })
          })
      : new Promise(() => {})

    try {
      const winner = await Promise.race([promptPromise, timeoutPromise, abortPromise])

      if (winner.kind === 'timeout' || winner.kind === 'abort') {
        // Interrupt the target turn server-side; the still-pending prompt
        // promise settles via its own handlers (no unhandled rejection).
        entry.client.abortSession(entry.sessionId).catch(() => {})
        this.dismissPendingForTarget(entry.sessionId)
        return errorResult(
          winner.kind === 'timeout'
            ? `Dispatch timed out after ${Math.round(this.dispatchTimeoutMs / 60000)} minutes — the target agent was aborted.`
            : 'Dispatch cancelled.',
          entry.sessionId
        )
      }
      if (winner.kind === 'err') {
        this.dismissPendingForTarget(entry.sessionId)
        const msg = winner.err instanceof Error ? winner.err.message : String(winner.err)
        return errorResult(`Dispatched turn failed: ${msg}`, entry.sessionId)
      }

      const resp = winner.resp as
        | {
            info?: { error?: { name?: string; data?: { message?: string } } }
            parts?: Array<{ type?: string; text?: string }>
          }
        | undefined
      // opencode's POST /session/{id}/message RESOLVES even when the model turn
      // errors — the failure lives on info.error (a named-error union, each
      // { name, data?: { message? } }). Surface it as an isError instead of
      // silently returning the empty-text fallback (hiding a hard failure like
      // "Key limit exceeded" as an apparent success). Target stays alive for
      // continuation, so return its sessionId (parity with other error paths).
      const turnError = resp?.info?.error
      if (turnError) {
        this.dismissPendingForTarget(entry.sessionId)
        const detail =
          turnError.data?.message || turnError.name || 'the dispatched agent reported an error'
        return errorResult(`Dispatched turn failed: ${detail}`, entry.sessionId)
      }
      const text = (resp?.parts ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => p?.text ?? '')
        .join('')
      return { text: text || '(the dispatched agent returned no text)', sessionId: entry.sessionId }
    } finally {
      clearInterval(heartbeat)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  /**
   * Resolve a forwarded approval coming back from the approve IPC. Returns
   * true when the requestId belongs to the dispatcher (the reserved `xeng:`
   * prefix) — the IPC handler then skips the session's own resolveApproval.
   */
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    _updatedPermissions?: PermissionSuggestion[]
  ): boolean {
    if (!requestId.startsWith(XENG_REQUEST_PREFIX)) return false
    const pending = this.pendingApprovals.get(requestId)
    // Prefixed ids are exclusively dispatcher-owned: consume even when stale
    // (e.g. already cascade-rejected) so no session ever sees an xeng id.
    if (!pending) return true
    this.pendingApprovals.delete(requestId)

    const allow = decision === 'allow' || decision === 'allowForSession'
    const reply = !allow ? 'reject' : decision === 'allowForSession' ? 'always' : 'once'
    // Deny feedback is model-visible (CorrectedError, non-fatal) — parity with
    // OpencodeSession.resolveApproval.
    const message = !allow ? answers?.feedback || 'User denied' : undefined
    const replied = message
      ? pending.client.replyPermission(pending.permissionId, reply, message)
      : pending.client.replyPermission(pending.permissionId, reply)
    replied.catch((err) => {
      logger.warn(
        'CrossEngineDispatcher',
        `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })
    return true
  }

  /** Tear down every target (+ SSE subs / server refs) owned by a dispatching session. */
  disposeFor(routingId: string): void {
    for (const [sessionId, entry] of [...this.targets]) {
      if (entry.fromRoutingId !== routingId) continue
      this.targets.delete(sessionId)
      this.dismissPendingForTarget(sessionId)
      entry.client.deleteSession(sessionId).catch(() => {})
      this.releaseConnection(entry)
    }
  }

  // ── Target / connection lifecycle ────────────────────────────────────────

  private async createTarget(ctx: DispatchContext): Promise<TargetEntry> {
    const cwdKey = resolvePath(ctx.cwd)
    // One serverManager ref per target; the per-cwd client + SSE loop are shared.
    const conn = await this.deps.serverManager.acquire(ctx.cwd)
    let rec = this.connections.get(cwdKey)
    if (!rec) {
      rec = {
        client: this.deps.makeClient(conn.baseUrl, conn.authHeader),
        sseAbort: new AbortController(),
        targetCount: 0
      }
      this.connections.set(cwdKey, rec)
      void this.runSseLoop(rec)
    }
    rec.targetCount++

    try {
      const session = await rec.client.createSession({ title: 'xeng-dispatch' })
      // Inherit the dispatcher's autonomy mode, plus a structural recursion
      // guard: the target can never call the dispatch tool back (ADR-033 §4).
      const ruleset: PermissionRule[] = [
        ...buildRuleset(ctx.autonomyMode),
        { permission: 'claudeui_dispatch_agent*', pattern: '*', action: 'deny' }
      ]
      await rec.client.patchSession(session.id, { permission: ruleset })

      const entry: TargetEntry = {
        sessionId: session.id,
        fromRoutingId: ctx.fromRoutingId,
        cwd: ctx.cwd,
        cwdKey,
        client: rec.client,
        ctx
      }
      this.targets.set(session.id, entry)
      return entry
    } catch (err) {
      // Roll back the ref we took for this target.
      this.releaseConnection({ cwd: ctx.cwd, cwdKey })
      throw err
    }
  }

  private releaseConnection(entry: Pick<TargetEntry, 'cwd' | 'cwdKey'>): void {
    this.deps.serverManager.release(entry.cwd)
    const rec = this.connections.get(entry.cwdKey)
    if (!rec) return
    rec.targetCount--
    if (rec.targetCount <= 0) {
      this.connections.delete(entry.cwdKey)
      rec.sseAbort.abort()
    }
  }

  // ── SSE approval forwarding ──────────────────────────────────────────────

  private async runSseLoop(rec: ConnRecord): Promise<void> {
    try {
      // subscribeEvents is UNFILTERED — we filter by registered target ids.
      for await (const ev of rec.client.subscribeEvents(rec.sseAbort.signal)) {
        if (rec.sseAbort.signal.aborted) break
        this.handleSseEvent(ev)
      }
    } catch (err) {
      if (!rec.sseAbort.signal.aborted) {
        logger.warn(
          'CrossEngineDispatcher',
          `SSE loop error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  private handleSseEvent(ev: { type: string; properties: Record<string, unknown> }): void {
    const props = ev.properties

    if (ev.type === 'permission.asked') {
      const sessionID = props.sessionID as string | undefined
      const id = props.id as string | undefined
      if (!sessionID || !id) return
      const entry = this.targets.get(sessionID)
      if (!entry) return // foreign session — not a dispatch target

      const requestId = XENG_REQUEST_PREFIX + id
      const permission = (props.permission as string | undefined) ?? 'tool'
      const metadata = (props.metadata as Record<string, unknown> | undefined) ?? {}
      const patterns = props.patterns as string[] | undefined
      const approval: PendingApproval = {
        requestId,
        toolName: `dispatch:${permission}`,
        input: { ...metadata, ...(patterns ? { patterns } : {}) }
      }
      this.pendingApprovals.set(requestId, {
        permissionId: id,
        targetSessionId: sessionID,
        client: entry.client,
        emit: entry.ctx.emit
      })
      // The dispatching session's emit puts its own routingId on the wire, so
      // the approval card shows on the dispatching chat with zero renderer changes.
      entry.ctx.emit('session:approval-request', approval)
      return
    }

    if (ev.type === 'permission.replied') {
      // opencode resolved a permission without us — its deny-cascade bare-rejects
      // every other pending ask in the session (ADR-033). Reconcile: drop our
      // pending entry and dismiss the renderer card. (When WE replied, the entry
      // was already deleted in resolveApproval, so this is a no-op.)
      const requestID = props.requestID as string | undefined
      if (!requestID) return
      const key = XENG_REQUEST_PREFIX + requestID
      const pending = this.pendingApprovals.get(key)
      if (!pending) return
      this.pendingApprovals.delete(key)
      pending.emit('session:approval-dismiss', { requestId: key })
    }
  }

  /** Dismiss all forwarded approvals for one target (timeout/abort/dispose). */
  private dismissPendingForTarget(targetSessionId: string): void {
    for (const [key, pending] of [...this.pendingApprovals]) {
      if (pending.targetSessionId !== targetSessionId) continue
      this.pendingApprovals.delete(key)
      pending.emit('session:approval-dismiss', { requestId: key })
    }
  }
}

export const crossEngineDispatcher = new CrossEngineDispatcher({
  serverManager: opencodeServerManager,
  makeClient: (baseUrl, authHeader) => new OpencodeClient(baseUrl, authHeader),
  loadEngineConfig
})
