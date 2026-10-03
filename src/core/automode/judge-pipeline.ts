/**
 * The auto-mode judge pipeline — ONE implementation of the engine-neutral steps
 * between "the engine asked about a tool call" and "allow / deny / ask the
 * human" (ADR-088 §shared pipeline).
 *
 * PiSession, OpencodeSession and the cross-engine dispatcher's pi/opencode
 * targets all run ClaudeUI's own judge (ADR-023, ADR-081). Before this module
 * the two sessions each carried a step-for-step copy of the same body (fast
 * path → read-only gate → allow-rule gate → stale-judge check → ground truth →
 * classify → G10 → verdict logging → denial caps → review), and the dispatch
 * targets would have been a third. Everything engine-specific is injected as a
 * {@link JudgePipelineHooks} hook; this module imports nothing from an engine
 * directory (the rule `classifier.ts` follows).
 *
 * What stays in the CALLER, because its detection is engine-specific:
 * - G9 — a user-authored `ask` rule sends the call to the human with zero judge
 *   calls (pi: `verdict.source === 'ask-rule'`; opencode: the host pre-check's
 *   `user-ask`; the dispatch targets: their own checks). The caller runs it
 *   BEFORE calling {@link runJudgePipeline}.
 * - Engine-specific fast paths that precede the shared ones (opencode's
 *   agent-control edit clear, ADR-084 §3).
 * - Turning the outcome into the engine's reply, including holding a block on
 *   the engine's human path (`hold`, ADR-091 §3; the timer is
 *   `block-hold.ts`'s).
 *
 * Stage order: fast path → read-only gate (on `inputFor('read-only')` when
 * given, else `action.input`) + settled check → allow-rule gate (+ settled
 * check before its review) → `inputFor('judge')` → judge available → ground
 * truth + classify (on the judged input) → settled → G10 → verdict, caps,
 * review → on a throw: settled, else the human. `inputFor` exists for engines
 * whose ask can precede its tool input (opencode, ADR-084 §1 / ADR-085 §3);
 * its `'judge'` stage is NEVER awaited before the allow-rule skip, so an ask
 * an allow rule covers is answered without waiting for an input it does not
 * need.
 *
 * Log line texts are byte-identical to what the two sessions logged before the
 * extraction; `logSource` is the only variable.
 */
import type { ChatMessage, ClaudePermissions } from '../../shared/types'
import { logger } from '../services/logger'
import {
  classify,
  formatUnparseableJudgeReply,
  formatVerdictLine,
  isAutoModeFastPathAllowed,
  type ClassifierAction,
  type ClassifyResult,
  type EnvironmentInfo,
  type JudgeTransport
} from './classifier'
import { formatAutoModeDenyReason, type AutoModeDenialTracker } from './denial-tracker'
import { readOnlyGate } from './read-only-gate'
import { allowRuleGate } from './allow-rule-gate'
import type { AllowSkipAction } from './allow-rule-skip'
import type { ToolOutcome } from './ground-truth'

/** The one tool call being judged. */
export interface JudgePipelineAction {
  /** The engine's call id — the `tool_use` block the review binds to, and the outcome map's key. */
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

/** What a judged review looks like on the card (see the callers' `sendToolReview`). */
export type JudgePipelineReview = ClassifyResult | 'read-only' | { allowRule: string }

export interface JudgePipelineHooks {
  /** Logger source tag: `'PiSession'` | `'OpencodeSession'` | `'CrossEngineDispatcher'`. */
  logSource: string
  cwd: string
  /** The live permission mode, for the G10 log line. */
  currentMode: () => string
  /** Live `isAutoMode(currentMode())`. */
  autoModeActive: () => boolean
  /** The user's rules, for the two static gates (and nothing else). */
  permissions: () => Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
  /** Read-only gate: whether the engine's shell honours `input.workdir` (opencode true, pi false). */
  honoursWorkdir: boolean
  /**
   * Skip the ADR-084 read-only gate: the caller cannot vouch for the command's
   * working directory (e.g. a shell ask whose tool-part input — the only place
   * opencode's `workdir` lives — is not known). The judge decides instead.
   */
  skipReadOnlyGate?: boolean
  /** Omit to skip the allow-rule gate (the dispatch targets carry no allow rules). */
  allowRuleAction?: (
    toolName: string,
    input: Record<string, unknown>
  ) => AllowSkipAction | undefined
  /** How a rule's MCP tool name compares to the action's (opencode: its sanitiser). */
  mcpToolKey?: (ruleTool: string) => string
  /** Set when the call is delegated work (ADR-085 S4 task child / ADR-088 dispatch target). */
  subagent?: ClassifierAction['subagent']
  /** False → the human decides with no judge call (stale configured judge model, ADR-023 fail-closed). */
  judgeAvailable: () => Promise<boolean> | boolean
  judgeTransport: () => JudgeTransport
  /** The transcript the judge reads the user's intent from. */
  messages: () => ChatMessage[]
  environment: () => Promise<EnvironmentInfo>
  captureActionMeta: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>
  /** How prior calls ended, or `undefined` when none are recorded. */
  outcomes: () => Record<string, ToolOutcome> | undefined
  /**
   * The denial caps. The pipeline counts a block (`recordBlock`) and an
   * allow (`recordAllow`); a held block's caller calls `recordAllow()` when the
   * user approves it anyway (ADR-091 §3).
   */
  denials: AutoModeDenialTracker
  twoStageMode: () => 'both' | 'fast' | 'thinking'
  sendReview: (toolUseId: string, review: JudgePipelineReview) => void
  /**
   * Checked after every await (the read-only gate, the judge call, a thrown
   * error) and once more after an allow-rule allow, before its review. `false`
   * → `settled`: the ask was answered elsewhere meanwhile (opencode's cascade
   * or session-allow sweep; a drained dispatch) — the caller replies nothing.
   * The stage lets a caller keep its stage-specific log lines; an
   * implementation that takes no parameter stays assignable.
   */
  stillPending?: (stage: JudgePipelineStage) => boolean
  /**
   * For engines whose ask can precede its tool input (opencode, ADR-084 §1 /
   * ADR-085 §3): the input a stage should look at, resolved (and possibly
   * waited for) by the caller. `'read-only'` is awaited before the read-only
   * gate: an object → the gate runs on it; `null` → the gate (and its settled
   * check) is skipped. `'judge'` is awaited AFTER the allow-rule skip — never
   * before it, so a skippable ask is answered at once — and before
   * `judgeAvailable()`: an object → ground truth and the judge read it;
   * `null` → `action.input`. `'settled'` → the ask was answered meanwhile.
   * Omitted → every stage reads `action.input`.
   */
  inputFor?: (stage: 'read-only' | 'judge') => Promise<Record<string, unknown> | null | 'settled'>
}

/** Where {@link JudgePipelineHooks.stillPending} is being asked. */
export type JudgePipelineStage = 'read-only' | 'allow-rule' | 'judge' | 'error'

export type JudgePipelineOutcome =
  | { kind: 'allow' }
  /**
   * The judge blocked and no denial cap tripped (ADR-091 §3): the caller holds
   * the call on its human path as an auto-mode block — Keep blocked / Approve
   * anyway, resolved as Keep blocked after `AUTO_MODE_BLOCK_HOLD_MS`. `reason` =
   * `formatAutoModeDenyReason(result)`, the model-visible deny text a kept
   * block answers with. The review is already sent and the block counted
   * (`recordBlock`); the CALLER records `automode-blocked` when the hold
   * resolves as kept, and `recordAllow()` when it is approved.
   */
  | { kind: 'hold'; reason: string }
  /** `reason` = the denial cap's sentence → `PendingApproval.decisionReason`. */
  | { kind: 'human'; reason?: string }
  | { kind: 'settled' }

const ALLOW: JudgePipelineOutcome = { kind: 'allow' }
const HUMAN: JudgePipelineOutcome = { kind: 'human' }
const SETTLED: JudgePipelineOutcome = { kind: 'settled' }

/**
 * Judge one would-be-`ask` tool call. Every uncertain path (judge unavailable,
 * denial cap, mode changed, thrown error) funnels into `human`. Never throws.
 */
export async function runJudgePipeline(
  action: JudgePipelineAction,
  hooks: JudgePipelineHooks
): Promise<JudgePipelineOutcome> {
  const { toolUseId, toolName, input } = action
  const settled = (stage: JudgePipelineStage): boolean => hooks.stillPending?.(stage) === false

  // Fast path — read-only/safe categories never need the judge. An exact set
  // of built-in categories, so an MCP key never takes it.
  if (isAutoModeFastPathAllowed(toolName)) return ALLOW

  // ADR-084 §1 — a plainly read-only shell command in the workspace needs no
  // judge: allowed with a fixed review on the card, no recordAllow() (a static
  // allow never resets the denial caps) and no usage row. Before the
  // judge-model check, so it holds even when no judge model resolves.
  if (!hooks.skipReadOnlyGate) {
    const roInput = hooks.inputFor ? await hooks.inputFor('read-only') : input
    if (roInput === 'settled') return SETTLED
    if (roInput !== null) {
      const readOnly = await readOnlyGate({
        action: { toolName, input: roInput },
        cwd: hooks.cwd,
        permissions: hooks.permissions(),
        autoModeActive: hooks.autoModeActive,
        honoursWorkdir: hooks.honoursWorkdir,
        logSource: hooks.logSource
      })
      // The gate may have awaited a git capture; the ask may have been answered
      // meanwhile. Settled → handled: no reply, no review, no judge call.
      if (settled('read-only')) return SETTLED
      if (readOnly.allow) {
        hooks.sendReview(toolUseId, 'read-only')
        return ALLOW
      }
    }
  }

  // ADR-085 §4 — a narrow user allow rule skips the judge, also before the
  // judge-model check. Same bookkeeping as the read-only path: no
  // recordAllow(), no usage row, no outcome. Synchronous, so no mode can change
  // while it runs beyond its own `autoModeActive()`.
  const skip = hooks.allowRuleAction?.(toolName, input)
  if (skip) {
    const gate = allowRuleGate({
      action: skip,
      toolName,
      cwd: hooks.cwd,
      permissions: hooks.permissions(),
      autoModeActive: hooks.autoModeActive,
      logSource: hooks.logSource,
      ...(hooks.mcpToolKey ? { mcpToolKey: hooks.mcpToolKey } : {}),
      ...(hooks.subagent ? { subagent: hooks.subagent.type } : {})
    })
    if (gate.allow) {
      // The read-only stage may have awaited; an ask answered meanwhile gets
      // no reply and no review.
      if (settled('allow-rule')) return SETTLED
      hooks.sendReview(toolUseId, { allowRule: gate.rule })
      return ALLOW
    }
  }

  // The judge's input — only now, after the allow-rule skip (see `inputFor`).
  const judged = hooks.inputFor ? await hooks.inputFor('judge') : null
  if (judged === 'settled') return SETTLED
  const judgeInput = judged ?? input

  // A configured judge model that no longer exists fails CLOSED — never judged
  // by a stand-in. Checked after the static paths so a stale judge does not
  // start prompting for reads.
  if (!(await hooks.judgeAvailable())) return HUMAN

  try {
    // Ground truth. actionMeta FIRST: it is what resolves repo visibility, and
    // the environment picks the resolved value up on this same call rather
    // than one approval later.
    const actionMeta = await hooks.captureActionMeta(toolName, judgeInput)
    const environment = await hooks.environment()
    const outcomes = hooks.outcomes()
    const result = await classify(
      {
        messages: hooks.messages(),
        action: {
          toolName,
          input: judgeInput,
          ...(hooks.subagent ? { subagent: hooks.subagent } : {})
        },
        environment,
        ...(actionMeta ? { actionMeta } : {}),
        ...(outcomes ? { outcomes } : {}),
        twoStageMode: hooks.twoStageMode()
      },
      hooks.judgeTransport()
    )

    // The ask may have been settled while the judge ran. Replying now would
    // answer a call that already ran and paint a verdict on it. Checked before
    // G10, so a settled ask never gets a card either.
    if (settled('judge')) return SETTLED

    // G10 — the user can switch autonomy mode while the judge is in flight
    // (cli.js's `mode_changed_while_queued`). Re-read the CURRENT mode: if auto
    // mode is no longer active the verdict is stale authority — discard it.
    if (!hooks.autoModeActive()) {
      logger.info(
        hooks.logSource,
        `auto-mode verdict discarded — permission mode changed to "${hooks.currentMode()}" while the judge ran`
      )
      return HUMAN
    }

    const verdictLine = formatVerdictLine(result, toolName)
    if (result.stage === 'error') {
      // stage=error means no verdict was obtained — a WARN with the
      // transport's own message, because a bare `stage=error` line is
      // undiagnosable.
      logger.warn(hooks.logSource, verdictLine + (result.error ? ` — ${result.error}` : ''))
    } else {
      logger.info(hooks.logSource, verdictLine)
    }
    // Set only on a fail-closed unparseable verdict — the one block whose
    // reason says nothing about WHY the judge's answer was unreadable.
    if (result.raw !== undefined) {
      logger.debug(hooks.logSource, formatUnparseableJudgeReply(result))
    }

    if (result.unavailable) return HUMAN

    if (result.block) {
      // Denial caps (3 consecutive / 2 on the same rule / 20 total) — too many
      // blocks → the human decides, with the cap's own sentence as the card's
      // decisionReason.
      const capped = hooks.denials.recordBlock(result.category)
      if (capped) return { kind: 'human', reason: capped }
      // ADR-091 §3 — the block holds for the user rather than going straight
      // back to the engine. The review goes out now, so the verdict shows on
      // the card the hold raises. No `automode-blocked` yet: the caller
      // annotates the call (post-block consent inheritance) only once the
      // hold resolves as kept — an approved call ran, and was never refused.
      hooks.sendReview(toolUseId, result)
      return { kind: 'hold', reason: formatAutoModeDenyReason(result) }
    }

    hooks.denials.recordAllow()
    hooks.sendReview(toolUseId, result)
    return ALLOW
  } catch (err) {
    logger.warn(
      hooks.logSource,
      `auto-mode classify failed: ${err instanceof Error ? err.message : String(err)}`
    )
    // A throw after the ask was answered elsewhere (a stop, opencode's
    // cascade) must not forward a card for an already-answered ask.
    if (settled('error')) return SETTLED
    return HUMAN
  }
}
