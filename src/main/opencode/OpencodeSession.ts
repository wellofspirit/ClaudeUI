import type { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { opencodeServerManager } from './OpencodeServerManager'
import type { ServerConnection } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { BaseSession } from '../providers/BaseSession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import { resolveOpencodeCapabilities } from '../../shared/model-capabilities'
import type {
  ChatMessage,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  AccountRef,
  MeteringSnapshot
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from '../services/logger'
import { mapEvent, extractToolResult } from './event-mapper'
import type { MapperOutput, MessageAccumulator } from './event-mapper'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { recordUsageEvent } from '../services/usage-recorder'

// Permission ruleset helper
type PermissionAction = 'allow' | 'ask' | 'deny'

interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

function buildRuleset(action: PermissionAction): PermissionRule[] {
  return [{ permission: '*', pattern: '*', action }]
}

/** Parse "providerID/modelID" → { providerID, modelID } */
function parseModelString(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/')
  if (slash < 0) return { providerID: 'opencode', modelID: model }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

const DEFAULT_MODEL = 'opencode/mimo-v2.5-free'

export class OpencodeSession extends BaseSession {
  readonly engineId = 'opencode' as const

  private _capabilities: ResolvedCapabilities
  get capabilities(): ResolvedCapabilities {
    return this._capabilities
  }

  private conn: ServerConnection | null = null
  private client: OpencodeClient | null = null
  private openSessionId: string | null = null
  private sseAbort: AbortController | null = null
  private isProcessing = false
  private totalCostUsd = 0
  private startTimeMs = 0
  private _model: string
  private permissionMode: string
  private agent: string | null = null
  private pendingApprovals = new Map<string, unknown>()
  // Per-message part accumulator keyed by messageId
  private accumulators = new Map<string, MessageAccumulator>()
  // Track last emitted tool completion per partId to avoid double-emitting
  private emittedToolResults = new Set<string>()
  // Metering: message ids already recorded to usage_event (the accumulators map
  // persists across turns, so without this every session.idle re-iterates all
  // prior messages; the DB UNIQUE(message_id) already dedups, this just avoids
  // the repeated round-trips on long sessions).
  private recordedUsageMessageIds = new Set<string>()

  constructor(
    routingId: string,
    win: BrowserWindow,
    cwd: string,
    _effort?: string,
    _resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    _sandboxConfig?: unknown,
    _thinkingMode?: string,
    _resumeSessionAt?: string,
    _forkSession?: boolean
  ) {
    super(routingId, win, cwd)
    this._model = model ?? DEFAULT_MODEL
    this.permissionMode = permissionMode ?? 'default'
    this._capabilities = resolveOpencodeCapabilities()
    this.sendStatus()
    // Warm the auth provider cache asynchronously so account is populated on
    // the next status emit (e.g. when run() begins). A cross-vendor model switch
    // re-reads from the cached map, so this only needs to warm once per session.
    opencodeAuthProvider.warmCache().then(() => this.sendStatus()).catch(() => {})
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  get status(): SessionStatus {
    const parsed = parseModelString(this._model)
    const account: AccountRef | null = opencodeAuthProvider.buildAccountRef(parsed.providerID)
    return {
      state: this.isProcessing ? 'running' : 'idle',
      sessionId: this.openSessionId,
      model: opencodeModel(parsed.providerID, parsed.modelID),
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      account,
      ...this.baseStatusFields()
    }
  }

  getSessionId(): string | null {
    return this.openSessionId
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('OpencodeSession', `Idle timeout — auto-disconnecting`)
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    this.clearInactivityTimer()
    if (prompt === null) return // spawn-only not applicable for opencode

    this.isProcessing = true
    this.sendStatus()

    try {
      // 1. Acquire server connection
      if (!this.conn) {
        this.conn = await opencodeServerManager.acquire(this.cwd)
        this.client = new OpencodeClient(this.conn.baseUrl, this.conn.authHeader)
      }

      // 2. Create opencode session if needed
      if (!this.openSessionId) {
        const s = await this.client!.createSession({ title: '' })
        this.openSessionId = s.id
        // Emit status with new sessionId so renderer can rekey
        this.sendStatus()
      }

      // 3. Start SSE consumer BEFORE sending prompt (so no events are missed)
      this.ensureSSEConsumer()

      // 4. Apply autonomy/permission mode
      await this.applyPermissionMode(this.permissionMode)

      // 5. Record the user message in local history (for getMessages()). Do NOT
      // emit session:message — the renderer adds the user message optimistically
      // (addUserMessage) and session:send relays session:user-message, mirroring
      // ClaudeSession. Emitting here would render the prompt twice.
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)

      // 6. Send prompt to opencode
      const parsed = parseModelString(this._model)
      const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> = [
        { type: 'text', text: prompt }
      ]
      if (attachments) {
        for (const att of attachments) {
          parts.push({ type: 'file', mime: att.mediaType, url: `data:${att.mediaType};base64,${att.base64Data}` })
        }
      }

      this.startTimeMs = Date.now()
      await this.client!.promptAsync(this.openSessionId, {
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        agent: this.agent ?? undefined,
        parts
      })
    } catch (err) {
      logger.error('OpencodeSession', `run() error: ${err instanceof Error ? err.message : String(err)}`)
      this.isProcessing = false
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
    }
  }

  private ensureSSEConsumer(): void {
    if (this.sseAbort) return // already running
    this.sseAbort = new AbortController()
    // Fire and forget — runs in background
    this.consumeEvents().catch((err) => {
      if (!this.sseAbort?.signal.aborted) {
        logger.error('OpencodeSession', `SSE consumer error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  private async consumeEvents(): Promise<void> {
    if (!this.client || !this.openSessionId) return
    const signal = this.sseAbort!.signal
    const totalCostRef = { value: this.totalCostUsd }

    try {
      for await (const ev of this.client.subscribeEvents(signal)) {
        if (signal.aborted) break
        if (!this.openSessionId) continue

        const output = mapEvent(ev, this.openSessionId, this.accumulators, this.startTimeMs, totalCostRef)
        this.totalCostUsd = totalCostRef.value

        this.dispatchMapperOutput(output)
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.error('OpencodeSession', `SSE stream error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private dispatchMapperOutput(output: MapperOutput): void {
    switch (output.kind) {
      case 'stream':
        this.send('session:stream', { type: output.streamType, text: output.delta })
        break

      case 'message': {
        const msg = output.message
        // Upsert into local history
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) {
          this.messageHistory[idx] = msg
        } else {
          this.messageHistory.push(msg)
        }
        this.send('session:message', msg)

        // Check for newly completed tool parts in the accumulator
        const acc = this.accumulators.get(msg.id)
        if (acc) {
          for (const [partId, snap] of acc.parts) {
            const cacheKey = `${msg.id}:${partId}`
            if (!this.emittedToolResults.has(cacheKey)) {
              const toolRes = extractToolResult(partId, snap)
              if (toolRes) {
                this.emittedToolResults.add(cacheKey)
                this.send('session:tool-result', toolRes)
              }
            }
          }
        }
        break
      }

      case 'approval':
        this.pendingApprovals.set(output.approval.requestId, true)
        this.send('session:approval-request', output.approval)
        break

      case 'result':
        this.isProcessing = false
        // Metering (Phase 7 Pass 1) — record one usage_event per assistant
        // message in this turn. We record at session.idle (result) so we have
        // the final cumulative token + cost state for each message_id.
        this.recordTurnUsage()
        // Metering (Phase 7 Pass 2) — emit the engine-neutral MeteringSnapshot.
        this.sendMetering()
        this.send('session:result', output.result)
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'cost_update':
        // totalCostUsd already updated via ref; status update is deferred to result
        break

      case 'error':
        this.isProcessing = false
        this.send('session:error', output.message)
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'ignore':
        break
    }
  }

  async interrupt(): Promise<void> {
    if (this.client && this.openSessionId) {
      try {
        await this.client.abortSession(this.openSessionId)
      } catch (err) {
        logger.warn('OpencodeSession', `abort failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  cancel(): void {
    this.clearInactivityTimer()
    this.isProcessing = false
    this.sseAbort?.abort()
    this.sseAbort = null
    if (this.conn) {
      opencodeServerManager.release(this.cwd)
      this.conn = null
      this.client = null
    }
    this.sendStatus()
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    _answers?: Record<string, string>,
    _updatedPermissions?: PermissionSuggestion[]
  ): void {
    this.pendingApprovals.delete(requestId)
    if (!this.client) return

    const reply =
      decision === 'allow'
        ? ('once' as const)
        : decision === 'allowForSession'
          ? ('always' as const)
          : ('reject' as const)

    this.client.replyPermission(requestId, reply).catch((err) => {
      logger.warn('OpencodeSession', `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async setModel(model: string): Promise<void> {
    this._model = model
    this._capabilities = resolveOpencodeCapabilities()
    this.sendStatus()
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    if (this.openSessionId && this.client) {
      await this.applyPermissionMode(mode)
    }
    this.send('session:permission-mode', mode)
  }

  private async applyPermissionMode(mode: string): Promise<void> {
    if (!this.client || !this.openSessionId) return
    if (mode === 'plan') {
      // Plan mode: use opencode's plan agent
      this.agent = 'plan'
      // No permission ruleset change needed
    } else {
      this.agent = null
      const action: PermissionAction = mode === 'auto' || mode === 'full' || mode === 'acceptEdits' ? 'allow' : 'ask'
      try {
        await this.client.patchSession(this.openSessionId, { permission: buildRuleset(action) })
      } catch (err) {
        logger.warn('OpencodeSession', `patchSession failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  /**
   * Record one usage_event per accumulated assistant message at turn end.
   * Called at session.idle so we have final cumulative token + cost state.
   * Failures are swallowed by recordUsageEvent — never breaks a turn.
   */
  private recordTurnUsage(): void {
    const parsed = parseModelString(this._model)
    const account = opencodeAuthProvider.buildAccountRef(parsed.providerID)

    for (const [messageId, acc] of this.accumulators) {
      // Only record assistant messages that have cost or token data
      if (acc.role === 'user' || acc.role === 'system') continue
      if (!acc.cost && !acc.tokens) continue
      // Skip messages already recorded in a prior session.idle this session
      // (the DB dedups anyway; this avoids the redundant round-trip).
      if (this.recordedUsageMessageIds.has(messageId)) continue
      this.recordedUsageMessageIds.add(messageId)

      const tokens = acc.tokens
      recordUsageEvent({
        engineId: 'opencode',
        vendorId: parsed.providerID,
        accountId: account?.accountId ?? null,
        accountUuid: null, // opencode does not expose an OAuth account UUID yet
        modelId: parsed.modelID,
        tokens: {
          input: tokens?.input ?? 0,
          output: tokens?.output ?? 0,
          cacheWrite: tokens?.cache?.write ?? 0,
          cacheWrite1h: 0, // opencode does not distinguish 1h cache writes
          cacheRead: tokens?.cache?.read ?? 0
        },
        engineCostUsd: acc.cost ?? null,
        sessionId: this.openSessionId,
        messageId,
        source: 'live'
      })
    }
  }

  /**
   * Emit the engine-neutral MeteringSnapshot (Phase 7 Pass 2). opencode has no
   * window (no usage provider yet — foundation §7), so window is omitted; this
   * is the cumulative-meter case. Tokens summed across the turn's assistant
   * messages; equivalentCostUsd from the internal pricing table. Best-effort.
   */
  private sendMetering(): void {
    try {
      const parsed = parseModelString(this._model)
      const account = opencodeAuthProvider.buildAccountRef(parsed.providerID)
      let input = 0
      let output = 0
      let cacheWrite = 0
      let cacheRead = 0
      for (const acc of this.accumulators.values()) {
        if (acc.role === 'user' || acc.role === 'system') continue
        const t = acc.tokens
        if (!t) continue
        input += t.input ?? 0
        output += t.output ?? 0
        cacheWrite += t.cache?.write ?? 0
        cacheRead += t.cache?.read ?? 0
      }
      const equiv = equivalentCostUsd(parsed.providerID, parsed.modelID, {
        inputTokens: input,
        outputTokens: output,
        cacheWriteTokens: cacheWrite,
        cacheWrite1hTokens: 0,
        cacheReadTokens: cacheRead
      })
      const snapshot: MeteringSnapshot = {
        engineId: 'opencode',
        vendorId: parsed.providerID,
        billingType: account?.billingType ?? 'unknown',
        tokens: { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead },
        equivalentCostUsd: equiv,
        engineReportedCostUsd: this.totalCostUsd,
        contextWindow: { used: 0, size: 0 }
        // window omitted — opencode has no usage provider (cumulative meter)
      }
      this.send('session:metering', snapshot)
    } catch {
      /* advisory — never breaks the turn */
    }
  }

  dispose(): void {
    this.cancel()
  }
}
