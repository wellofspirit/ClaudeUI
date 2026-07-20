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
import type { GateDecision, PiHostedToolHandler, PiHostedToolPayload, PiHostedToolResult, PiToolCallPayload } from './PiBridgeHost'
// Hosted tools (M4a) — the SAME in-process MCP tool factories Claude/opencode
// use (mermaid-tool.ts/mockup-tool.ts); handleHostedTool below extracts
// `.tools[].handler` and calls it directly, exactly like
// opencode-hosted-tools.ts's identical reuse pattern.
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
// Cross-engine dispatch (M4b, ADR-033) — pi as a dispatch SOURCE here; pi as
// a TARGET is handled separately (M4c, shipped — see cross-engine-dispatcher.ts's
// gatePiTargetToolCall). CALLED, never modified — mirrors collab-tool.ts's
// Claude-side DispatchContext construction, NOT via MCP (pi has no MCP
// client of its own).
import { crossEngineDispatcher, crossEngineDispatchAvailable } from '../services/cross-engine-dispatcher'
import type { DispatchContext, DispatchRequest } from '../services/cross-engine-dispatcher'
import {
  decide,
  mergedClaudeRulesFor,
  sessionAllowKey,
  firstMatchingRule,
  normalizeWhitespace,
  PI_TOOL_TO_CLAUDE_TOOL,
  PI_HOSTED_TOOL_NAMES
} from './permission-engine'
import type { MergedClaudeRules } from './permission-engine'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import { suggestionDestinationToScope, suggestionRuleToClaudeString } from '../opencode/permission-compiler'
// Reused AS-IS (not copied/forked — ADR-026 additive-only on shared seams):
// pure key/value dedup+throttle gate, no opencode-specific assumption baked
// in (verified — takes a caller-supplied emit callback and ambient
// setTimeout/clearTimeout only).
import { BashStreamGate } from '../opencode/bash-stream-gate'

/** Fail-closed default for an unrecognized /hosted-tool toolName (defense in depth — the bridge extension only ever sends the four names it registers, but handleHostedTool must never crash on an unexpected one). */
function unknownHostedTool(toolName: string): PiHostedToolResult {
  return { content: [{ type: 'text', text: `Unknown hosted tool "${toolName}"` }], isError: true }
}

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
 * (`tool_execution_update` → BashStreamGate, imported as-is from opencode).
 * M4a ADDS the hosted LLM tools (render_mermaid/create_mockup/show_mockup),
 * registered via `pi.registerTool()` in the SAME bridge extension, calling
 * back over a second PiBridgeHost route (`POST /hosted-tool`,
 * handleHostedTool) — auto-allowed by permission-engine.ts's
 * PI_AUTO_ALLOW_HOSTED_TOOLS. M4b ADDS pi as a cross-engine dispatch SOURCE
 * (`dispatch_agent`, the same mechanism, NORMAL mode-base gating) — see
 * PI_ENGINE_CAPABILITIES' doc comment for the full per-flag flip plan.
 */
export class PiSession extends BaseSession {
  readonly engineId = 'pi' as const

  private _capabilities: ResolvedCapabilities
  /**
   * ADR-030/ADR-033 M4-A: the STATIC PI_ENGINE_CAPABILITIES.crossEngineDispatch
   * flag is true (M4b shipped), but the HONEST per-session value additionally
   * requires crossEngineDispatchAvailable('pi') — currently always true for
   * the non-'claude' branch (pi-as-source only needs SOME target, and Claude
   * is always installed), but ANDed here so a future tightening of that
   * helper takes effect for pi automatically. ANDed at this GETTER (not
   * baked into every `_capabilities` assignment site — the constructor's
   * sync+async assignments, resolveCapsForModel, adoptEngineModel, setModel —
   * since unlike OpencodeSession's single resolveCapsForModel() choke point,
   * PiSession has several; one computed getter is the DRY single point of
   * truth, mirroring ClaudeSession's identical live-getter pattern instead of
   * opencode's "bake into every producer" pattern).
   */
  get capabilities(): ResolvedCapabilities {
    return {
      ...this._capabilities,
      crossEngineDispatch: this._capabilities.crossEngineDispatch && crossEngineDispatchAvailable('pi')
    }
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

  // ── Hosted tools (M4a) ───────────────────────────────────────────────────────
  /** Memoized once per session (constructing it is cheap, but there's no reason to redo it on every render_mermaid call — mockup is NOT memoized, see handleHostedTool's mockup case for why). */
  private mermaidServer: ReturnType<typeof createMermaidServer> | null = null
  /**
   * SECURITY (A1): one-shot `/hosted-tool` execution grants, `toolCallId ->
   * toolName`, minted by gateToolCall's wrapper (below) the instant `/tool-
   * call` decides 'allow' for a name in PI_HOSTED_TOOL_NAMES, and consumed
   * (deleted) by handleHostedTool on first use. Without this, the bearer
   * token alone gated `/hosted-tool` — and that token sits in the pi child's
   * env, reachable from any ALREADY-APPROVED bash command (`curl
   * $CLAUDEUI_PI_BRIDGE_URL/hosted-tool -d '{"toolName":"dispatch_agent",...}'`),
   * bypassing dispatch_agent's own deliberate 'ask' gating entirely. Cleared
   * wholesale by rejectAllPendingGates (interrupt/cancel/unexpected exit) —
   * a grant minted for a turn that no longer exists must not survive it.
   * Bounded to 256 entries (oldest evicted first, Map insertion order) so a
   * long-running session that never executes a granted call can't grow this
   * unboundedly.
   */
  private hostedGrants = new Map<string, string>()

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

  /** Public accessor for cross-engine dispatch (ADR-033) — used by
   *  handleDispatchAgent (M4b) to build DispatchContext.autonomyMode, mirroring
   *  OpencodeSession's identical accessor's call site (createOpencodeHostedToolsServer). */
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
    // Hosted tools + dispatch (M4a+b): ONE PiBridgeHost serves BOTH routes —
    // gateToolCall (/tool-call, M2a) and handleHostedTool (/hosted-tool,
    // M4a+b). The bridge extension registers the four hosted tools only when
    // CLAUDEUI_PI_HOSTED_TOOLS=1 (below); dispatch_agent additionally needs
    // CLAUDEUI_PI_DISPATCH_ENABLED=1. Both env vars are computed from the
    // RESOLVED capability (this.capabilities — the public getter, ANDed with
    // crossEngineDispatchAvailable('pi') for crossEngineDispatch) so the
    // extension never registers a tool ClaudeUI itself considers unavailable.
    // Belt-and-braces (A1 security fix): only wire the /hosted-tool handler
    // when the capability is actually on — even though handleHostedTool
    // itself now fails closed without a matching grant regardless (see
    // hostedGrants below), a session with hostedMcp off should never expose a
    // working /hosted-tool route at all, matching what the bridge extension
    // itself is told to register (CLAUDEUI_PI_HOSTED_TOOLS below).
    const bridgeHost = new PiBridgeHost(this.gateToolCall, this.capabilities.hostedMcp ? this.handleHostedTool : undefined)
    let bridge: { url: string; token: string }
    try {
      bridge = await bridgeHost.start()
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }

    // Everything from here through a successful client.start() can throw
    // (writeBridgeExtension does real fs I/O) with `bridgeHost` already
    // listening — dispose it on ANY failure in this block rather than leaking
    // the port/process.
    let client: PiRpcClient
    try {
      const bridgePath = writeBridgeExtension()

      const args = ['--mode', 'rpc', '-e', bridgePath]
      if (this.resumeSessionId) {
        // Resolve the on-disk file for the resume id; fall back to the raw id
        // (verified: --session accepts an absolute file path) if not found —
        // pi will then report whatever it can, rather than us refusing to spawn.
        const resolvedPath = findPiSessionFile(this.resumeSessionId)
        args.push('--session', resolvedPath ?? this.resumeSessionId)
      }

      client = new PiRpcClient(bin, {
        cwd: this.cwd,
        args,
        env: {
          CLAUDEUI_PI_BRIDGE_URL: bridge.url,
          CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
          ...(this.capabilities.hostedMcp ? { CLAUDEUI_PI_HOSTED_TOOLS: '1' } : {}),
          ...(this.capabilities.crossEngineDispatch ? { CLAUDEUI_PI_DISPATCH_ENABLED: '1' } : {}),
          ...this.computeSkillDirsEnv()
        }
      })
      await client.start()
    } catch (err) {
      bridgeHost.dispose()
      throw err instanceof Error ? err : new Error(String(err))
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
      // if the user later clicks it). Also drops any outstanding hosted-tool
      // grants — a /hosted-tool POST racing this exit has nothing left to
      // execute against anyway.
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

    // `this.client`/`this.bridgeHost` are now live — an uncaught rejection
    // from here on (e.g. get_state hanging/erroring) would otherwise leave a
    // running process + open port that the NEXT doStart() respawn overwrites
    // without ever disposing. client.dispose() below asynchronously fires the
    // onExit handler above once the OS reports the exit; that handler
    // null-checks everything it touches, so this synchronous cleanup and that
    // later async one are safe to both run (dispose() is documented idempotent).
    try {
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
    } catch (err) {
      this.client?.dispose()
      this.client = null
      if (this.bridgeHost) {
        this.bridgeHost.dispose()
        this.bridgeHost = null
      }
      throw err instanceof Error ? err : new Error(String(err))
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

        logger.debug('PiSession', `get_commands discovered ${persistent.length} command(s)`)

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
        // wasBusy (steer path): the ORIGINAL turn is still streaming — a
        // rejected steer must not flip isProcessing back to false out from
        // under it. Flipping it here would report idle mid-turn AND, worse,
        // let a subsequent run() send a bare `prompt` with no
        // `streamingBehavior`, which pi rejects outright while still
        // streaming (README.md "Commands"). Only a non-busy failure (this
        // WAS the turn) resets processing/the inactivity timer.
        if (!wasBusy) {
          this.isProcessing = false
          this.resetInactivityTimer()
        }
        this.send('session:error', resp.error ?? 'pi rejected the prompt')
        this.sendStatus()
        return
      }
      // Busy-path ack: lets the renderer's shared queued-message UI resolve
      // (onSteerConsumed → consumeQueuedText) exactly as Claude/opencode do.
      if (wasBusy) this.send('session:steer-consumed', { prompt })
    } catch (err) {
      // Same wasBusy carve-out as the !resp.success branch above.
      if (!wasBusy) {
        this.isProcessing = false
        this.resetInactivityTimer()
      }
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
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
          // Mirrors OpencodeSession.recordTurnUsage's identical pattern
          // (opencodeAuthProvider.buildAccountRef(...).accountId ?? null) —
          // PiAuthProvider shipped in M3, so this is no longer the M1 gap the
          // old comment here described.
          accountId: piAuthProvider.buildPiAccountRef(output.provider)?.accountId ?? null,
          accountUuid: null, // pi's auth.json has no OAuth account UUID field (same gap as opencode's)
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
    // Tear down any cross-engine dispatch targets owned by this session
    // (ADR-033 M4b — mirrors ClaudeSession.cancel()/OpencodeSession.cancel()'s
    // identical call; without this, a pi-sourced dispatch_agent's opencode/
    // Claude target would leak past this session's own lifetime).
    crossEngineDispatcher.disposeFor(this.routingId)
    // Drop all pending bash-output throttle timers — nothing left to flush to
    // once the session is torn down (mirrors OpencodeSession.cancel()'s
    // identical call).
    this.bashStreamGate.cancelAll()
    this.startedPromise = null
    this.sendStatus()
  }

  // ── Approval bridge (M2a) ────────────────────────────────────────────────────

  /**
   * The actual gating decision — runs the pure PiPermissionEngine against the
   * live autonomy mode + the user's merged Claude permission rules;
   * 'allow'/'deny' answer immediately, 'ask' surfaces a
   * `session:approval-request` and awaits the human via resolveApproval().
   * Wrapped by the public `gateToolCall` field below (SECURITY, A1) — this
   * inner fn only decides; it never mints a hosted-tool grant itself.
   */
  private gateToolCallInner = async (payload: PiToolCallPayload): Promise<GateDecision> => {
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

  /**
   * Handler passed to PiBridgeHost — invoked once per `tool_call` hook firing
   * in the pi child. Bound as a class field (not a prototype method) so
   * passing a bare reference to `new PiBridgeHost(this.gateToolCall)` keeps
   * `this` correct.
   *
   * SECURITY (A1): wraps gateToolCallInner's decision and, iff it allowed a
   * name in PI_HOSTED_TOOL_NAMES, mints a one-shot `/hosted-tool` execution
   * grant for this EXACT `toolCallId` + `toolName` — the ONLY seam that ever
   * populates hostedGrants, covering both the immediate-allow path and the
   * human-approved 'ask' path (resolveApproval's `pending.resolve()` below
   * resumes the awaited promise gateToolCallInner returned, which resolves
   * right back through here before the caller ever sees it). See
   * handleHostedTool for the consuming side.
   */
  private gateToolCall = async (payload: PiToolCallPayload): Promise<GateDecision> => {
    const decision = await this.gateToolCallInner(payload)
    if (decision.behavior === 'allow' && PI_HOSTED_TOOL_NAMES.has(payload.toolName)) {
      this.hostedGrants.set(payload.toolCallId, payload.toolName)
      // Bound the map — evict the OLDEST entry (Map iteration/insertion
      // order) rather than letting an abandoned session's never-executed
      // grants accumulate forever.
      if (this.hostedGrants.size > 256) {
        const oldestKey = this.hostedGrants.keys().next().value
        if (oldestKey !== undefined) this.hostedGrants.delete(oldestKey)
      }
    }
    return decision
  }

  /**
   * Resolve every in-flight 'ask' gate with a deny (used by interrupt/cancel/
   * an unexpected exit) and clear the map. Also clears hostedGrants — a grant
   * minted for a turn that's being torn down must not survive it (e.g. a
   * cancel racing an in-flight `/hosted-tool` POST).
   */
  private rejectAllPendingGates(reason: string): void {
    for (const pending of this.pendingGates.values()) {
      pending.resolve({ behavior: 'deny', reason })
    }
    this.pendingGates.clear()
    this.hostedGrants.clear()
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

  // ── Hosted tools + cross-engine dispatch (M4a+b) ─────────────────────────────

  /**
   * Handler passed to PiBridgeHost as the SECOND (hosted-tool) constructor
   * arg — invoked once per `POST /hosted-tool`.
   *
   * SECURITY (A1): the FIRST thing this does is require a matching one-shot
   * grant in `hostedGrants` — `toolCallId -> toolName` minted by gateToolCall
   * ONLY when `/tool-call` (permission-engine.ts's PI_AUTO_ALLOW_HOSTED_TOOLS
   * / mode-base ladder) already decided 'allow' for this exact call. Without
   * this check, the bearer token alone gated `/hosted-tool` — and that token
   * lives in the pi child's env, reachable from any already-approved bash
   * command, bypassing dispatch_agent's deliberate 'ask' gating entirely
   * (verified — pi's tool_call hook fires for registered tools too, but
   * nothing stops a direct POST that skips it). A present-but-mismatched
   * grant (e.g. granted for render_mermaid, executed as dispatch_agent with
   * the same toolCallId) fails closed identically to an absent one. The
   * grant is consumed (deleted) on the FIRST matching lookup — a second
   * execute() with the same toolCallId fails closed too, even though pi
   * itself would never legitimately send one.
   *
   * render_mermaid/create_mockup/show_mockup delegate to the SAME in-process
   * MCP tool handlers Claude/opencode use (mermaid-tool.ts/mockup-tool.ts —
   * extracting `.tools[].handler`, exactly like opencode-hosted-tools.ts's
   * reuse pattern) and pass their `{content, isError?}` result through
   * verbatim. Mockups land under `this.cwd`/.claude/ui/mockups — parity with
   * Claude/opencode (createMockupServer bakes `cwd` into its returned
   * server's mockupsRoot at construction time, so cwd MUST be `this.cwd`).
   */
  private handleHostedTool: PiHostedToolHandler = async (
    payload: PiHostedToolPayload
  ): Promise<PiHostedToolResult> => {
    const { toolName, input, toolCallId } = payload

    const grantedName = this.hostedGrants.get(toolCallId)
    if (grantedName === undefined || grantedName !== toolName) {
      return {
        content: [{ type: 'text', text: 'hosted tool call was not approved through the tool gate' }],
        isError: true
      }
    }
    this.hostedGrants.delete(toolCallId) // one-shot — consumed on first (matching) use.

    switch (toolName) {
      case 'render_mermaid': {
        if (!this.mermaidServer) this.mermaidServer = createMermaidServer()
        const tool = this.mermaidServer.tools.find((t) => t.name === 'render_mermaid')
        if (!tool) return unknownHostedTool(toolName)
        return (await tool.handler(input, undefined)) as unknown as PiHostedToolResult
      }

      case 'create_mockup':
      case 'show_mockup': {
        // NOT memoized (unlike the mermaid server above) — createMockupServer's
        // only per-instance state is the mockupsRoot path derived from
        // `this.cwd`, which never changes mid-session; re-deriving it per call
        // is cheap (a couple of `join()` calls) and avoids caching a stale
        // server if `this.cwd` were ever to matter differently across calls.
        const server = createMockupServer(this.cwd)
        const tool = server.tools.find((t) => t.name === toolName)
        if (!tool) return unknownHostedTool(toolName)
        return (await tool.handler(input, undefined)) as unknown as PiHostedToolResult
      }

      case 'dispatch_agent':
        return this.handleDispatchAgent(input, toolCallId)

      default:
        return unknownHostedTool(toolName)
    }
  }

  /**
   * dispatch_agent (M4b, ADR-033) — pi as a dispatch SOURCE (this method).
   * pi as a dispatch TARGET is handled separately, in
   * cross-engine-dispatcher.ts's `gatePiTargetToolCall` (M4c, shipped);
   * same-engine (pi→pi) dispatch still stays rejected regardless of which
   * side initiates — the dispatcher's own engine guard rejects 'pi' as
   * `req.engine` here. Mirrors collab-tool.ts's Claude-side
   * DispatchContext construction verbatim (fromEngine/fromRoutingId/cwd/
   * autonomyMode/emit/addDispatchedCost/toolUseId), NOT via MCP — pi has no
   * MCP client of its own, so this calls crossEngineDispatcher.dispatch()
   * directly. Result text formatting (the `[dispatch session_id: …]` success
   * suffix) is copied verbatim from collab-tool.ts too, so a pi-sourced
   * dispatch reads identically to a Claude-sourced one.
   *
   * `extra` (SdkToolExtra) is intentionally OMITTED — DispatchContext.extra is
   * optional, and pi's execute() DOES receive its own `signal`, but
   * PiBridgeHost's request/response contract has no channel to thread an
   * abort through mid-flight (the POST body is just
   * `{toolName, input, toolCallId}` — no signal). Every read site in
   * cross-engine-dispatcher.ts already treats a missing `extra` as "no abort
   * channel, no progress token" (`ctx.extra?.signal` → a permanently-pending
   * race arm that never wins; `sendProgress(ctx.extra, …)` → no-op), so this
   * is a safe, honest omission — not a fabricated never-aborting stub.
   * Stop-from-CALLER still works regardless: TaskCard's Stop button routes
   * through `crossEngineDispatcher.stopDispatch`, keyed by toolUseId +
   * routingId, entirely independent of this signal. Only pi's OWN Esc-to-abort
   * mid-turn does not propagate into an in-flight dispatch — documented v1
   * limitation, not a bug.
   */
  private async handleDispatchAgent(
    input: Record<string, unknown>,
    toolCallId: string
  ): Promise<PiHostedToolResult> {
    const engine = input.engine
    const prompt = input.prompt
    if ((engine !== 'claude' && engine !== 'opencode') || typeof prompt !== 'string') {
      return {
        content: [
          {
            type: 'text',
            text: 'dispatch_agent requires "engine" (one of "claude"|"opencode") and a string "prompt".'
          }
        ],
        isError: true
      }
    }

    const req: DispatchRequest = {
      engine,
      prompt,
      model: typeof input.model === 'string' ? input.model : undefined,
      sessionId: typeof input.session_id === 'string' ? input.session_id : undefined
    }
    const ctx: DispatchContext = {
      fromEngine: 'pi',
      fromRoutingId: this.routingId,
      cwd: this.cwd,
      autonomyMode: this.getAutonomyMode(),
      emit: (channel, data) => this.send(channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) => this.addDispatchedCost(engineId, modelId, costUsd),
      toolUseId: toolCallId
    }

    const result = await crossEngineDispatcher.dispatch(req, ctx)
    const text = result.isError
      ? result.text
      : `${result.text}\n\n[dispatch session_id: ${result.sessionId} — pass it as session_id to continue this agent]`
    return {
      content: [{ type: 'text', text }],
      ...(result.isError ? { isError: true } : {})
    }
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
