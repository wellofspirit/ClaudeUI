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
  AutoModeConfig,
  AskUserQuestion,
  StatusLineData
} from '../../shared/types'
import { opencodeModel } from '../../shared/types'
import { getOpencodeModelContextWindow } from './model-discovery'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from '../services/logger'
import { mapEvent, extractToolResult, convertStoredMessage } from './event-mapper'
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
import { blockUsageService } from '../services/block-usage'

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
  /** Latest assistant prompt size (input + cacheRead) for context-used % in the status line. */
  private lastContextLength = 0
  private _model: string
  private permissionMode: string
  private reasoningVariant: string | null = null
  private agent: string | null = null
  private pendingApprovals = new Map<string, unknown>()
  // Pending model-elicitation questions (question.asked) keyed by requestId.
  // Stored so resolveApproval can map the ordered answers Record→string[][].
  private pendingQuestions = new Map<string, AskUserQuestion[]>()
  // Per-message part accumulator keyed by messageId
  private accumulators = new Map<string, MessageAccumulator>()
  // Track last emitted tool completion per partId to avoid double-emitting
  private emittedToolResults = new Set<string>()
  // Metering: message ids already recorded to usage_event (the accumulators map
  // persists across turns, so without this every session.idle re-iterates all
  // prior messages; the DB UNIQUE(message_id) already dedups, this just avoids
  // the repeated round-trips on long sessions).
  private recordedUsageMessageIds = new Set<string>()
  // Phase 8d — child session routing for the `task` tool.
  // Maps childSessionId → parentToolUseId (the task part's callID).
  // Populated by the event-mapper when it sees a task tool part with
  // state.metadata.sessionId; entries are deleted after the child's
  // session.idle (task-notification dispatch). Cleared in cancel()/dispose().
  private childSessions = new Map<string, string>()
  // Auto-mode (full) LLM gatekeeper state (ADR-023).
  private _autoModeConfig: AutoModeConfig | undefined
  private autoDenials = { consecutive: 0, total: 0 }
  // Discovered command names (populated in run(null) eager connect). Used by
  // run(prompt) to route /command tokens to runCommand instead of promptAsync.
  private knownCommandNames = new Set<string>()
  // Set true by cancel()/dispose(), reset to false at the top of each run(), so
  // ensureConnected() can detect a cancel that landed mid-acquire (during THIS
  // run's connect window) and release the freshly-acquired ref.
  private _cancelled = false
  // Memoized in-flight connection acquire. Both run(null)'s eagerConnect and
  // run(prompt) await the SAME promise, so a prompt sent before the eager
  // acquire resolves does NOT trigger a second acquire (ref-count stays 1).
  private connectingPromise: Promise<void> | null = null

  // The opencode session id to resume (passed from sidebar when clicking a
  // persisted opencode session). When set, we skip createSession and replay
  // the stored message history before accepting new prompts.
  private resumeSessionId: string | undefined

  constructor(
    routingId: string,
    win: BrowserWindow,
    cwd: string,
    _effort?: string,
    resumeSessionId?: string,
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
    this.resumeSessionId = resumeSessionId || undefined
    this._capabilities = resolveOpencodeCapabilities()
    this.sendStatus()
    this.sendStatusLine()
    // Warm the auth provider cache asynchronously so account is populated on
    // the next status emit (e.g. when run() begins). A cross-vendor model switch
    // re-reads from the cached map, so this only needs to warm once per session.
    opencodeAuthProvider.warmCache().then(() => { this.sendStatus(); this.sendStatusLine() }).catch(() => {})
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
    // Reset the cancel flag so it only guards THIS run's connect window. cancel()
    // is also fired by the idle timeout; without this reset a session that
    // idle-timed-out would refuse to reconnect on a subsequent prompt.
    this._cancelled = false

    // ── Eager connect (parity with Claude's spawn-only path) ─────────────────
    // run(null) is called at session creation to warm the connection + discover
    // slash commands / skills before the first prompt arrives. We acquire the
    // server, fetch commands + skills (instance/cwd-scoped, no opencode session
    // needed), emit the two events, and keep the connection for reuse.
    // Any failure degrades silently — opencode is optional. Arm the inactivity
    // timer so an opened-but-never-prompted session still releases its server ref.
    if (prompt === null) {
      void this.eagerConnect()
      this.resetInactivityTimer()
      return
    }

    // ── Steer path: prompt arriving mid-turn coalesces into the running opencode
    // loop (Phase 8c — see docs/v2/phase-8c-opencode-queue-steer.md). We post immediately — opencode's
    // runLoop re-reads the message list each step and picks it up — then emit
    // session:steer-consumed so the renderer moves the queued card into chat.
    // We do NOT touch isProcessing / startTimeMs / createSession / ensureSSEConsumer /
    // applyPermissionMode — the ongoing turn already owns all of that.
    if (this.isProcessing && this.client && this.openSessionId) {
      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now()
      }
      this.messageHistory.push(userMsg)
      try {
        await this.sendPrompt(prompt, attachments)
      } catch (err) {
        logger.warn('OpencodeSession', `steer send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.send('session:steer-consumed', { prompt })
      return
    }

    this.isProcessing = true
    this.sendStatus()

    try {
      // 1. Connect (memoized — shares the in-flight acquire with eagerConnect so
      //    a prompt sent before the eager acquire resolves never double-acquires).
      await this.ensureConnected()
      // Cancelled mid-connect (e.g. idle timeout or user cancel) — bail cleanly
      // instead of dereferencing a null client/session below.
      if (!this.client || this._cancelled) {
        this.isProcessing = false
        this.sendStatus()
        this.resetInactivityTimer()
        return
      }

      // 2. Create or resume opencode session
      if (!this.openSessionId) {
        if (this.resumeSessionId) {
          // Resume: reuse the prior session id (skip createSession).
          // Verify the session exists first — if not, fall back to creating fresh.
          try {
            await this.client.getSession(this.resumeSessionId)
            this.openSessionId = this.resumeSessionId
            logger.info('OpencodeSession', `Resuming opencode session ${this.openSessionId}`)
          } catch {
            logger.warn(
              'OpencodeSession',
              `Resume session ${this.resumeSessionId} not found — creating fresh session`
            )
            this.resumeSessionId = undefined
          }
        }
        if (!this.openSessionId) {
          const s = await this.client.createSession({ title: '' })
          this.openSessionId = s.id
        }
        // Emit status with the session id so the renderer can rekey
        this.sendStatus()

        // 2a. On resume: replay stored history BEFORE accepting new prompts.
        // This paints the prior transcript in the chat view so the user sees context.
        if (this.resumeSessionId && this.openSessionId === this.resumeSessionId) {
          await this.replayStoredHistory(this.openSessionId)
        }
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

      // 6. Send prompt — route slash commands to runCommand when the name is known
      this.startTimeMs = Date.now()
      await this.sendPrompt(prompt, attachments)
    } catch (err) {
      logger.error('OpencodeSession', `run() error: ${err instanceof Error ? err.message : String(err)}`)
      this.isProcessing = false
      this.send('session:error', err instanceof Error ? err.message : String(err))
      this.sendStatus()
      this.resetInactivityTimer()
    }
  }

  /**
   * Load stored messages for a resumed session and replay them to the renderer
   * as `session:message` (and `session:tool-result`) events, in order, BEFORE the
   * first new prompt.  This populates the chat view with the prior transcript.
   *
   * Uses `convertStoredMessage` from the event-mapper for part→block mapping
   * (parity with live turns — no divergent renderer path).
   *
   * Best-effort: any failure is swallowed and logged; it NEVER blocks the new prompt.
   *
   * Spec: docs/v2/followup-opencode-session-persistence.md §3c
   */
  private async replayStoredHistory(sessionId: string): Promise<void> {
    if (!this.client) return
    try {
      const storedMessages = await this.client.listMessages(sessionId)
      logger.info('OpencodeSession', `Replaying ${storedMessages.length} stored messages for ${sessionId}`)
      for (const stored of storedMessages) {
        const msg = convertStoredMessage(stored)
        if (!msg) continue

        // Add to local history (for getMessages() and future turns)
        const idx = this.messageHistory.findIndex((m) => m.id === msg.id)
        if (idx >= 0) {
          this.messageHistory[idx] = msg
        } else {
          this.messageHistory.push(msg)
        }

        // Emit to renderer
        this.send('session:message', msg)

        // Emit tool_result events for completed tool parts so the renderer
        // can display tool output blocks. Mirrors dispatchMapperOutput 'message' case.
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
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `replayStoredHistory failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Acquire the opencode server connection + build the client, exactly once.
   * Memoized via `connectingPromise`: concurrent callers (run(null)'s eagerConnect
   * and a racing run(prompt)) await the SAME acquire, so the ref count is always 1.
   * Race safety: if cancel() lands while acquire() is awaiting, the freshly
   * acquired ref is released immediately and conn/client stay null.
   */
  private async ensureConnected(): Promise<void> {
    if (this.conn) return
    if (!this.connectingPromise) {
      this.connectingPromise = (async () => {
        const c = await opencodeServerManager.acquire(this.cwd)
        if (this._cancelled) {
          opencodeServerManager.release(this.cwd)
          return
        }
        this.conn = c
        this.client = new OpencodeClient(c.baseUrl, c.authHeader)
      })().finally(() => {
        this.connectingPromise = null
      })
    }
    await this.connectingPromise
  }

  /**
   * Eager connect: acquire the server (memoized) + discover commands/skills +
   * emit events. Called from run(null); fires and is caught internally (never
   * throws to caller). Degrades silently — opencode is optional.
   *
   * On resume (resumeSessionId set): also replays stored history so the chat
   * view is populated before the user sends a new prompt.
   */
  private async eagerConnect(): Promise<void> {
    try {
      await this.ensureConnected()
      // Cancelled mid-connect, or connect produced no client — bail (no discovery).
      if (!this.client || this._cancelled) return

      // Fetch commands + skills in parallel — both are cwd/instance-scoped,
      // no opencode session needed.
      const [commands, skills] = await Promise.all([
        this.client.listCommands().catch((err) => {
          logger.warn('OpencodeSession', `listCommands failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }),
        this.client.listSkills().catch((err) => {
          logger.warn('OpencodeSession', `listSkills failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        })
      ])

      // Store command names for slash routing in run(prompt)
      this.knownCommandNames = new Set(commands.map((c) => c.name))

      // Emit session:slash-commands — names prefixed with '/' to match Claude's
      // contract (claude-session.ts:883-887). Renderer slash menu is engine-neutral.
      const slashCommands = commands.map((c) => ({
        name: '/' + c.name,
        description: c.description
      }))
      this.send('session:slash-commands', slashCommands)

      // Emit session:skills — name list only (renderer's SkillsDialog calls the
      // IPC to get full details; this just tells it skills are available).
      const skillNames = skills.map((s) => s.name)
      this.send('session:skills', skillNames)

      // Resume path: verify + replay stored history so the chat view is populated
      // before the user sends a new prompt. This mirrors Claude's historical
      // session load (which reads JSONL from disk at sidebar click time).
      if (this.resumeSessionId && !this.openSessionId) {
        try {
          await this.client.getSession(this.resumeSessionId)
          this.openSessionId = this.resumeSessionId
          this.sendStatus()
          await this.replayStoredHistory(this.openSessionId)
        } catch {
          // Session not found on server — clear the resumeSessionId so run(prompt)
          // will create a fresh session instead of attempting to resume.
          logger.warn(
            'OpencodeSession',
            `eagerConnect: resume session ${this.resumeSessionId} not found — will create fresh`
          )
          this.resumeSessionId = undefined
        }
      }
    } catch (err) {
      // Any failure degrades silently — opencode is optional
      logger.warn(
        'OpencodeSession',
        `eagerConnect failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Route the prompt to runCommand (slash routing) or promptAsync.
   * If prompt starts with /known-command, invoke via the command API.
   * Unknown slash tokens fall through to promptAsync (model sees the literal text).
   * On BadRequest from runCommand, fall back to promptAsync so a name mismatch
   * never wedges the turn.
   */
  private async sendPrompt(
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void> {
    const parsed = parseModelString(this._model)

    // Build file parts once — they ride along with BOTH the runCommand and the
    // promptAsync path so attachments are never dropped on a slash command.
    const fileParts: Array<{ type: 'file'; mime: string; url: string }> = (attachments ?? []).map(
      (att) => ({ type: 'file', mime: att.mediaType, url: `data:${att.mediaType};base64,${att.base64Data}` })
    )

    // Slash command routing — only when we have a live connection + session
    const slashMatch = prompt.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (slashMatch && this.client && this.openSessionId) {
      const commandName = slashMatch[1]
      const commandArgs = (slashMatch[2] ?? '').trim()
      if (this.knownCommandNames.has(commandName)) {
        try {
          await this.client.runCommand(this.openSessionId, {
            command: commandName,
            arguments: commandArgs,
            // Carry any file attachments into the command turn.
            ...(fileParts.length > 0 ? { parts: fileParts } : {})
          })
          // Success — SSE consumer handles the streaming output + session.idle
          return
        } catch (err) {
          // BadRequest ("Available commands: …") or other error — fall back to
          // promptAsync so the turn isn't wedged by an edge-case name mismatch.
          logger.warn(
            'OpencodeSession',
            `runCommand(${commandName}) failed, falling back to promptAsync: ${err instanceof Error ? err.message : String(err)}`
          )
          // Fall through to promptAsync below
        }
      }
    }

    // Default path: send via promptAsync (model sees literal prompt text)
    const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> = [
      { type: 'text', text: prompt },
      ...fileParts
    ]
    await this.client!.promptAsync(this.openSessionId!, {
      model: { providerID: parsed.providerID, modelID: parsed.modelID },
      agent: this.agent ?? undefined,
      parts,
      ...(this.reasoningVariant != null ? { variant: this.reasoningVariant } : {})
    })
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

        const output = mapEvent(ev, this.openSessionId, this.accumulators, this.startTimeMs, totalCostRef, this.childSessions)
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

      case 'approval': {
        const approval = output.approval
        this.pendingApprovals.set(approval.requestId, true)

        if (approval.toolName === 'AskUserQuestion') {
          // Model-elicitation questions (question.asked) must ALWAYS go to the
          // human regardless of autonomy mode — the auto-mode classifier judges
          // tool PERMISSIONS, not user-facing structured questions. Store the
          // question list so resolveApproval can map answers in order.
          const input = approval.input as { questions?: AskUserQuestion[] }
          this.pendingQuestions.set(approval.requestId, input.questions ?? [])
          this.send('session:approval-request', approval)
        } else {
          // Permission approval: auto mode (full) → LLM gatekeeper; else → human.
          // See ADR-023.
          if (this.isAutoMode(this.permissionMode)) {
            void this.handleAutoModeApproval(approval)
          } else {
            this.send('session:approval-request', approval)
          }
        }
        break
      }

      case 'result':
        this.isProcessing = false
        // Metering (Phase 7 Pass 1) — record one usage_event per assistant
        // message in this turn. We record at session.idle (result) so we have
        // the final cumulative token + cost state for each message_id.
        this.recordTurnUsage()
        // Metering (Phase 7 Pass 2) — emit the engine-neutral MeteringSnapshot.
        this.sendMetering()
        // Status line — emit final values at turn end (parity with Claude's result emit).
        this.sendStatusLine()
        // Phase 9b — refresh the per-engine dashboard immediately when an opencode
        // turn ends. Without this, the opencode section only updates on the Claude
        // usage poll (which may not fire at all in opencode-only sessions).
        // recalculate() is self-guarded with a concurrency flag, so back-to-back
        // turns queue safely.
        blockUsageService.recalculate().catch(() => {})
        this.send('session:result', output.result)
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'cost_update':
        // totalCostUsd already updated via ref. Update lastContextLength from the
        // latest assistant message's cumulative token snapshot (input + cacheRead is
        // the running prompt size — the "context used" dimension). Then emit the
        // status line live so the renderer updates during the turn (parity with Claude).
        if (output.tokens) {
          this.lastContextLength = (output.tokens.input ?? 0) + (output.tokens.cache?.read ?? 0)
        }
        this.sendStatusLine()
        break

      case 'auth-required':
        this.isProcessing = false
        this.send('session:vendor-auth-required', { vendorId: output.vendorId, message: output.message })
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'error':
        this.isProcessing = false
        this.send('session:error', output.message)
        this.sendStatus()
        this.resetInactivityTimer()
        break

      case 'subagent-stream':
        this.send('session:subagent-stream', {
          toolUseId: output.toolUseId,
          type: output.streamType,
          text: output.delta
        })
        break

      case 'subagent-message': {
        const { toolUseId, message } = output
        this.send('session:subagent-message', { toolUseId, message })

        // Extract newly completed child tool parts → session:subagent-tool-result.
        // Mirrors the own 'message' case's extractToolResult + emittedToolResults dedup.
        const childAcc = this.accumulators.get(message.id)
        if (childAcc) {
          for (const [partId, snap] of childAcc.parts) {
            const cacheKey = `${message.id}:${partId}`
            if (!this.emittedToolResults.has(cacheKey)) {
              const toolRes = extractToolResult(partId, snap)
              if (toolRes) {
                this.emittedToolResults.add(cacheKey)
                this.send('session:subagent-tool-result', {
                  toolUseId,
                  toolResultToolUseId: toolRes.toolUseId,
                  result: toolRes.result,
                  isError: toolRes.isError
                })
              }
            }
          }
        }
        break
      }

      case 'task-notification':
        this.send('session:task-notification', output.notification)
        // Tidy: remove the completed/failed child mapping so its sessionId is no
        // longer tracked (also prevents a future session with the same id from
        // being misrouted if opencode reuses ids).
        if (output.notification.toolUseId) {
          this.childSessions.delete(output.notification.taskId)
        }
        break

      case 'todos':
        // Feed the floating Todo widget via the existing session:plan channel,
        // which is already wired through preload → useClaudeEvents.onPlanSteps → setTodos.
        this.send('session:plan', output.items)
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
    this._cancelled = true
    this.isProcessing = false
    this.lastContextLength = 0
    this.sseAbort?.abort()
    this.sseAbort = null
    this.childSessions.clear()
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
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    this.pendingApprovals.delete(requestId)
    if (!this.client) return

    // ── Model-elicitation question (question.asked) ──────────────────────────
    // These are entirely separate from permission approvals: we reply via
    // /question/{id}/reply (with answers) or /question/{id}/reject, NOT
    // /permission/{id}/reply. The stored pendingQuestions list provides the
    // ordered question objects so we can reconstruct the string[][] answers
    // that opencode expects.
    if (this.pendingQuestions.has(requestId)) {
      const questions = this.pendingQuestions.get(requestId)!
      this.pendingQuestions.delete(requestId)

      const allow = decision === 'allow' || decision === 'allowForSession'
      if (allow && answers) {
        // Map answers: Record<string,string> → string[][] in question ORDER.
        // Key: q.question || 'q' + index  (mirrors AskUserQuestionBlock View.tsx keyOf)
        // MultiSelect values: comma-space joined → split back to string[]
        // Single-select: wrap as [value]
        const mapped: string[][] = questions.map((q, i) => {
          const key = q.question || `q${i}`
          const raw = answers[key] ?? ''
          if (q.multiSelect) {
            // AskUserQuestionBlock joins selections with ', '
            return raw ? raw.split(', ') : []
          }
          return raw ? [raw] : []
        })
        this.client.replyQuestion(requestId, mapped).catch((err) => {
          logger.warn('OpencodeSession', `replyQuestion failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      } else {
        // deny or allow without answers → reject the question
        this.client.rejectQuestion(requestId).catch((err) => {
          logger.warn('OpencodeSession', `rejectQuestion failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return
    }

    // ── Permission approval (permission.asked) ───────────────────────────────
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
    // Reset the reasoning variant — the new model may have different variants.
    this.reasoningVariant = null
    this.sendStatus()
    this.sendStatusLine()
  }

  setReasoningVariant(variant: string | null): void {
    this.reasoningVariant = variant
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

  /**
   * Ask a one-off question outside the main conversation history (the `/btw`
   * command). Uses a fresh throwaway opencode session so the question never
   * pollutes the main session's history. Mirrors the `makeJudgeFn` pattern.
   * Returns the joined assistant text, or null on any failure. Never throws.
   *
   * `client.prompt` runs a SYNCHRONOUS server-side turn (POST /session/{id}/message
   * blocks until the turn fully completes). Claude's `/btw` is tool-less; ours
   * must match — and critically, must be HANG-PROOF: if the model called a tool
   * that needed approval, opencode would emit `permission.asked` for THIS
   * throwaway session, which our main SSE consumer filters out (foreign
   * sessionID) and never answers → the synchronous prompt would hang forever
   * (spinner stuck). So we patch a deny-all ruleset on the throwaway session
   * BEFORE prompting: opencode's permission evaluator short-circuits a matching
   * `deny` WITHOUT publishing `permission.asked` (verified vs 1.17.9 —
   * permission/index.ts `ask()` returns DeniedError before the Event.Asked path;
   * `{permission:'*', pattern:'*'}` matches every tool via Wildcard.match → regex
   * `.*`). The model therefore just answers in text — tool-less, hang-proof. The
   * system prompt is a belt-and-suspenders nudge. (We deliberately avoid the
   * prompt body's `tools` field, which opencode marks @deprecated.)
   */
  override async askSideQuestion(question: string): Promise<string | null> {
    try {
      await this.ensureConnected()
      if (!this.client || this._cancelled) return null

      const parsed = parseModelString(this._model)
      const js = await this.client.createSession({ title: 'side-question' })
      try {
        // Deny every tool so a synchronous prompt can never block on an
        // unanswerable permission.asked (see method doc). Best-effort; the
        // system prompt still discourages tools if the patch were to fail.
        await this.client.patchSession(js.id, {
          permission: [{ permission: '*', pattern: '*', action: 'deny' }]
        })
        const resp = (await this.client.prompt(js.id, {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          system: 'Answer the following question concisely and directly. Do not use tools.',
          parts: [{ type: 'text', text: question }]
        })) as { parts?: Array<{ type?: string; text?: string }> }
        const text = (resp?.parts ?? [])
          .filter((p) => p?.type === 'text')
          .map((p) => p?.text ?? '')
          .join('')
        return text || null
      } finally {
        this.client.deleteSession(js.id).catch(() => {})
      }
    } catch (err) {
      logger.warn(
        'OpencodeSession',
        `askSideQuestion failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  sendStatus(): void {
    this.send('session:status', this.status)
  }

  /**
   * Record one usage_event per accumulated assistant message at turn end.
   * Called at session.idle so we have final cumulative token + cost state.
   * Failures are swallowed by recordUsageEvent — never breaks a turn.
   *
   * Phase 9a: child accumulators (isChild) are now also metered, but under the
   * CHILD's own model + childSessionId — not the parent's. If a child accumulator
   * has no model info, it is skipped (never attributed to the parent model).
   */
  private recordTurnUsage(): void {
    const parsed = parseModelString(this._model)
    const ownAccount = opencodeAuthProvider.buildAccountRef(parsed.providerID)

    for (const [messageId, acc] of this.accumulators) {
      // Only record assistant messages that have cost or token data
      if (acc.role === 'user' || acc.role === 'system') continue
      if (!acc.cost && !acc.tokens) continue
      // Skip messages already recorded in a prior session.idle this session
      // (the DB dedups anyway; this avoids the redundant round-trip).
      if (this.recordedUsageMessageIds.has(messageId)) continue
      this.recordedUsageMessageIds.add(messageId)

      const tokens = acc.tokens

      if (!acc.isChild) {
        // Own (parent) message — attribute to this session's model.
        recordUsageEvent({
          engineId: 'opencode',
          vendorId: parsed.providerID,
          accountId: ownAccount?.accountId ?? null,
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
      } else {
        // Child (subagent) message — attribute to the CHILD's own model + session.
        // If model info is absent, skip: never record a child under the parent model.
        if (!acc.model) {
          logger.debug('OpencodeSession', `Child accumulator ${messageId} has no model info — skipping metering`)
          continue
        }
        const childAccount = opencodeAuthProvider.buildAccountRef(acc.model.providerID)
        recordUsageEvent({
          engineId: 'opencode',
          vendorId: acc.model.providerID,
          accountId: childAccount?.accountId ?? null,
          accountUuid: null,
          modelId: acc.model.modelID,
          tokens: {
            input: tokens?.input ?? 0,
            output: tokens?.output ?? 0,
            cacheWrite: tokens?.cache?.write ?? 0,
            cacheWrite1h: 0,
            cacheRead: tokens?.cache?.read ?? 0
          },
          engineCostUsd: acc.cost ?? null,
          sessionId: acc.childSessionId ?? null,
          messageId,
          source: 'live'
        })
      }
    }
  }

  /**
   * Sum the cumulative tokens from all own (non-child) assistant accumulators.
   * Returns { input, output, cacheWrite, cacheRead }.
   * Extracted from sendMetering for reuse in buildStatusLine (DRY).
   */
  private sumSessionTokens(): { input: number; output: number; cacheWrite: number; cacheRead: number } {
    let input = 0
    let output = 0
    let cacheWrite = 0
    let cacheRead = 0
    for (const acc of this.accumulators.values()) {
      if (acc.role === 'user' || acc.role === 'system') continue
      if (acc.isChild) continue
      const t = acc.tokens
      if (!t) continue
      input += t.input ?? 0
      output += t.output ?? 0
      cacheWrite += t.cache?.write ?? 0
      cacheRead += t.cache?.read ?? 0
    }
    return { input, output, cacheWrite, cacheRead }
  }

  /**
   * Build a StatusLineData snapshot for the current session state.
   * Context "used" = lastContextLength (latest turn's input+cacheRead, NOT
   * the cumulative In/Out/Total sum). Context window size from the discovery
   * cache. usedPercentage is null when the window size is unknown (acceptable —
   * status line shows tokens, omits the %).
   */
  private buildStatusLine(): StatusLineData {
    const parsed = parseModelString(this._model)
    const sum = this.sumSessionTokens()
    const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
    const usedPercentage =
      ctx > 0 && this.lastContextLength > 0
        ? Math.round((this.lastContextLength / ctx) * 100)
        : null
    const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
    const cachedTokens = sum.cacheRead + sum.cacheWrite
    const totalTokens = sum.input + sum.output + cachedTokens
    const totalDurationMs = this.startTimeMs > 0 ? Date.now() - this.startTimeMs : 0
    return {
      totalCostUsd: this.totalCostUsd,
      totalDurationMs,
      totalApiDurationMs: 0,
      totalInputTokens: sum.input,
      totalOutputTokens: sum.output,
      cachedTokens,
      totalTokens,
      contextWindowSize: ctx,
      usedPercentage,
      remainingPercentage
    }
  }

  /** Emit the status line to the renderer (parity with Claude's session:status-line). */
  private sendStatusLine(): void {
    this.send('session:status-line', this.buildStatusLine())
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
      const { input, output, cacheWrite, cacheRead } = this.sumSessionTokens()
      const equiv = equivalentCostUsd(parsed.providerID, parsed.modelID, {
        inputTokens: input,
        outputTokens: output,
        cacheWriteTokens: cacheWrite,
        cacheWrite1hTokens: 0,
        cacheReadTokens: cacheRead
      })
      const ctx = getOpencodeModelContextWindow(parsed.providerID, parsed.modelID)
      const snapshot: MeteringSnapshot = {
        engineId: 'opencode',
        vendorId: parsed.providerID,
        billingType: account?.billingType ?? 'unknown',
        tokens: { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead },
        equivalentCostUsd: equiv,
        engineReportedCostUsd: this.totalCostUsd,
        contextWindow: { used: this.lastContextLength, size: ctx }
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
