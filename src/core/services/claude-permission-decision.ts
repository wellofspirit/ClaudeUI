/**
 * cli.js's pre-ask permission frames → the blocks the cards render.
 *
 * Claude's Auto mode is cli.js-native: the two-stage classifier documented in
 * `docs/protocol-cc/14-auto-mode-classifier.md` runs INSIDE the CLI, so unlike
 * opencode and pi we do not call the judge — we read its verdict off the wire. One
 * frame carries it (`docs/protocol-cc/04-system-subtypes.md` §4.25):
 * `system/permission_denied`, emitted for EVERY pre-ask denial, not just the
 * classifier's. `decision_reason_type` says which: `classifier` is a judge's
 * verdict, everything else is a rule / mode / hook / safety-check refusal.
 * cli.js emits nothing when the classifier ALLOWS a call (the emit site is
 * gated on `behavior === "deny"`), so a Claude card shows the judge's verdict
 * on a block only.
 *
 * The split into two block types is the point of this module. A classifier
 * verdict could have gone the other way and names the rule it weighed, so it is
 * a `ToolReviewBlock` — the same block pi and opencode produce, rendering
 * identically. A deny rule could not have gone the other way and weighed
 * nothing, so it is a `PermissionDenialBlock`; calling it a "review" would put a
 * judgment where there was only a policy lookup.
 *
 * A `classifier` frame is not always a verdict, though. cli.js also tags its
 * no-verdict fallbacks `classifier` — the transcript overflowed the judge's
 * context, a safeguard refused the classifier request, the classifier was
 * unreachable — and blocks the call anyway. Its `noVerdict` flag stays inside
 * cli.js, but three of those fallbacks are recognisable on the wire (see
 * {@link isNoVerdictDenial}); they become a `PermissionDenialBlock` with the
 * synthetic source `autoModeNoVerdict`: the action was refused, but nobody
 * weighed it, so a "review" would claim a judgment that never happened. The
 * rest (a safeguard refusal, an empty classifier-only action) carry free-form
 * reasons and arrive as a denied review with cli.js's own text.
 *
 * Everything here is PURE — frame in, block out — so the wire contract is
 * testable without a session. {@link permissionDecisionBlock} owns ALL the
 * routing; `claude-session.ts` only narrows, logs and sends.
 */
import type {
  PermissionDenialBlock,
  PermissionDenialSource,
  ToolReviewBlock
} from '../../shared/types'
import { reviewRationale } from '../shared/tool-review'

/** The frame fields we read, already narrowed out of the loose `SystemMessage`. */
export interface PermissionDecisionFrame {
  /** cli.js's `tool_use_id` — what binds the block to its card. */
  toolUseId: string
  /** The frame's own `uuid`, used as a block identity so replays are no-ops. */
  frameUuid: string
  /** Present when the call was made INSIDE a subagent (§4.25). */
  agentId?: string
  /** `decision_reason_type` verbatim; absent on frames whose source has none. */
  decisionReasonType?: string
  /** `decision_reason` verbatim — UNTRUSTED, not yet collapsed or capped. */
  decisionReason?: string
  /** `decision_reason_code` — cli.js's machine code for a few reasons (`qoe`). */
  decisionReasonCode?: string
}

/** The {@link PermissionDenialSource}s cli.js itself can send. */
type WireDenialSource = Exclude<PermissionDenialSource, 'autoModeNoVerdict'>

/**
 * cli.js's declared `PermissionDecisionReason` discriminators (`WBn`). Kept as a
 * runtime Set rather than trusting the string: `decision_reason_type` is a wire
 * field, and a value we do not recognise must degrade to `other` instead of
 * reaching a `PermissionDenialSource`-typed slot unchecked.
 *
 * WIRE-ONLY on purpose. `autoModeNoVerdict` is a source WE derive from a
 * `classifier` frame (see {@link permissionDecisionBlock}); cli.js never sends
 * it, so a frame that claimed it must degrade to `other` like any other
 * unknown value. The `WireDenialSource` element type keeps it out statically.
 */
const DENIAL_SOURCES = new Set<WireDenialSource>([
  'rule',
  'mode',
  'subcommandResults',
  'permissionPromptTool',
  'hook',
  'asyncAgent',
  'sandboxOverride',
  'workingDir',
  'safetyCheck',
  'other'
])

/** True when this frame is the auto-mode judge speaking, rather than a rule. */
export function isClassifierDecision(frame: PermissionDecisionFrame): boolean {
  return frame.decisionReasonType === 'classifier'
}

function denialSource(raw: string | undefined): WireDenialSource {
  return raw !== undefined && DENIAL_SOURCES.has(raw as WireDenialSource)
    ? (raw as WireDenialSource)
    : 'other'
}

/**
 * Stage 2 is asked for `<reason>[Exact Rule Name] one short sentence</reason>`,
 * so a classifier reason usually arrives with its rule already in front. Split
 * it back apart so the rule can render as the card's badge and the sentence as
 * its prose — which is exactly the shape pi and opencode build from their
 * separate `<category>` and `<reason>` tags, and therefore what makes the three
 * engines' cards identical.
 *
 * The character class mirrors cli.js's own category guard (`IOd`,
 * `/^[a-z0-9 _-]{1,48}$/i`) plus `/`, because a rule NAME is copied verbatim
 * and the corpus contains `Logging/Audit Tampering` — it is the `<category>`
 * tag, not the reason's prefix, that has the slashes stripped. Bounded on
 * purpose: this is model text reached by attacker-influenced transcript
 * content, so an unbounded prefix would be a free-form badge.
 *
 * `fast` mode never asks for a reason prefix and a model may drop it anyway, so
 * a reason with no bracket is not an error — it is simply all rationale.
 */
const RULE_PREFIX_RE = /^\[([A-Za-z0-9 _/-]{1,48})\]\s*([\s\S]*)$/

export function splitRulePrefix(reason: string | undefined): {
  rule?: string
  rationale?: string
} {
  const trimmed = reason?.trim()
  if (!trimmed) return {}
  const m = RULE_PREFIX_RE.exec(trimmed)
  // No bracket, or an empty one (`[] …`) that names nothing: the whole string
  // is rationale, so the user still sees everything the judge said.
  const rule = m?.[1].trim()
  if (!rule) {
    const rationale = reviewRationale(trimmed)
    return rationale ? { rationale } : {}
  }
  // A bracket with nothing after it is a rule name and no sentence.
  const rationale = reviewRationale(m?.[2])
  return { rule, ...(rationale ? { rationale } : {}) }
}

/**
 * Stage 2's content-free denial reasons: its fallbacks when it names no rule
 * (`"Blocked by classifier"`, category mode) or the model gave no `<reason>`
 * (`"No reason provided"`). Only the RATIONALE is dropped — the decision stands,
 * and a `[Rule Name]` in front is still split out into the badge. Exact match,
 * so a real sentence that merely contains these words survives.
 */
const CONTENT_FREE_DENY_REASONS = new Set(['Blocked by classifier', 'No reason provided'])

/**
 * cli.js's "the classifier could not be reached" reason (`Gwe`). It arrives on a
 * `classifier` DENY that no judge weighed; cli.js itself tells it apart by this
 * exact string (its own `automode-unavailable` classification), so we do too.
 */
const CLASSIFIER_UNAVAILABLE_REASON = 'Classifier unavailable'

/**
 * cli.js's reason when the server-side classifier gave no usable verdict for
 * several responses in a row and it stopped the turn (`ptn`, 2.1.280).
 */
const NO_VERDICT_STREAK_REASON =
  'Auto mode unavailable — stopped after repeated responses with no safety verdict'

/**
 * The `decision_reason_code` cli.js sends on a `classifier` denial ONLY when the
 * transcript overflowed the classifier's context and it reached no verdict
 * (`qoe`: `noVerdict === true && reason === fVe`, 2.1.280).
 */
const TRANSCRIPT_TOO_LONG_CODE = 'classifier_transcript_too_long'

/**
 * A classifier block as the verdict that renders on the card it judged.
 *
 * `reviewId` is the FRAME's uuid rather than a fresh one: cli.js mints exactly
 * one frame per decision, so using it makes a replayed catch-up idempotent for
 * free — the reducer's dedupe key is `reviewId`.
 */
export function classifierReviewBlock(frame: PermissionDecisionFrame): ToolReviewBlock {
  const { rule, rationale: said } = splitRulePrefix(frame.decisionReason)
  const rationale = said !== undefined && CONTENT_FREE_DENY_REASONS.has(said) ? undefined : said
  return {
    type: 'tool_review',
    toolUseId: frame.toolUseId,
    reviewId: frame.frameUuid,
    reviewer: 'auto-mode',
    decision: 'denied',
    ...(rule ? { rule } : {}),
    ...(rationale ? { rationale } : {})
  }
}

/** A non-judge pre-ask denial as its own block. */
export function permissionDenialBlock(frame: PermissionDecisionFrame): PermissionDenialBlock {
  return denialBlock(frame, denialSource(frame.decisionReasonType))
}

function denialBlock(
  frame: PermissionDecisionFrame,
  source: PermissionDenialSource
): PermissionDenialBlock {
  const reason = reviewRationale(frame.decisionReason)
  return {
    type: 'permission_denial',
    toolUseId: frame.toolUseId,
    denialId: frame.frameUuid,
    source,
    ...(reason ? { reason } : {})
  }
}

/**
 * True when a `classifier` DENY is a fallback rather than a verdict. The frame
 * carries no flag, so these are the native signals: the transcript-overflow
 * reason code, and the two fixed reasons "Classifier unavailable" and the
 * no-verdict streak. All exact matches.
 */
function isNoVerdictDenial(frame: PermissionDecisionFrame): boolean {
  if (frame.decisionReasonCode === TRANSCRIPT_TOO_LONG_CODE) return true
  const reason = frame.decisionReason?.trim()
  return reason === CLASSIFIER_UNAVAILABLE_REASON || reason === NO_VERDICT_STREAK_REASON
}

/**
 * The single routing decision: which block a `permission_denied` frame renders
 * as on its card.
 *
 *  - classifier → a denied review, UNLESS it is a recognisable no-verdict
 *    fallback ({@link isNoVerdictDenial}); then a `permission_denial` with
 *    source `autoModeNoVerdict`, because the refusal is real but no judgment
 *    was made.
 *  - anything else → a `permission_denial` naming its source.
 */
export function permissionDecisionBlock(
  frame: PermissionDecisionFrame
): ToolReviewBlock | PermissionDenialBlock {
  if (isClassifierDecision(frame)) {
    return isNoVerdictDenial(frame)
      ? denialBlock(frame, 'autoModeNoVerdict')
      : classifierReviewBlock(frame)
  }
  return permissionDenialBlock(frame)
}

/**
 * Narrow a raw `system/permission_denied` message to the fields we use, or
 * `null` when it cannot be bound to a card.
 *
 * `tool_use_id` is required, not defaulted: a denial with no call to attach to
 * has nowhere to render, and inventing an id would park a block against a card
 * that does not exist. The frame `uuid` is required for the same reason its
 * absence would break idempotence — a decision we cannot dedupe would
 * re-append on every replay.
 */
export function readPermissionDecisionFrame(
  msg: Record<string, unknown>
): PermissionDecisionFrame | null {
  const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : ''
  const frameUuid = typeof msg.uuid === 'string' ? msg.uuid : ''
  if (!toolUseId || !frameUuid) return null
  return {
    toolUseId,
    frameUuid,
    ...(typeof msg.agent_id === 'string' && msg.agent_id ? { agentId: msg.agent_id } : {}),
    ...(typeof msg.decision_reason_type === 'string'
      ? { decisionReasonType: msg.decision_reason_type }
      : {}),
    ...(typeof msg.decision_reason === 'string' ? { decisionReason: msg.decision_reason } : {}),
    ...(typeof msg.decision_reason_code === 'string'
      ? { decisionReasonCode: msg.decision_reason_code }
      : {})
  }
}
