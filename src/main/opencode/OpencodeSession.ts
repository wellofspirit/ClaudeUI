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
  AccountRef
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import { logger } from '../services/logger'
import { mapEvent, extractToolResult } from './event-mapper'
import type { MapperOutput, MessageAccumulator } from './event-mapper'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'

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

  dispose(): void {
    this.cancel()
  }
}
