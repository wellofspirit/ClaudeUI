import type { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import { resolvePiCapabilities } from '../../shared/model-capabilities'
import type {
  ChatMessage,
  ContentBlock,
  SessionStatus,
  ApprovalDecision,
  PermissionSuggestion,
  StatusLineData
} from '../../shared/types'
import { engineMeta } from '../../shared/engine-meta'
import { PI_DEFAULT_MODEL } from '../../shared/engine-meta'
import { logger } from '../services/logger'
import { locatePiBinary } from './pi-locate'
import { PiRpcClient } from './PiRpcClient'
import { mapPiEvent, createPiMapperState } from './event-mapper'
import type { PiMapperOutput, PiMapperState } from './event-mapper'
import type { PiGetSessionStatsData, PiGetStateData, PiRpcCommand } from './pi-protocol'
import { getPiModelCatalog } from './model-discovery'
import { findPiSessionFile, loadPiSessionHistory } from '../services/pi-session-list'
import { recordUsageEvent } from '../services/usage-recorder'

/**
 * PiSession — engine-neutral session backend for the pi coding agent.
 *
 * Unlike opencode (one shared HTTP server per cwd), pi has no server mode: this
 * is the CLAUDE-shaped lifecycle — one `pi --mode rpc` child process per
 * ClaudeUI session, spawned lazily on first `run()`, killed on cancel/dispose
 * (see docs/protocol-pi/README.md "Transport"). Mirrors OpencodeSession's
 * overall structure (capabilities split, cost accumulation, status-line
 * building) with the RPC-child-process specifics swapped in for the HTTP/SSE
 * ones.
 *
 * M1 scope only: full-auto chat (stream, tool cards, usage/cost, abort,
 * cancel, resume+replay). NO interactive approvals (pi executes tools
 * ungated until the M2 approval-bridge extension lands — see
 * PI_ENGINE_CAPABILITIES' doc comment for the full per-flag flip plan).
 */
export class PiSession extends BaseSession {
  readonly engineId = 'pi' as const

  private _capabilities: ResolvedCapabilities
  get capabilities(): ResolvedCapabilities {
    return this._capabilities
  }

  private client: PiRpcClient | null = null
  /** pi's own session id (from `get_state`), once known. */
  private piSessionId: string | null = null
  private isProcessing = false
  /** Set true by cancel()/dispose(); guards a racing onEvent/onExit from acting on a torn-down session. */
  private _cancelled = false
  /** True after an unexpected process exit (crash) that wasn't our own cancel(). Cleared on the next successful spawn. */
  private disconnected = false
  /** Memoized spawn+init promise — see ensureStarted(). Cleared on cancel()/dispose() and on an unexpected exit so a later run() can respawn. */
  private startedPromise: Promise<void> | null = null
  /** Guards replayStoredHistory so a single PiSession object only ever replays once. */
  private replayedHistory = false

  private _model: string
  /** The model an explicit request actually carried (EngineSpawnOptions.model,
   *  or a pre-spawn setModel() — undefined when neither happened) — distinct
   *  from `_model`, which always has a value (defaulted). Only a present
   *  `requestedModel` triggers a `set_model` RPC call at spawn; see doStart()'s
   *  doc comment for why. */
  private requestedModel: string | undefined
  private permissionMode: string
  private resumeSessionId: string | undefined

  // ── Cost / usage accounting ────────────────────────────────────────────────
  private mapperState: PiMapperState = createPiMapperState()
  /** Cost from stored history, seeded ONCE on resume from `get_session_stats().cost`. */
  private costBaseUsd = 0
  private sumInputTokens = 0
  private sumOutputTokens = 0
  private sumCacheReadTokens = 0
  private sumCacheWriteTokens = 0
  /** Latest assistant turn's prompt size (input + cacheRead), for "context used %". */
  private lastContextLength = 0
  /** Accumulated ACTIVE (turn-processing) duration of completed turns, ms. Not seeded on
   *  resume in M1 (only cost is — see the kickoff spec's resume bullet); starts at 0. */
  private accTotalDurationMs = 0

  constructor(routingId: string, win: BrowserWindow, cwd: string, opts: EngineSpawnOptions = {}) {
    super(routingId, win, cwd)
    // effort/sandboxConfig/thinkingMode/resumeSessionAt/forkSession are intentionally
    // unread — Claude-only options per EngineSpawnOptions' docs / ADR-030.
    this.requestedModel = opts.model
    this._model = opts.model ?? PI_DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
    this.resumeSessionId = opts.resumeSessionId || undefined
    this._capabilities = resolvePiCapabilities()
    this.seedDispatchedCosts()
    this.sendStatus()
    this.sendStatusLine()
    // Refine capabilities asynchronously once the model catalog resolves
    // (mirrors OpencodeSession's constructor-time discovery warm + recompute).
    this.resolveCapsForModel(this._model)
      .then((caps) => {
        this._capabilities = caps
        this.sendStatus()
        this.sendStatusLine()
      })
      .catch(() => {})
  }

  get willQueue(): boolean {
    return this.isProcessing
  }

  private get totalCostUsd(): number {
    return this.costBaseUsd + this.mapperState.totalCostUsd
  }

  get status(): SessionStatus {
    const model = engineMeta('pi').decodeModelValue(this._model)
    return {
      state: this.disconnected ? 'disconnected' : this.isProcessing ? 'running' : 'idle',
      sessionId: this.piSessionId,
      model,
      cwd: this.cwd,
      totalCostUsd: this.totalCostUsd,
      // pi has no auth-probe integration in M1 (PiAuthProvider is M3) — always null.
      account: null,
      ...this.baseStatusFields()
    }
  }

  getSessionId(): string | null {
    return this.piSessionId
  }

  /** Public accessor for cross-engine dispatch (ADR-033) — unused while
   *  capabilities.crossEngineDispatch is false in M1 (pi is neither a
   *  dispatch source nor target yet), kept for interface parity with
   *  OpencodeSession's identical accessor so a future M4 wire-up is a pure
   *  addition, not a new method. */
  getAutonomyMode(): string {
    return this.permissionMode
  }

  protected override resetInactivityTimer(): void {
    this.clearInactivityTimer()
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        logger.info('PiSession', 'Idle timeout — auto-disconnecting')
        this.cancel()
      }, this.inactivityTimeoutMs)
    }
  }

  protected override onDispatchedCostsChanged(): void {
    this.sendStatusLine()
  }

  /** Resolve ResolvedCapabilities for a model VALUE from the discovery catalog
   *  (contextWindow/maxOutput/vision) — falls back to piModelCapabilities'
   *  bare defaults if the catalog is unavailable or has no matching entry. */
  private async resolveCapsForModel(modelValue: string): Promise<ResolvedCapabilities> {
    try {
      const ref = engineMeta('pi').decodeModelValue(modelValue)
      const catalog = await getPiModelCatalog()
      const match = catalog.find((m) => m.provider === ref.vendorId && m.id === ref.modelId)
      return resolvePiCapabilities(
        match
          ? { vision: match.input.includes('image'), contextWindow: match.contextWindow, maxOutput: match.maxTokens }
          : undefined
      )
    } catch {
      return resolvePiCapabilities()
    }
  }

  /**
   * Re-read pi's ACTUAL current model via a fresh `get_state` and adopt it
   * into `_model` (+ re-resolve capabilities), so status.model never lies.
   * Skips the "unknown" placeholder model pi reports when nothing is
   * configured (verified doc drift #3 — a placeholder object, never null).
   * Used after a failed set_model (both the spawn-time and live-setModel call
   * sites), where the optimistic `_model` assignment would otherwise keep the
   * failed/bogus value. Best-effort: returns false (leaving `_model`
   * unchanged) when the client is gone, get_state fails, or pi reports the
   * placeholder — callers decide the fallback.
   */
  private async adoptEngineModel(): Promise<boolean> {
    if (!this.client) return false
    try {
      const resp = await this.client.request<PiGetStateData>({ type: 'get_state' })
      const model = resp.success ? resp.data?.model : undefined
      if (!model || model.id === 'unknown') return false
      this._model = `${model.provider}/${model.id}`
      this._capabilities = await this.resolveCapsForModel(this._model).catch(() => this._capabilities)
      return true
    } catch {
      return false
    }
  }

  /**
   * Spawn the pi process, resolve state, apply the requested model, and wire
   * event dispatch — memoized so concurrent/repeated calls (run(null) eager
   * warm-up racing a real run(prompt)) share one spawn. On an unexpected exit,
   * the memo is cleared so the NEXT run() can respawn a fresh process rather
   * than being permanently stuck.
   */
  private ensureStarted(): Promise<void> {
    if (!this.startedPromise) {
      this.startedPromise = this.doStart().catch((err) => {
        this.startedPromise = null
        throw err
      })
    }
    return this.startedPromise
  }

  private async doStart(): Promise<void> {
    const bin = locatePiBinary()
    if (!bin) {
      throw new Error(
        'pi binary not found — run `bun run ensure-pi` to vendor it ' +
          '(vendor/pi-cli/pi' + (process.platform === 'win32' ? '.exe' : '') + ' is missing).'
      )
    }

    const args = ['--mode', 'rpc']
    if (this.resumeSessionId) {
      // Resolve the on-disk file for the resume id; fall back to the raw id
      // (verified: --session accepts an absolute file path) if not found —
      // pi will then report whatever it can, rather than us refusing to spawn.
      const resolvedPath = findPiSessionFile(this.resumeSessionId)
      args.push('--session', resolvedPath ?? this.resumeSessionId)
    }

    const client = new PiRpcClient(bin, { cwd: this.cwd, args })
    await client.start()
    this.client = client
    this.disconnected = false

    client.onEvent((ev) => {
      if (this._cancelled) return
      const outputs = mapPiEvent(ev, this.mapperState)
      this.dispatchOutputs(outputs)
    })
    client.onExit(() => {
      if (this._cancelled) return
      this.isProcessing = false
      this.disconnected = true
      this.client = null
      // Allow a later run() to respawn instead of being wedged forever.
      this.startedPromise = null
      this.sendStatus()
    })

    const stateResp = await client.request<PiGetStateData>({ type: 'get_state' })
    if (stateResp.success && stateResp.data) {
      this.piSessionId = stateResp.data.sessionId ?? null
      this.mapperState.sessionId = this.piSessionId

      // No explicit model request → pi keeps its OWN model (settings.json
      // default, or the one restored from a resumed session's model_change
      // entries). Adopt what the engine actually reports so status.model is
      // honest instead of parroting the PI_DEFAULT_MODEL constructor fallback
      // that never reached the wire. The "unknown" placeholder (no model
      // configured — verified doc drift #3) is skipped: keep the local default
      // rather than reporting a non-model.
      const engineModel = stateResp.data.model
      if (!this.requestedModel && engineModel && engineModel.id !== 'unknown') {
        this._model = `${engineModel.provider}/${engineModel.id}`
        this._capabilities = await this.resolveCapsForModel(this._model).catch(() => this._capabilities)
        this.sendStatus()
      }
    }

    // Only set_model when the CALLER explicitly requested one — an omitted
    // model means "use whatever pi already has" (see the adoption above).
    // Forcing PI_DEFAULT_MODEL's hardcoded guess here would fail loudly for a
    // user who has only authenticated a DIFFERENT provider.
    if (this.requestedModel) {
      const ref = engineMeta('pi').decodeModelValue(this.requestedModel)
      let applied = false
      try {
        const setResp = await client.request({
          type: 'set_model',
          provider: ref.vendorId,
          modelId: ref.modelId
        })
        applied = setResp.success
        if (!setResp.success) {
          this.send('session:error', setResp.error ?? `Failed to set model "${this.requestedModel}"`)
        }
      } catch (err) {
        this.send('session:error', err instanceof Error ? err.message : String(err))
      }
      // The requested model did NOT take — re-sync _model from the engine's
      // actual state so status.model reports what pi is really running rather
      // than the failed value. Best-effort: an unreadable state keeps the
      // current value (nothing better to report).
      if (!applied) {
        const adopted = await this.adoptEngineModel()
        if (adopted) this.sendStatus()
      }
    }

    if (this.resumeSessionId) {
      await this.replayStoredHistory(this.resumeSessionId)
    }
  }

  /**
   * Load stored messages for a resumed session and replay them to the renderer
   * as `session:message` (and `session:tool-result`) events, in order, BEFORE
   * the first new prompt — mirrors OpencodeSession.replayStoredHistory.
   *
   * Reuses `loadPiSessionHistory` (pi-session-list.ts) — the SAME conversion
   * path the sidebar loader uses — so live and replayed history render
   * identically. Best-effort: any failure is swallowed and logged; it NEVER
   * blocks the new prompt. Run-once: a single PiSession only ever replays once.
   */
  private async replayStoredHistory(sessionId: string): Promise<void> {
    if (this.replayedHistory) return
    this.replayedHistory = true
    try {
      const messages = await loadPiSessionHistory(sessionId)
      logger.info('PiSession', `Replaying ${messages.length} stored messages for ${sessionId}`)

      for (const msg of messages) {
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) this.messageHistory[idx] = msg
        else this.messageHistory.push(msg)

        this.send('session:message', msg)

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            this.send('session:tool-result', {
              toolUseId: block.toolUseId,
              result: block.toolResult,
              isError: block.isError ?? false
            })
          }
        }
      }

      // Seed the durable cost base from pi's own tally so totalCostUsd
      // continues from the prior total instead of restarting at 0.
      if (this.client) {
        const statsResp = await this.client.request<PiGetSessionStatsData>({ type: 'get_session_stats' })
        if (statsResp.success && statsResp.data) {
          this.costBaseUsd = statsResp.data.cost
          this.sumInputTokens = statsResp.data.tokens.input
          this.sumOutputTokens = statsResp.data.tokens.output
          this.sumCacheReadTokens = statsResp.data.tokens.cacheRead
          this.sumCacheWriteTokens = statsResp.data.tokens.cacheWrite
        }
      }
      this.sendStatusLine()
    } catch (err) {
      logger.warn(
        'PiSession',
        `replayStoredHistory failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Build the ContentBlock[] for a locally-recorded user ChatMessage. pi has
   * no document/PDF input (unlike Claude/opencode) — non-image attachments
   * are silently dropped, matching run()'s prompt-building rule.
   */
  private buildUserContent(
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): ContentBlock[] {
    const content: ContentBlock[] = []
    for (const att of attachments ?? []) {
      if (!att.mediaType.startsWith('image/')) continue // pi has no document input — PDFs silently dropped
      content.push({
        type: 'image',
        mediaType: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        base64Data: att.base64Data,
        fileName: att.fileName
      })
    }
    if (prompt) content.push({ type: 'text', text: prompt })
    return content
  }

  async run(
    prompt: string | null,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    this.clearInactivityTimer()
    this._cancelled = false

    // run(null): eager warm-up only (mirrors Claude/opencode's spawn-on-create
    // pattern) — spawns the process (and replays history on resume) before the
    // first real prompt arrives. Failures degrade silently; a real run(prompt)
    // will surface them via session:error.
    if (prompt === null) {
      this.ensureStarted().catch((err) => {
        logger.warn('PiSession', `eager ensureStarted failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      this.resetInactivityTimer()
      return
    }

    const wasBusy = this.isProcessing

    try {
      await this.ensureStarted()
    } catch (err) {
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
      return
    }
    if (this._cancelled || !this.client) {
      this.sendStatus()
      this.resetInactivityTimer()
      return
    }

    // Record the user message locally (for getMessages()). Do NOT emit
    // session:message — the renderer adds it optimistically (addUserMessage).
    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: this.buildUserContent(prompt, attachments),
      timestamp: Date.now()
    }
    this.messageHistory.push(userMsg)

    const images = (attachments ?? [])
      .filter((att) => att.mediaType.startsWith('image/'))
      .map((att) => ({ type: 'image' as const, data: att.base64Data, mimeType: att.mediaType }))

    const command: PiRpcCommand = { type: 'prompt', message: prompt }
    if (images.length > 0) command.images = images
    // A prompt sent while already streaming REQUIRES streamingBehavior or pi
    // rejects it (verified — README.md "Commands"). 'followUp' (queued until
    // the current run settles), not 'steer' (mid-turn injection) — see
    // PI_ENGINE_CAPABILITIES' doc comment for why M1 chose follow-up semantics.
    if (wasBusy) command.streamingBehavior = 'followUp'

    if (!wasBusy) this.mapperState.startTimeMs = Date.now()
    this.isProcessing = true
    this.sendStatus()

    try {
      const resp = await this.client.request(command)
      if (!resp.success) {
        this.isProcessing = false
        this.send('session:error', resp.error ?? 'pi rejected the prompt')
        this.sendStatus()
        this.resetInactivityTimer()
        return
      }
      // Busy-path ack: lets the renderer's shared queued-message UI resolve
      // (onSteerConsumed → consumeQueuedText) exactly as Claude/opencode do.
      if (wasBusy) this.send('session:steer-consumed', { prompt })
    } catch (err) {
      this.isProcessing = false
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
    }
  }

  private dispatchOutputs(outputs: PiMapperOutput[]): void {
    for (const output of outputs) this.dispatchOutput(output)
  }

  private dispatchOutput(output: PiMapperOutput): void {
    switch (output.kind) {
      case 'stream':
        this.send('session:stream', { type: output.streamType, text: output.delta })
        break

      case 'message': {
        const idx = this.messageHistory.findIndex((m) => m.id === output.message.id)
        if (idx >= 0) this.messageHistory[idx] = output.message
        else this.messageHistory.push(output.message)
        this.send('session:message', output.message)
        break
      }

      case 'tool_result':
        this.send('session:tool-result', {
          toolUseId: output.toolUseId,
          result: output.result,
          isError: output.isError,
          ...(output.fileDiffs ? { fileDiffs: output.fileDiffs } : {})
        })
        break

      case 'usage':
        recordUsageEvent({
          engineId: 'pi',
          vendorId: output.provider,
          // pi has no auth-provider integration in M1 (PiAuthProvider is M3).
          accountId: null,
          accountUuid: null,
          modelId: output.modelId,
          tokens: {
            input: output.tokens.input,
            output: output.tokens.output,
            cacheWrite: output.tokens.cacheWrite,
            cacheWrite1h: 0, // pi does not distinguish 1h-TTL cache writes
            cacheRead: output.tokens.cacheRead
          },
          engineCostUsd: output.costUsd,
          sessionId: this.piSessionId,
          messageId: output.messageId,
          source: 'live'
        })
        this.sumInputTokens += output.tokens.input
        this.sumOutputTokens += output.tokens.output
        this.sumCacheReadTokens += output.tokens.cacheRead
        this.sumCacheWriteTokens += output.tokens.cacheWrite
        this.lastContextLength = output.tokens.input + output.tokens.cacheRead
        this.sendStatusLine()
        break

      case 'result':
        this.isProcessing = false
        this.accTotalDurationMs += output.durationMs
        this.sendStatusLine()
        this.send('session:result', {
          // output.totalCostUsd is the LIVE-only value (mapperState has no
          // notion of the seeded historical base) — override with the getter
          // so a resumed session's result payload reports the same durable
          // total as the status line / session:status (mirrors OpencodeSession).
          totalCostUsd: this.totalCostUsd,
          durationMs: output.durationMs,
          result: '',
          sessionId: output.sessionId
        })
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'error':
        this.send('session:error', output.message)
        break

      case 'ignore':
        break
    }
  }

  async interrupt(): Promise<void> {
    if (!this.client) return
    try {
      await this.client.request({ type: 'abort' })
    } catch (err) {
      logger.warn('PiSession', `abort failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  cancel(): void {
    this.clearInactivityTimer()
    this._cancelled = true
    this.isProcessing = false
    this.disconnected = false
    if (this.client) {
      this.client.dispose()
      this.client = null
    }
    this.startedPromise = null
    this.sendStatus()
  }

  resolveApproval(
    requestId: string,
    _decision: ApprovalDecision,
    _answers?: Record<string, string>,
    _updatedPermissions?: PermissionSuggestion[]
  ): void {
    // M1: interactiveApprovals is false — pi executes tools ungated, so no
    // approval-request is ever emitted and this should never be called. Kept
    // as a satisfying-ISession no-op stub until the M2 approval-bridge extension lands.
    logger.warn('PiSession', `resolveApproval(${requestId}) called but pi has no pending approvals in M1`)
  }

  async setModel(model: string): Promise<void> {
    const prevModel = this._model
    this._model = model
    if (this.client) {
      const ref = engineMeta('pi').decodeModelValue(model)
      let applied = false
      try {
        const resp = await this.client.request({ type: 'set_model', provider: ref.vendorId, modelId: ref.modelId })
        applied = resp.success
        if (!resp.success) {
          this.send('session:error', resp.error ?? `Failed to set model "${model}"`)
        }
      } catch (err) {
        this.send('session:error', err instanceof Error ? err.message : String(err))
      }
      // Failed switch: never keep the bogus value in status.model. Prefer the
      // engine's actual current model (fresh get_state); if that read also
      // fails, fall back to the pre-switch value — both are honest, the failed
      // value is not.
      if (!applied) {
        const adopted = await this.adoptEngineModel()
        if (!adopted) this._model = prevModel
      }
    } else {
      // Pre-spawn model change: also update the pending spawn request so the
      // eventual doStart() applies the user's LATEST choice, not the stale
      // constructor value.
      this.requestedModel = model
    }
    this._capabilities = await this.resolveCapsForModel(this._model).catch(() => this._capabilities)
    this.sendStatus()
    this.sendStatusLine()
  }

  async setPermissionMode(mode: string): Promise<void> {
    // Stored only in M1 — pi has no permission-mode enforcement until the M2
    // approval-bridge extension lands (interactiveApprovals: false).
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
  }

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  /**
   * Build a StatusLineData snapshot. Context "used" = lastContextLength (latest
   * turn's input+cacheRead), matching OpencodeSession's semantic. modelCosts
   * carries only cross-engine dispatched entries (always empty in M1 — pi is
   * not a valid dispatch source/target yet) — no own-model cost breakdown
   * (deliberately simplified: pi's `get_session_stats` seed on resume gives a
   * single total, not a per-model split, so a synthesized breakdown could
   * under-report against the headline totalCostUsd; deferred to a follow-up).
   */
  private buildStatusLine(): StatusLineData {
    const ctx = this._capabilities.contextWindow
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0 ? Math.round((this.lastContextLength / ctx) * 100) : null
    const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
    const cachedTokens = this.sumCacheReadTokens + this.sumCacheWriteTokens
    const totalTokens = this.sumInputTokens + this.sumOutputTokens + cachedTokens
    return {
      totalCostUsd: this.totalCostUsd,
      totalDurationMs: this.accTotalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: this.sumInputTokens,
      totalOutputTokens: this.sumOutputTokens,
      cachedTokens,
      totalTokens,
      contextWindowSize: ctx,
      usedPercentage,
      remainingPercentage,
      turnStartedAtMs: this.isProcessing && this.mapperState.startTimeMs > 0 ? this.mapperState.startTimeMs : null,
      modelCosts: this.dispatchedCostEntries()
    }
  }

  private sendStatusLine(): void {
    this.send('session:status-line', this.buildStatusLine())
  }

  dispose(): void {
    this.cancel()
  }
}
