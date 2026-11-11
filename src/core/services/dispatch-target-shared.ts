/**
 * Functions shared by the dispatcher core and the per-engine dispatch target modules.
 */
import { type PermissionReply } from '../opencode/OpencodeClient'
import { restrictionNote, type CallerRestriction } from '../opencode/caller-restriction'
import type { DispatchTargetJudge } from './dispatch-target-judge'
import { blockGrantKey, type BlockedCall } from '../automode/blocked-calls'
import { ENGINE_META } from '../../shared/engine-meta'
import { logger } from './logger'
import type { DispatchRun } from './dispatch-runs'
import { recordSummary } from './dispatch-result-text'
import { type RunContext } from './dispatch-parent'
import type { DispatchConfig, TaskHandback, ToolReviewBlock } from '../../shared/types'
import { DISPATCH_PROMPT_PREAMBLE } from './dispatch-target-types'
import type {
  DispatchContext,
  FreshLaunch,
  DispatchResult,
  DispatchTargetClient,
  TurnTimeoutReason,
  TurnLivenessCaps
} from './dispatch-target-types'

/**
 * Where a target runs: a resumed one in the directory it was created in (ADR-105; a removed worktree
 * is refused by `launchRun` before it gets here), a new one in the `workdir` the launch resolved, else
 * in its parent's directory.
 */
export function targetCwd(
  ctx: { cwd: string },
  resume?: { cwd: string },
  fresh?: FreshLaunch
): string {
  return resume?.cwd ?? fresh?.workdir ?? ctx.cwd
}

/**
 * The dispatching session's LIVE permission mode as every target path reads it
 * (ADR-088), with the legacy `full` normalised to `auto`. Sessions speak `auto`
 * today, so this is defensive — `full` is not a cli.js permission mode, so no
 * target path may see it raw.
 */
export function liveMode(ctx: DispatchContext): string {
  const mode = ctx.getAutonomyMode()
  return mode === 'full' ? 'auto' : mode
}

/**
 * Resolve one dispatch turn's liveness caps from the TARGET engine's
 * `DispatchConfig` (ADR-033's 2026-09-18 amendment — Daniel's ruling).
 *
 * THERE IS NO BUILT-IN DEFAULT, in any direction. An unset field and an
 * explicit `0` both mean UNLIMITED: the only things that end a dispatched turn
 * early are the user stopping it, the caller aborting it, one of these
 * user-configured caps, or `dispatch.maxCostUsd`. The previous behaviour — a
 * fixed 10 minutes for claude/pi and 60/15-minute defaults for opencode —
 * silently killed legitimately long agent runs, which is the bug this closes.
 */
export function resolveTurnLiveness(cfg: DispatchConfig | undefined): TurnLivenessCaps {
  return {
    // A negative value is impossible from the Settings editor (it drops the key
    // rather than persisting one) but a hand-edited config could carry one;
    // clamped to 0 = unlimited so the watchdog's `> 0` gates read uniformly.
    turnTimeoutMs: Math.max(0, cfg?.turnTimeoutMs ?? 0),
    idleTimeoutMs: Math.max(0, cfg?.idleTimeoutMs ?? 0)
  }
}

/**
 * The give-up text for a fired cap: WHICH cap it was and the minutes the user
 * configured for it, plus the direction's own aftermath clause (whether the
 * target survives for a continuation turn). Every direction's timeout message
 * is built here so the two reasons are never conflated in one of them.
 */
export function turnTimeoutText(
  reason: TurnTimeoutReason,
  caps: TurnLivenessCaps,
  aftermath: string
): string {
  const minutes = Math.round(
    (reason === 'absolute' ? caps.turnTimeoutMs : caps.idleTimeoutMs) / 60000
  )
  const head =
    reason === 'absolute'
      ? `Dispatch timed out after ${minutes} minutes (absolute limit)`
      : `Dispatch timed out after ${minutes} minutes with no activity from the target agent`
  return `${head} — ${aftermath}`
}

/**
 * A pi/opencode target's judge block that stands — Keep blocked, its expiry,
 * or no hold at all (ADR-091 §3 / part 6): the block is annotated on the
 * target's outcomes (post-block consent inheritance), never as a human
 * refusal, and the judge's own deny text is what the target's model reads —
 * returned for the caller's reply.
 */
export function keepTargetBlock(
  judge: DispatchTargetJudge,
  toolUseId: string,
  reason: string
): string {
  judge.recordOutcome(toolUseId, 'automode-blocked')
  return reason
}

/**
 * Record a target's judge block at the DISPATCHING session (ADR-091 part 6),
 * so the user can approve it from there: the grant clears the target's next
 * identical call (keyed on the target's cwd), and the nudge goes to the target
 * itself while it can take one (`deliver`, a pi target in flight), else to the
 * dispatching agent, told the target's session id so it can dispatch the call
 * back. No review (the call had no tool block to bind one to) → nothing to
 * approve from.
 */
export function recordTargetBlock(
  ctx: DispatchContext,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  review: ToolReviewBlock | undefined,
  target: {
    engine: 'pi' | 'opencode'
    label: string
    cwd: string
    /** The X-Agent's ledger ref: what `session_message` addresses it by. */
    xAgentRef: string
    held: boolean
    deliver?: (call: BlockedCall) => string | null
  }
): void {
  if (!review || !ctx.blockedCalls) return
  ctx.blockedCalls.record(
    toolUseId,
    {
      toolName,
      input,
      review,
      grantKey: blockGrantKey(
        target.engine,
        toolName,
        input,
        target.cwd,
        target.engine === 'opencode'
      ),
      agentLabel: target.label,
      xAgentRef: target.xAgentRef,
      ...(target.deliver ? { deliver: target.deliver } : {})
    },
    target.held
  )
}

export function errorResult(text: string, sessionId = ''): DispatchResult {
  return { text, sessionId, isError: true }
}

/**
 * The judge's subagent description for a target: its model, plus what the
 * calling subagent may not do when a restricted child dispatched (ADR-097 S9).
 */
export function judgeDescription(
  model: string,
  restriction: CallerRestriction | undefined
): string {
  const note = restrictionNote(restriction)
  return note ? `${model} — ${note}` : model
}

/** Reply to a target's permission ask on the session that asked. Never throws. */
export function replyTargetPermission(
  client: DispatchTargetClient,
  sessionID: string,
  requestID: string,
  reply: PermissionReply
): void {
  try {
    void client.replyPermission(sessionID, requestID, reply).catch((err) => {
      logger.warn('CrossEngineDispatcher', `replyPermission failed: ${errText(err)}`)
    })
  } catch (err) {
    logger.warn('CrossEngineDispatcher', `replyPermission refused: ${errText(err)}`)
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── A dispatched turn's tokens, in the ledger's disjoint shape ──────────────
// (The pi target's fresh per-turn accumulator is `PiChildRunner.beginTurn`'s.)

// ── A dispatched turn as a ledger row (ADR-071 §1) ─────────────────────────

/**
 * The vendor/model split of a recorded row's `targetModel`, parsed the way the
 * TARGET engine encodes it (`engineMeta(...).decodeModelValue`): a bare model
 * id under a fixed vendor on Claude, `<vendor>/<model>` split on the
 * first slash on opencode and pi. An engine id this build does not know —
 * impossible from the call sites, which all pass a literal or an `EngineId` —
 * yields an `unknown` vendor rather than throwing inside a usage write.
 */
/**
 * The CANONICAL spelling of a target model value, for the one engine that
 * accepts more than one spelling of the same model.
 *
 * opencode and pi encode a model as `<vendor>/<model>` but decode a bare id by
 * supplying their default vendor, so `gpt-5-codex` and `opencode/gpt-5-codex`
 * name the same model while being different strings. That string is a KEY in
 * four places — the per-target cap, `ctx.addDispatchedCost`'s live breakdown
 * (`<engine>:<model>`), the notification text, and the ledger row, which
 * stores the decoded halves and whose reader re-encodes them. Canonicalising
 * once, here, is what makes the round trip exact: without it a session that
 * dispatched under a bare id shows the target twice after a reload, once per
 * spelling.
 *
 * It is wire-neutral. Every engine-facing call decodes the value again
 * (`parseModelString` for opencode, `decodeModelValue` before pi's
 * `set_model`), and decode is what both spellings already agreed on. Claude
 * encodes a bare id, so for it this is the identity.
 *
 * `ENGINE_META` rather than `engineMeta()`: an unregistered engine must read
 * back verbatim, not throw inside a dispatch.
 */
export function canonicalDispatchModel(engine: string, model: string): string {
  const meta = ENGINE_META[engine as keyof typeof ENGINE_META]
  if (!meta) return model
  return meta.encodeModelValue(meta.decodeModelValue(model))
}

/**
 * The line a turn's tool result carries when the cap is configured but this
 * turn's cost could not be resolved (ADR-030 / ADR-071 §2): the dispatching
 * model is told the limit is not counting, instead of being left to assume a
 * silent zero was a real one.
 */
export function cannotCountNote(model: string): string {
  return `\n\n[dispatch cost cap cannot count this turn: ${model} has no known price]`
}

/** `runIndex` on the card's records for run 2 and later; the first run carries none. */
export function runIndexField(run: DispatchRun): { runIndex?: number } {
  const index = run.init.runIndex
  return index !== undefined && index > 1 ? { runIndex: index } : {}
}

/**
 * Final completion signal for a dispatch (ADR-033 M3) — mirrors
 * ClaudeSession's `session:task-notification` shape exactly (TaskCard reads
 * both identically). `usage` (ADR-033 M4-B) is populated only on paths that
 * have real per-turn numbers (success outcomes) — timeouts/stops/errors pass
 * it undefined rather than fabricate zeros for a turn that never returned.
 *
 * `taskId` is the run's ledger id (ADR-105). `summary` is the run's text for a
 * background run, cut at the delivery cap (`recordSummary`): the card draws it, and
 * §3's delivery puts the same words (framed) into the parent. A blocking run keeps the
 * short summary: its tool_result already carries the text, and the record rides every
 * sync-full.
 */
export function emitDispatchNotification(
  ctx: RunContext,
  targetSessionId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
  usage?: { totalTokens: number; toolUses: number; durationMs: number },
  report?: { handback: TaskHandback; warning?: string }
): void {
  ctx.run.notified = true
  ctx.run.terminalStatus = status
  ctx.run.terminalSummary = summary
  if (!ctx.toolUseId) return
  ctx.emit('session:task-notification', {
    taskId: ctx.run.ledgerId ?? targetSessionId,
    toolUseId: ctx.toolUseId,
    ...runIndexField(ctx.run),
    status,
    outputFile: '',
    // A report is the card's body (the `HandbackReport` component): whole, for a blocking run too, up to the
    // delivery cap (the record rides every sync-full; the full report is in `dispatch_report`).
    summary: recordSummary(ctx.run.background || report ? summary : summary.slice(0, 100)),
    // The card cannot tell from the tool input: a root agent's call runs in the background
    // without saying so (ADR-105 §2), and its result is only the launch acknowledgement.
    ...(ctx.run.background ? { isBackgrounded: true } : {}),
    ...(report
      ? { handback: report.handback, ...(report.warning ? { warning: report.warning } : {}) }
      : {}),
    usage
  })
}

/** Wait for `promise` for at most `ms`; undefined when it did not settle in time. */
export async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Minimal pushable async iterable feeding Claude's streaming-input mode —
 * mirrors claude-session.ts's private `MessageChannel` (duplicated rather
 * than imported: importing from claude-session.ts here would form a
 * require-cycle, since claude-session.ts imports THIS module for
 * `crossEngineDispatcher`/`createCollabServer` wiring).
 */
export class ClaudeInputChannel implements AsyncIterable<Record<string, unknown>> {
  private queue: Record<string, unknown>[] = []
  private waiting: ((result: IteratorResult<Record<string, unknown>>) => void) | null = null
  private isDone = false

  push(msg: Record<string, unknown>): void {
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
      resolve({ value: undefined as unknown as Record<string, unknown>, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this as unknown as AsyncIterator<Record<string, unknown>>
  }

  async next(): Promise<IteratorResult<Record<string, unknown>>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false }
    }
    if (this.isDone) {
      return { value: undefined as unknown as Record<string, unknown>, done: true }
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

/** Build the `{type:'user', ...}` SDK message shape cli.js expects on the
 *  streaming-input channel — mirrors claude-session.ts's `run()`, with the
 *  {@link DISPATCH_PROMPT_PREAMBLE} in front of the prompt. */
export function buildClaudeDispatchMessage(
  prompt: string,
  sessionId: string | null,
  preamble = true,
  /** The client uuid cli.js reports the frame's fate under (`command_lifecycle`, 03 §3.21); without one it reports nothing. */
  uuid?: string
): Record<string, unknown> {
  return {
    type: 'user' as const,
    ...(uuid ? { uuid } : {}),
    session_id: sessionId ?? '',
    message: {
      role: 'user' as const,
      content: (preamble ? DISPATCH_PROMPT_PREAMBLE : '') + prompt
    },
    parent_tool_use_id: null
  }
}
