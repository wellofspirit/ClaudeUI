import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
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
  PendingApproval,
  StatusLineData
} from '../../shared/types'
import { engineMeta } from '../../shared/engine-meta'
import { PI_DEFAULT_MODEL } from '../../shared/engine-meta'
import { logger } from '../services/logger'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { locatePiBinary } from './pi-locate'
import { PiRpcClient } from './PiRpcClient'
import { mapPiEvent, createPiMapperState } from './event-mapper'
import type { PiMapperOutput, PiMapperState } from './event-mapper'
import type { PiGetCommandsData, PiGetSessionStatsData, PiGetStateData, PiRpcCommand } from './pi-protocol'
import { getPiModelCatalog } from './model-discovery'
import { findPiSessionFile, loadPiSessionHistory } from '../services/pi-session-list'
import { recordUsageEvent } from '../services/usage-recorder'
import { PiBridgeHost, writeBridgeExtension } from './PiBridgeHost'
import type { GateDecision, PiToolCallPayload } from './PiBridgeHost'
import {
  decide,
  mergedClaudeRulesFor,
  sessionAllowKey,
  firstMatchingRule,
  normalizeWhitespace,
  PI_TOOL_TO_CLAUDE_TOOL
} from './permission-engine'
import type { MergedClaudeRules } from './permission-engine'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import { suggestionDestinationToScope, suggestionRuleToClaudeString } from '../opencode/permission-compiler'
// Reused AS-IS (not copied/forked — ADR-026 additive-only on shared seams):
// pure key/value dedup+throttle gate, no opencode-specific assumption baked
// in (verified — takes a caller-supplied emit callback and ambient
// setTimeout/clearTimeout only).
import { BashStreamGate } from '../opencode/bash-stream-gate'

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
 * M1 scope: full-auto chat (stream, tool cards, usage/cost, abort, cancel,
 * resume+replay). M2a ADDS the enforcement path: every spawn also starts a
 * PiBridgeHost (loopback HTTP, per-session bearer token) and writes the
 * ClaudeUI-owned bridge extension (pi-bridge-source.ts) to a temp file passed
 * via `-e`; the extension's `pi.on('tool_call', …)` hook calls back into
 * `gateToolCall`, which runs the pure PiPermissionEngine (permission-engine.ts)
 * against the live autonomy mode + the user's merged Claude permission rules
 * and either answers immediately (allow/deny) or surfaces a
 * `session:approval-request` and awaits the human via `resolveApproval`. M2b
 * ADDS interaction parity: mid-turn `steer` (not just queued follow-up),
 * spawn-time + live effort (`set_thinking_level`), slash-command/skill
 * discovery (`get_commands`), and live bash output streaming
 * (`tool_execution_update` → BashStreamGate, imported as-is from opencode) —
 * see PI_ENGINE_CAPABILITIES' doc comment for the full per-flag flip plan.
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
  /** The effort an explicit request actually carried (EngineSpawnOptions.effort,
   *  or a pre-spawn setEffort() — undefined when neither happened). Mirrors
   *  `requestedModel`'s exact pattern: only a present value triggers a
   *  `set_thinking_level` RPC call, applied in doStart() (spawn-time) or
   *  immediately (live setEffort() with a running client). */
  private requestedEffort: string | undefined
  private permissionMode: string
  private resumeSessionId: string | undefined

  // ── Slash commands + skills (M2b) ────────────────────────────────────────────
  /** Command names discovered via `get_commands` (doStart(), once per spawn),
   *  RAW as pi reports them (e.g. 'skill:brave-search' — NOT '/'-prefixed, NOT
   *  skill:-stripped; those transforms happen only in the session:slash-commands
   *  / session:skills emissions below). UNLIKE OpencodeSession's
   *  identically-named field, pi needs NO routing off this set: pi's own
   *  `prompt` command expands `/skill:name`/`/template` and executes extension
   *  commands directly, server-side (verified — docs/protocol-pi/README.md
   *  "Extensions") — so run(prompt) already forwards every prompt, slash-prefixed
   *  or not, verbatim. Kept for parity/future use. */
  private knownCommandNames = new Set<string>()

  // ── Live bash output streaming (M2b) ─────────────────────────────────────────
  /** Reused AS-IS from opencode (src/main/opencode/bash-stream-gate.ts) — pure
   *  dedup + trailing-edge throttle, no opencode-specific assumption. Dedups
   *  unchanged cumulative `tool_execution_update` snapshots and throttles
   *  emissions to ~100ms per toolUseId. Cancelled per-toolUseId on the
   *  matching tool_result, and entirely on cancel()/dispose()/an unexpected exit. */
  private bashStreamGate = new BashStreamGate((toolUseId, output) => {
    this.send('session:bash-output', {
      toolUseId,
      output,
      totalLines: output.split('\n').length,
      totalBytes: Buffer.byteLength(output, 'utf-8')
    })
  })

  // ── Approval bridge (M2a) ────────────────────────────────────────────────────
  /** Per-session loopback HTTP host the bridge extension calls into. Started in doStart(); disposed in cancel()/dispose() and on an unexpected exit. */
  private bridgeHost: PiBridgeHost | null = null
  /** One entry per in-flight 'ask' gate, keyed by a freshly minted requestId (NOT toolCallId — mirrors PendingApproval.requestId's own identity). Resolved by resolveApproval() or force-denied by interrupt()/cancel()/an unexpected exit. */
  private pendingGates = new Map<
    string,
    { resolve: (decision: GateDecision) => void; toolName: string; input: Record<string, unknown> }
  >()
  /** "Allow for this session" entries — bare pi tool name, or `bash:<normalized command>` for bash (see permission-engine.ts's sessionAllowKey). */
  private sessionAllows = new Set<string>()
  /** Lazily loaded, cached merge of the user/project/local Claude permission scopes. Invalidated by notifySettingsChanged() and by persistAllowRules() (so a just-persisted rule is honored on the very next gate call in this same session). */
  private cachedRules: MergedClaudeRules | null = null

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
    // sandboxConfig/thinkingMode/resumeSessionAt/forkSession are intentionally
    // unread — Claude-only options per EngineSpawnOptions' docs / ADR-030.
    // `effort` IS consumed (M2b) — see doStart()'s spawn-time effort application.
    this.requestedModel = opts.model
    this.requestedEffort = opts.effort
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
    // Warm the auth probe so status.account resolves shortly after construction
    // (mirrors OpencodeSession's opencodeAuthProvider.warmCache().then(sendStatus)
    // constructor call) — account stays null on the very first sendStatus() above
    // until this resolves.
    piAuthProvider
      .probe()
      .then(() => this.sendStatus())
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
      // From the LAST piAuthProvider.probe() snapshot (constructor warms it —
      // see below); null until that resolves or if the vendor has no auth.json
      // entry (mirrors OpencodeSession's identical buildAccountRef usage).
      account: piAuthProvider.buildPiAccountRef(model.vendorId),
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
   *  (contextWindow/maxOutput/vision/reasoning) — falls back to
   *  piModelCapabilities' bare defaults if the catalog is unavailable or has
   *  no matching entry. `reasoning` (M2b) drives the effort picker: true only
   *  when the CATALOG says this specific model accepts `set_thinking_level`. */
  private async resolveCapsForModel(modelValue: string): Promise<ResolvedCapabilities> {
    try {
      const ref = engineMeta('pi').decodeModelValue(modelValue)
      const catalog = await getPiModelCatalog()
      const match = catalog.find((m) => m.provider === ref.vendorId && m.id === ref.modelId)
      return resolvePiCapabilities(
        match
          ? {
              vision: match.input.includes('image'),
              contextWindow: match.contextWindow,
              maxOutput: match.maxTokens,
              reasoning: match.reasoning
            }
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

  /**
   * Shared-skills discovery (M3): the concrete, EXISTING skill directories to
   * hand the bridge extension's `resources_discover` handler via env var
   * (`CLAUDEUI_PI_SKILL_DIRS`, `path.delimiter`-joined — the extension just
   * splits it, no fs access there; see pi-bridge-source.ts). Claude skills are
   * SKILL.md dirs under `~/.claude/skills/*` and `<cwd>/.claude/skills/*` — the
   * same agentskills convention pi itself uses (vendor/pi-cli/docs/skills.md's
   * "Using Skills from Other Harnesses" documents exactly this
   * `["~/.claude/skills", "../.claude/skills"]`-style settings array).
   *
   * Returns `{}` (key entirely ABSENT, not an empty-string value) when neither
   * dir exists — keeps the bridge extension's own env-var-presence gate
   * meaningful (an empty string would still be "present").
   */
  private computeSkillDirsEnv(): Record<string, string> {
    const candidates = [join(homedir(), '.claude', 'skills'), join(this.cwd, '.claude', 'skills')]
    const existing = candidates.filter((dir) => {
      try {
        return existsSync(dir)
      } catch {
        return false
      }
    })
    return existing.length > 0 ? { CLAUDEUI_PI_SKILL_DIRS: existing.join(delimiter) } : {}
  }

  private async doStart(): Promise<void> {
    const bin = locatePiBinary()
    if (!bin) {
      throw new Error(
        'pi binary not found — run `bun run ensure-pi` to vendor it ' +
          '(vendor/pi-cli/pi' + (process.platform === 'win32' ? '.exe' : '') + ' is missing).'
      )
    }

    // Approval bridge (M2a): a fresh loopback host + version-keyed extension
    // file per spawn (docs/protocol-pi/README.md "Extensions"; pi-bridge-
    // source.ts). Started BEFORE the pi child so the URL/token are ready to
    // hand to it via env. If the child then fails to spawn, the orphaned host
    // is disposed below rather than leaked.
    const bridgeHost = new PiBridgeHost(this.gateToolCall)
    let bridge: { url: string; token: string }
    try {
      bridge = await bridgeHost.start()
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    const bridgePath = writeBridgeExtension()

    const args = ['--mode', 'rpc', '-e', bridgePath]
    if (this.resumeSessionId) {
      // Resolve the on-disk file for the resume id; fall back to the raw id
      // (verified: --session accepts an absolute file path) if not found —
      // pi will then report whatever it can, rather than us refusing to spawn.
      const resolvedPath = findPiSessionFile(this.resumeSessionId)
      args.push('--session', resolvedPath ?? this.resumeSessionId)
    }

    const client = new PiRpcClient(bin, {
      cwd: this.cwd,
      args,
      env: {
        CLAUDEUI_PI_BRIDGE_URL: bridge.url,
        CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
        ...this.computeSkillDirsEnv()
      }
    })
    try {
      await client.start()
    } catch (err) {
      bridgeHost.dispose()
      throw err
    }
    this.bridgeHost = bridgeHost
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
      // The process is gone — any pending gate can never be resolved by it;
      // deny is the only sane resolution (also prevents a ghost approval card
      // from silently persisting-a-rule for a tool call that no longer exists
      // if the user later clicks it).
      this.rejectAllPendingGates('Interrupted')
      if (this.bridgeHost) {
        this.bridgeHost.dispose()
        this.bridgeHost = null
      }
      // Nothing left to flush to once the process is gone — a firing timer
      // after this would send() to a session whose engine is disconnected.
      this.bashStreamGate.cancelAll()
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

    // Spawn-time effort (M2b): apply EngineSpawnOptions.effort (or a
    // setEffort() call that arrived before this spawn finished) once the
    // model this session actually ended up running with is known. Re-resolve
    // caps for `this._model` RIGHT NOW rather than trusting `this._capabilities`
    // — the constructor's OWN resolveCapsForModel().then() runs concurrently
    // with this whole doStart() and may not have landed yet, and the
    // `requestedModel` branch above never re-resolves caps on a SUCCESSFUL
    // set_model (only the "adopt" fallback does), so `this._capabilities`
    // can still be stale for the just-applied model at this exact point.
    if (this.requestedEffort) {
      const effort = this.requestedEffort
      this._capabilities = await this.resolveCapsForModel(this._model).catch(() => this._capabilities)
      this.sendStatus()
      if (this._capabilities.reasoning.effort != null) {
        this.setEffort(effort)
      }
    }

    // Slash commands + skills (M2b): get_commands lists extension commands,
    // prompt templates, and skill:* entries (vendor/pi-cli/docs/rpc.md
    // "get_commands"). Once per spawn, best-effort — a failure here must
    // never block the session (discovery is optional, mirrors
    // OpencodeSession.eagerConnect's identical treatment of
    // listCommands/listSkills).
    try {
      const resp = await client.request<PiGetCommandsData>({ type: 'get_commands' })
      if (resp.success && resp.data) {
        // sourceInfo.scope === 'temporary' entries are per-spawn extension
        // artifacts (verified doc drift — docs/protocol-pi/README.md
        // "Extensions": a `-e <file.ts>` extension "appears in get_commands
        // with sourceInfo.scope: 'temporary'"). Our OWN bridge extension
        // (pi-bridge-source.ts) registers no commands today, so none of
        // these are ours in practice — filtered defensively anyway, so a
        // future bridge change (or another -e extension) never leaks a
        // ClaudeUI-internal or otherwise-ephemeral artifact into the
        // user-facing slash menu.
        const persistent = resp.data.commands.filter((c) => c.sourceInfo?.scope !== 'temporary')

        this.knownCommandNames = new Set(persistent.map((c) => c.name))
        logger.debug('PiSession', `get_commands discovered ${this.knownCommandNames.size} command(s)`)

        // EXACT contract as OpencodeSession.eagerConnect (names get the '/'
        // prefix; renderer slash menu is engine-neutral).
        const slashCommands = persistent.map((c) => ({ name: '/' + c.name, description: c.description }))
        this.send('session:slash-commands', slashCommands)

        // session:skills — name list only, `skill:` prefix stripped (same
        // bare-name contract as OpencodeSession.eagerConnect's skillNames).
        const skillNames = persistent
          .filter((c) => c.source === 'skill')
          .map((c) => c.name.replace(/^skill:/, ''))
        this.send('session:skills', skillNames)
      }
    } catch (err) {
      logger.warn(
        'PiSession',
        `get_commands failed (best-effort, discovery is optional): ${err instanceof Error ? err.message : String(err)}`
      )
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
    // rejects it (verified — README.md "Commands"). 'steer' (M2b — Claude
    // parity): delivered after the CURRENT tool calls finish, before the next
    // LLM call within the SAME turn (verified), not 'followUp' (queued until
    // the whole run settles) — see PI_ENGINE_CAPABILITIES' doc comment for why
    // `queue` stays true alongside `steer`.
    if (wasBusy) command.streamingBehavior = 'steer'

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
        // Live bash output streaming (M2b): drop this toolUseId's throttle
        // tracking now that the final result is in — a no-op for any
        // non-bash / never-streamed toolUseId (BashStreamGate.cancel on an
        // absent key is a harmless no-op).
        this.bashStreamGate.cancel(output.toolUseId)
        this.send('session:tool-result', {
          toolUseId: output.toolUseId,
          result: output.result,
          isError: output.isError,
          ...(output.fileDiffs ? { fileDiffs: output.fileDiffs } : {})
        })
        break

      case 'bash_output':
        // Mirrors OpencodeSession's own call-site guard (event-mapper.ts
        // always emits this kind for a bash tool_execution_update — even one
        // with empty accumulated text — so the length check belongs here,
        // not in the pure mapper).
        if (output.output.length > 0) {
          this.bashStreamGate.update(output.toolUseId, output.output)
        }
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
    // Deny FIRST (synchronous, local) — a hanging extension fetch would
    // otherwise wedge pi's turn forever waiting on a human who just hit stop.
    this.rejectAllPendingGates('Interrupted')
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
    this.rejectAllPendingGates('Interrupted')
    if (this.client) {
      this.client.dispose()
      this.client = null
    }
    if (this.bridgeHost) {
      this.bridgeHost.dispose()
      this.bridgeHost = null
    }
    // Drop all pending bash-output throttle timers — nothing left to flush to
    // once the session is torn down (mirrors OpencodeSession.cancel()'s
    // identical call).
    this.bashStreamGate.cancelAll()
    this.startedPromise = null
    this.sendStatus()
  }

  // ── Approval bridge (M2a) ────────────────────────────────────────────────────

  /**
   * Handler passed to PiBridgeHost — invoked once per `tool_call` hook firing
   * in the pi child. Runs the pure PiPermissionEngine against the live
   * autonomy mode + the user's merged Claude permission rules; 'allow'/'deny'
   * answer immediately, 'ask' surfaces a `session:approval-request` and awaits
   * the human via resolveApproval(). Bound as a class field (not a prototype
   * method) so passing a bare reference to `new PiBridgeHost(this.gateToolCall)`
   * keeps `this` correct.
   */
  private gateToolCall = async (payload: PiToolCallPayload): Promise<GateDecision> => {
    const { toolCallId, toolName, input } = payload
    const rules = this.currentRules()
    const decision = decide(toolName, input, {
      mode: this.permissionMode,
      rules,
      sessionAllows: this.sessionAllows
    })

    if (decision === 'allow') return { behavior: 'allow' }

    if (decision === 'deny') {
      const matched = firstMatchingRule(rules.deny, toolName, input)
      return {
        behavior: 'deny',
        reason: matched ? `Denied by permission rule: ${matched}` : 'Denied by permission rules'
      }
    }

    // 'ask' — surface to the renderer and await the human's decision
    // (resolveApproval resolves the stored promise below).
    return new Promise<GateDecision>((resolve) => {
      const requestId = uuid()
      this.pendingGates.set(requestId, { resolve, toolName, input })
      const suggestions = this.buildApprovalSuggestions(toolName, input)
      const approval: PendingApproval = {
        requestId,
        toolUseId: toolCallId,
        toolName,
        input,
        ...(suggestions ? { suggestions } : {})
      }
      this.send('session:approval-request', approval)
    })
  }

  /** Resolve every in-flight 'ask' gate with a deny (used by interrupt/cancel/an unexpected exit) and clear the map. */
  private rejectAllPendingGates(reason: string): void {
    for (const pending of this.pendingGates.values()) {
      pending.resolve({ behavior: 'deny', reason })
    }
    this.pendingGates.clear()
  }

  /** Lazily load (and cache) the merged user/project/local Claude permission rules for this session's cwd. */
  private currentRules(): MergedClaudeRules {
    if (!this.cachedRules) this.cachedRules = mergedClaudeRulesFor(this.cwd)
    return this.cachedRules
  }

  /**
   * Build "always allow" suggestions for an 'ask' approval — mirrors the
   * opencode event-mapper's permission.asked suggestion shape (one
   * PermissionSuggestion per destination) but offers ALL three persistable
   * scopes (user/project/local) rather than opencode's single default, giving
   * the user the same 3-way choice Claude's native prompts do. bash gets a
   * PREFIX rule (`Bash(<command>:*)` — the whole typed command plus a
   * trailing glob, matching Claude's own suggestion convention and round-
   * tripping through permission-engine.ts's bash prefix matcher); every other
   * mapped tool gets a bare tool rule. Returns undefined for a pi tool with no
   * Claude analog (mcp/custom/unknown) — nothing persistable to suggest.
   */
  private buildApprovalSuggestions(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionSuggestion[] | undefined {
    const claudeTool = PI_TOOL_TO_CLAUDE_TOOL[toolName]
    if (!claudeTool) return undefined

    const ruleContent =
      toolName === 'bash' ? `${normalizeWhitespace(String(input.command ?? ''))}:*` : undefined
    const rule = { toolName: claudeTool, ...(ruleContent ? { ruleContent } : {}) }

    const destinations = ['userSettings', 'projectSettings', 'localSettings'] as const
    return destinations.map((destination) => ({
      type: 'addRules',
      behavior: 'allow',
      destination,
      rules: [rule]
    }))
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const pending = this.pendingGates.get(requestId)
    if (!pending) {
      logger.warn('PiSession', `resolveApproval(${requestId}) called but no matching pending gate`)
      return
    }
    this.pendingGates.delete(requestId)

    if (decision === 'deny') {
      pending.resolve({ behavior: 'deny', reason: answers?.feedback || 'User denied' })
      return
    }

    // allow / allowForSession
    if (decision === 'allowForSession') {
      this.sessionAllows.add(sessionAllowKey(pending.toolName, pending.input))
    }
    pending.resolve({ behavior: 'allow' })

    if (updatedPermissions && updatedPermissions.length > 0) {
      this.persistAllowRules(updatedPermissions)
    }
  }

  /**
   * Write "always allow" suggestions to the shared Claude permission store —
   * mirrors OpencodeSession.persistAllowRules (same shared helpers
   * `suggestionDestinationToScope`/`suggestionRuleToClaudeString` from
   * permission-compiler.ts; the small grouping loop is intentionally
   * duplicated here rather than extracted, per the M2a kickoff spec). Also
   * invalidates the rules cache so the newly-persisted rule is honored on the
   * VERY NEXT gate call in this same session, without waiting for an explicit
   * notifySettingsChanged().
   */
  private persistAllowRules(suggestions: PermissionSuggestion[]): void {
    try {
      const byScope = new Map<'user' | 'project' | 'local', string[]>()
      for (const s of suggestions) {
        if (s.type !== 'addRules' || s.behavior !== 'allow' || !s.rules) continue
        const scope = suggestionDestinationToScope(s.destination)
        if (!scope) continue
        const arr = byScope.get(scope) ?? []
        for (const r of s.rules) arr.push(suggestionRuleToClaudeString(r))
        byScope.set(scope, arr)
      }
      for (const [scope, ruleStrings] of byScope) {
        const perms = loadClaudePermissions(scope, this.cwd)
        const allowSet = new Set(perms.allow)
        for (const r of ruleStrings) allowSet.add(r)
        saveClaudePermissions(scope, { ...perms, allow: [...allowSet] }, this.cwd)
      }
      if (byScope.size > 0) this.cachedRules = null
    } catch (err) {
      logger.warn('PiSession', `persisting allow rules failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Hot-reload parity with Claude: invalidate the cached rules so the NEXT gate call re-reads the (just-edited) permission files from disk. */
  async notifySettingsChanged(): Promise<void> {
    this.cachedRules = null
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

  /**
   * ISession.setEffort (M2b) — sends `set_thinking_level {level: effort}`.
   * Void, not async (ISession's optional-member contract): callers
   * (handlers-core.ts's setEffort) invoke this WITHOUT awaiting, so the RPC
   * round-trip below is genuinely fire-and-forget from the caller's
   * perspective — both failure paths (success:false AND a thrown/rejected
   * request) are caught and reported internally, mirroring setModel's
   * session:error failure shape, so neither becomes an unhandled rejection.
   */
  setEffort(effort: string): void {
    if (!this.client) {
      // Pre-spawn: record for application in doStart() (mirrors setModel's
      // identical pre-spawn branch) — the eventual doStart() applies the
      // user's LATEST choice, not a stale constructor value.
      this.requestedEffort = effort
      return
    }
    this.client
      .request({ type: 'set_thinking_level', level: effort })
      .then((resp) => {
        if (!resp.success) {
          this.send('session:error', resp.error ?? `Failed to set thinking level "${effort}"`)
        }
      })
      .catch((err) => {
        logger.warn(
          'PiSession',
          `setEffort(set_thinking_level) failed: ${err instanceof Error ? err.message : String(err)}`
        )
        this.send('session:error', err instanceof Error ? err.message : String(err))
      })
  }

  async setPermissionMode(mode: string): Promise<void> {
    // Store + broadcast only — gateToolCall reads this.permissionMode live on
    // every tool_call, so a mode switch takes effect on the very next gate
    // with no RPC round-trip needed (unlike opencode's patchSession).
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
