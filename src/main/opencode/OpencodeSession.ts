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
  PendingApproval,
  AccountRef,
  MeteringSnapshot,
  AutoModeConfig
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from '../services/logger'
import { mapEvent, extractToolResult } from './event-mapper'
import type { MapperOutput, MessageAccumulator } from './event-mapper'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { recordUsageEvent } from '../services/usage-recorder'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import {
  compileClaudeRulesToOpencode,
  suggestionDestinationToScope,
  suggestionRuleToClaudeString
} from './permission-compiler'
import { classify, isAutoModeFastPathAllowed, type JudgeFn } from './auto-mode-classifier'
import { loadEngineConfig } from '../services/ui-config'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'

// Permission ruleset helper
type PermissionAction = 'allow' | 'ask' | 'deny'

interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

/**
 * Map a neutral autonomy mode → an opencode session permission ruleset.
 *
 * opencode permissions are an ORDERED rule array evaluated LAST-MATCH-WINS
 * (verified against 1.17.9), where `permission` is a tool/category name
 * (`*`, `edit`, `bash`, `webfetch`, `task`, `read`, `glob`, `grep`, …) and
 * `pattern` matches the tool argument. Read-class tools (`read`/`glob`/`grep`/
 * `list`) and `task` are allow-by-default — they only prompt if we make them.
 *
 * We therefore start from a permissive `{*:allow}` baseline (mirroring how
 * opencode's own built-in agents are structured) and LAYER mode-specific
 * `ask`/`deny` overrides for the write-class tools on top. This preserves
 * Claude-equivalent semantics — reads + `task` auto-allowed; edits/bash/webfetch
 * gated — instead of the old wildcard `{*:* ask|allow}` that forced EVERY tool
 * (including `task`, which hung the turn) to prompt and clobbered opencode's
 * own protections. See ADR-022.
 *
 * `mode` is the Claude-style permission-mode string the renderer already speaks
 * (autonomy plan→'plan', ask→'default', autoEdit→'acceptEdits', full→'auto').
 */
function buildRuleset(mode: string): PermissionRule[] {
  const allowAll: PermissionRule = { permission: '*', pattern: '*', action: 'allow' }
  const rule = (permission: string, action: PermissionAction): PermissionRule => ({
    permission,
    pattern: '*',
    action
  })
  // Portable subset of opencode's own built-in guards (its agents keep these even
  // in permissive mode): a doom-loop ask + secret-file read protection. Layered
  // after the `{*:allow}` baseline (last-match-wins). We omit opencode's
  // `external_directory` guard — its safe form needs an env-specific allow-list
  // for opencode's own tool-output/temp dirs, so a bare `{external_directory:ask}`
  // would spuriously prompt on opencode's internal writes. See ADR-022.
  const guards: PermissionRule[] = [
    { permission: 'doom_loop', pattern: '*', action: 'ask' },
    { permission: 'read', pattern: '*.env', action: 'ask' },
    { permission: 'read', pattern: '*.env.*', action: 'ask' },
    { permission: 'read', pattern: '*.env.example', action: 'allow' }
  ]
  switch (mode) {
    case 'acceptEdits':
    case 'autoEdit':
      // Auto-accept file edits; still gate command execution + network fetch.
      return [allowAll, ...guards, rule('bash', 'ask'), rule('webfetch', 'ask')]
    case 'plan':
      // Read-only planning. Pairs with opencode's `plan` agent (set in
      // applyPermissionMode). Mirrors that agent's own rules (verified in the
      // opencode source — plan = merge(base, { edit:{'*':deny, …plan files…},
      // task:{general:deny} })): deny edits, and deny ONLY the mutating
      // `general` subagent. Read-only subagents (e.g. `explore`) stay allowed
      // via the baseline, so plan-mode research/`task` still works. `deny`
      // refuses without prompting → no approval round-trip, no hang.
      // (We don't reproduce opencode's plan-file edit allow-list — minor.)
      return [allowAll, ...guards, rule('edit', 'deny'), { permission: 'task', pattern: 'general', action: 'deny' }]
    case 'auto':
    case 'full':
    case 'default':
    case 'ask':
    default:
      // Claude default — read-only autonomy + ask for write-class tools.
      //
      // `full`/`auto` are INTENTIONALLY gated identically to `default` for now.
      // ClaudeUI's `full` autonomy maps to Claude's `auto` permission mode — an
      // LLM-gated "security monitor", NOT `bypassPermissions`. We haven't ported
      // that gatekeeper to opencode yet, so a raw `{*:allow}` here would make
      // opencode `full` strictly LESS safe than Claude `full`. Interim: gate
      // `full` like `default` (never less safe than Claude) until the classifier
      // lands, at which point `full` switches risky tools to classifier-decided.
      // See ADR-022.
      return [allowAll, ...guards, rule('edit', 'ask'), rule('bash', 'ask'), rule('webfetch', 'ask')]
  }
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
  // Auto-mode (full) LLM gatekeeper state (ADR-023).
  private _autoModeConfig: AutoModeConfig | undefined
  private autoDenials = { consecutive: 0, total: 0 }

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
        // Auto mode (full): route to the LLM gatekeeper instead of the human;
        // fall back to a human prompt on uncertain/unavailable/cap. Otherwise
        // emit the approval to the UI as normal. See ADR-023.
        if (this.isAutoMode(this.permissionMode)) {
          void this.handleAutoModeApproval(output.approval)
        } else {
          this.send('session:approval-request', output.approval)
        }
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
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    this.pendingApprovals.delete(requestId)
    if (!this.client) return

    const allow = decision === 'allow' || decision === 'allowForSession'
    // "always allow" = the user checked persist-rule suggestions in the dialog.
    const persist = allow && !!updatedPermissions && updatedPermissions.length > 0
    // 'always' tells opencode to remember the allow for this session; we send it
    // for an explicit allowForSession OR when the user checked "always allow".
    const reply = !allow ? 'reject' : persist || decision === 'allowForSession' ? 'always' : 'once'

    this.client.replyPermission(requestId, reply).catch((err) => {
      logger.warn('OpencodeSession', `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    // Persist the rule to the shared store so it recompiles onto opencode next
    // spawn + shows in PermissionsDialog (session + shared store — ADR-022).
    if (persist) this.persistAllowRules(updatedPermissions!)
  }

  /** Write "always allow" suggestions to the shared Claude permission store. */
  private persistAllowRules(suggestions: PermissionSuggestion[]): void {
    try {
      const byScope = new Map<'user' | 'project' | 'local', string[]>()
      for (const s of suggestions) {
        if (s.type !== 'addRules' || s.behavior !== 'allow' || !s.rules) continue
        const scope = suggestionDestinationToScope(s.destination)
        if (!scope) continue // 'session' → opencode's 'always' reply already covers it
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
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `persisting allow rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
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
    // Plan mode additionally switches to opencode's read-only `plan` agent
    // (its planning system prompt + plan_exit flow); all other modes use the
    // default `build` agent. We ALWAYS patch a ruleset (including plan) so the
    // session's effective permissions are deterministic and never inherit a
    // stale override from a previous mode. See buildRuleset / ADR-022.
    this.agent = mode === 'plan' ? 'plan' : null
    // In auto mode (full + classifier enabled) we use the acceptEdits base so the
    // ruleset auto-allows reads + edits and only bash/webfetch raise
    // `permission.asked` → the classifier judges just those (the acceptEdits-
    // equivalence fast-path, parity with cli.js). Classifier-disabled `full`
    // falls through to buildRuleset('full') = the gated `default` (ADR-023).
    const baseMode = this.isAutoMode(mode) ? 'acceptEdits' : mode
    // Compose: autonomy-mode base ruleset + the user's neutral permission rules
    // (Claude's allow/ask/deny + additionalDirectories) compiled to opencode and
    // appended AFTER the base so they override it (last-match-wins). This makes
    // the SAME configured rules apply to opencode as to Claude. See ADR-022.
    const ruleset = [...buildRuleset(baseMode), ...this.compiledUserRules()]
    try {
      await this.client.patchSession(this.openSessionId, { permission: ruleset })
    } catch (err) {
      logger.warn('OpencodeSession', `patchSession failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Merge the user/project/local permission scopes and compile them to opencode
   *  rules (allow→ask→deny). Best-effort: a load/parse failure yields no rules
   *  rather than breaking the turn. */
  private compiledUserRules(): ReturnType<typeof compileClaudeRulesToOpencode> {
    try {
      const scopes: PermissionScope[] = ['user', 'project', 'local']
      const merged: ClaudePermissions = {
        allow: [],
        deny: [],
        ask: [],
        additionalDirectories: [],
        defaultMode: undefined
      }
      for (const scope of scopes) {
        const p = loadClaudePermissions(scope, this.cwd)
        merged.allow.push(...p.allow)
        merged.ask.push(...p.ask)
        merged.deny.push(...p.deny)
        merged.additionalDirectories.push(...p.additionalDirectories)
      }
      return compileClaudeRulesToOpencode(merged)
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `compiling user permission rules failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  // ── Auto mode (full) LLM permission gatekeeper (ADR-023) ──────────────────

  private autoModeConfig(): AutoModeConfig {
    if (this._autoModeConfig === undefined) {
      try {
        this._autoModeConfig = loadEngineConfig('opencode').autoMode ?? {}
      } catch {
        this._autoModeConfig = {}
      }
    }
    return this._autoModeConfig
  }

  /** Auto mode is active for `full`/`auto` autonomy unless explicitly disabled. */
  private isAutoMode(mode: string): boolean {
    return (mode === 'full' || mode === 'auto') && this.autoModeConfig().enabled !== false
  }

  /** A JudgeFn backed by a fresh, stateless opencode judge session per call
   *  (so the judge never accumulates prior Q&As; we trade cache for correctness).
   *  Judge model defaults to the session's own model (ADR-023), override via config. */
  private makeJudgeFn(): JudgeFn | null {
    const client = this.client
    if (!client) return null
    const parsed = parseModelString(this.autoModeConfig().judgeModel ?? this._model)
    return async (system, user) => {
      const js = await client.createSession({ title: 'auto-mode-judge' })
      try {
        const resp = (await client.prompt(js.id, {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          system,
          parts: [{ type: 'text', text: user }]
        })) as { parts?: Array<{ type?: string; text?: string }> }
        return (resp?.parts ?? [])
          .filter((p) => p?.type === 'text')
          .map((p) => p?.text ?? '')
          .join('')
      } finally {
        client.deleteSession(js.id).catch(() => {})
      }
    }
  }

  private async handleAutoModeApproval(approval: PendingApproval): Promise<void> {
    const category = approval.toolName
    // Fast-path: read-only/safe tools never need the judge.
    if (isAutoModeFastPathAllowed(category)) {
      this.autoReply(approval.requestId, 'once')
      return
    }
    const judge = this.makeJudgeFn()
    if (!judge) {
      this.fallbackToHuman(approval)
      return
    }
    try {
      const result = await classify(
        {
          messages: this.messageHistory,
          action: { toolName: category, input: approval.input },
          environment: `cwd: ${this.cwd}`,
          twoStageMode: this.autoModeConfig().twoStageMode ?? 'both'
        },
        judge
      )
      logger.info(
        'OpencodeSession',
        `auto-mode ${result.block ? 'BLOCK' : 'allow'} (stage=${result.stage}) ${category}` +
          (result.reason ? ` — ${result.reason}` : '')
      )
      if (result.unavailable) {
        this.fallbackToHuman(approval)
        return
      }
      if (result.block) {
        this.autoDenials.consecutive++
        this.autoDenials.total++
        // Denial caps (parity 3/20): too many blocks → hand control to the human.
        if (this.autoDenials.consecutive >= 3 || this.autoDenials.total >= 20) {
          this.autoDenials.consecutive = 0
          this.fallbackToHuman(approval)
          return
        }
        this.autoReply(approval.requestId, 'reject')
      } else {
        this.autoDenials.consecutive = 0
        this.autoReply(approval.requestId, 'once')
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `auto-mode classify failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.fallbackToHuman(approval)
    }
  }

  /** Resolve a pending approval programmatically (the classifier's decision). */
  private autoReply(requestId: string, reply: 'once' | 'reject'): void {
    this.pendingApprovals.delete(requestId)
    this.client?.replyPermission(requestId, reply).catch((err) => {
      logger.warn('OpencodeSession', `replyPermission failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Classifier couldn't decide (unavailable / cap / error) → ask the human. */
  private fallbackToHuman(approval: PendingApproval): void {
    this.send('session:approval-request', approval)
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
