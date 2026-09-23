/**
 * cli.js's pre-ask permission frames → the blocks the cards render.
 *
 * Claude's Auto mode is cli.js-native: the two-stage classifier documented in
 * `docs/protocol-cc/14-auto-mode-classifier.md` runs INSIDE the CLI, so unlike
 * opencode and pi we do not call the judge — we read its verdict off the wire.
 * Two frames carry it (`docs/protocol-cc/04-system-subtypes.md` §4.25):
 *
 *  - `system/permission_denied` — stock cli.js, emitted for EVERY pre-ask
 *    denial, not just the classifier's. `decision_reason_type` says which:
 *    `classifier` is a judge's verdict, everything else is a rule / mode / hook
 *    / safety-check refusal.
 *  - `system/permission_allowed` — the `automode-verdict` patch. Stock cli.js
 *    emits nothing when the classifier ALLOWS (the emit site is gated on
 *    `behavior === "deny"`), which is the whole reason the patch exists: an
 *    allowed call would otherwise show no verdict at all, where pi and opencode
 *    both show one.
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
 * unreachable — and blocks the call anyway. Those become a
 * `PermissionDenialBlock` with the synthetic source `autoModeNoVerdict`: the
 * action was refused, but nobody weighed it, so a "review" would claim a
 * judgment that never happened.
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
  /**
   * The `automode-verdict` patch's `no_verdict: true` — cli.js decided under
   * the `classifier` banner without the classifier reaching a verdict. Present
   * only when the wire carried exactly `true`.
   */
  noVerdict?: true
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
 * cli.js's content-free allow reasons. Unlike a DENIAL's reason — which is the
 * judge's own `<reason>` text — an allow's is a fixed constant naming the stage
 * that cleared it (stage 1, stage 2, the server-side classifier), or stage 2's
 * fallback when the model gave no `<reason>` at all.
 *
 * They are dropped rather than rendered, for two reasons. The card's own
 * sentence is already "Auto mode allowed this action", so the strip read as the
 * same claim twice (verifier finding, 2026-09-21). And pi and opencode surface
 * no reason on a routine allow either — stage 1 is run behind a `</block>` stop
 * sequence that is never asked for one — so keeping these would make Claude's
 * card the odd one out, which is the exact thing this work exists to fix.
 *
 * Matched by exact string on purpose: an allow that says anything ELSE is
 * carrying real information and must survive.
 */
const CONTENT_FREE_ALLOW_REASONS = new Set([
  'Allowed by classifier',
  'Allowed by fast classifier',
  'Not flagged by the server-side auto mode classifier',
  'No reason provided'
])

/**
 * The same for a denial: stage 2's fallbacks when it names no rule
 * (`"Blocked by classifier"`, category mode) or the model gave no `<reason>`
 * (`"No reason provided"`). Only the RATIONALE is dropped — the decision stands,
 * and a `[Rule Name]` in front is still split out into the badge. Exact match,
 * so a real sentence that merely contains these words survives.
 */
const CONTENT_FREE_DENY_REASONS = new Set(['Blocked by classifier', 'No reason provided'])

/**
 * cli.js's "the classifier could not be reached" reason (`Gwe`). It arrives on a
 * `classifier` DENY with no `noVerdict` flag; cli.js itself tells it apart by
 * this exact string (its own `automode-unavailable` classification), so we do
 * too.
 */
const CLASSIFIER_UNAVAILABLE_REASON = 'Classifier unavailable'

/**
 * A classifier verdict as the block that renders on the card it judged.
 *
 * `reviewId` is the FRAME's uuid rather than a fresh one: cli.js mints exactly
 * one frame per decision, so using it makes a replayed catch-up idempotent for
 * free — the reducer's dedupe key is `reviewId`.
 */
export function classifierReviewBlock(
  frame: PermissionDecisionFrame,
  decision: 'approved' | 'denied'
): ToolReviewBlock {
  const { rule, rationale: said } = splitRulePrefix(frame.decisionReason)
  const contentFree =
    decision === 'approved' ? CONTENT_FREE_ALLOW_REASONS : CONTENT_FREE_DENY_REASONS
  const rationale = said !== undefined && contentFree.has(said) ? undefined : said
  return {
    type: 'tool_review',
    toolUseId: frame.toolUseId,
    reviewId: frame.frameUuid,
    reviewer: 'auto-mode',
    decision,
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
 * True when a `classifier` DENY is a fallback rather than a verdict: the patch
 * flagged it `no_verdict`, or it is cli.js's "Classifier unavailable", which
 * carries no flag.
 */
function isNoVerdictDenial(frame: PermissionDecisionFrame): boolean {
  return frame.noVerdict === true || frame.decisionReason?.trim() === CLASSIFIER_UNAVAILABLE_REASON
}

/**
 * The single routing decision: which block, if any, a decision frame renders
 * as on its card.
 *
 *  - classifier + allowed → an approved review. `null` for a no-verdict allow:
 *    the patch never emits one (it gates on cli.js's own `classifierAllowed`),
 *    so this is defensive — an allow nobody judged is just the tool running.
 *  - classifier + denied → a denied review, UNLESS the classifier reached no
 *    verdict; then a `permission_denial` with source `autoModeNoVerdict`,
 *    because the refusal is real but no judgment was made.
 *  - non-classifier + allowed → `null`. The patch emits allows for classifier
 *    verdicts only, so this means the wire contract moved; the caller logs it.
 *  - non-classifier + denied → a `permission_denial` naming its source.
 */
export function permissionDecisionBlock(
  frame: PermissionDecisionFrame,
  outcome: 'allowed' | 'denied'
): ToolReviewBlock | PermissionDenialBlock | null {
  if (isClassifierDecision(frame)) {
    if (outcome === 'allowed') {
      return frame.noVerdict ? null : classifierReviewBlock(frame, 'approved')
    }
    return isNoVerdictDenial(frame)
      ? denialBlock(frame, 'autoModeNoVerdict')
      : classifierReviewBlock(frame, 'denied')
  }
  return outcome === 'denied' ? permissionDenialBlock(frame) : null
}

/**
 * Narrow a raw `system/permission_denied` / `permission_allowed` message to the
 * fields we use, or `null` when it cannot be bound to a card.
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
    ...(msg.no_verdict === true ? { noVerdict: true as const } : {})
  }
}
