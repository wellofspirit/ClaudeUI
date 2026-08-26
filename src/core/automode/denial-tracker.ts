/**
 * Auto-mode denial bookkeeping and block surfacing — engine-neutral.
 *
 * Two things live here, both of which exist to give `ClassifyResult.category`
 * (the corpus rule the judge matched) a real consumer instead of a log line:
 *
 * 1. {@link AutoModeDenialTracker} — the caps that decide when auto mode stops
 *    answering for the user and hands the decision back.
 * 2. {@link formatAutoModeDenyReason} — the model-visible deny text, which
 *    names the matched rule so the agent can tell WHICH bar it hit.
 *
 * ## Why a category cap
 *
 * A block is a QUESTION, not a dead end (plan §7 Q3). The historical caps
 * (3 consecutive / 20 total) only notice a broad grind. But an agent that is
 * blocked twice on the *same rule* is grinding one intent — rewording a push,
 * re-attempting the same delete — and no amount of further rewording will
 * produce consent it does not have. The human is the only one who can resolve
 * that, and they should get it on the second block rather than the third.
 *
 * Uncategorized blocks (a `fast`-mode verdict, or a stage-2 reply whose
 * `<category>` failed corpus validation) carry no intent signal, so they keep
 * the plain 3-consecutive rule.
 *
 * Both engines share ONE implementation. opencode and pi each carried their own
 * copy of the same counter block before this; an auto-mode governor that can
 * drift between engines is a bug waiting to happen, and the cap rules are pure
 * policy with no engine surface in them.
 */
import { ruleNameForCategory } from './rules/corpus'

/** Blocks on the SAME corpus rule in a row before the human takes over. */
export const SAME_CATEGORY_DENIAL_CAP = 2
/** Blocks in a row (any/no category) before the human takes over. */
export const CONSECUTIVE_DENIAL_CAP = 3
/** Blocks in one session before auto mode stops deciding at all. */
export const TOTAL_DENIAL_CAP = 20

/**
 * Per-session denial counters. One instance per engine session; the engine
 * calls {@link recordBlock} on every auto-mode block and {@link recordAllow}
 * on every auto-mode allow.
 */
export class AutoModeDenialTracker {
  private consecutive = 0
  private total = 0
  /** Category of the previous block (`undefined` = it had none). */
  private lastCategory: string | undefined
  /** How many blocks in a row have carried {@link lastCategory}. */
  private sameCategory = 0

  /**
   * Record one block and decide whether a cap just fired.
   *
   * @param category validated corpus slug from `ClassifyResult.category`, if the
   *   judge produced one.
   * @returns `null` to deny the action as normal, or a human-readable sentence
   *   explaining the handoff — pass it as `PendingApproval.decisionReason` so
   *   the approval card says why auto mode stopped deciding.
   */
  recordBlock(category?: string): string | null {
    this.total++
    this.consecutive++
    if (category && category === this.lastCategory) this.sameCategory++
    else this.sameCategory = category ? 1 : 0
    this.lastCategory = category

    // Same-category first: it fires at 2, inside the 3-consecutive window, and
    // its reason is the more specific of the two.
    if (category && this.sameCategory >= SAME_CATEGORY_DENIAL_CAP) {
      const rule = ruleNameForCategory(category) ?? category
      return this.cap(
        `Auto mode blocked this ${this.sameCategory} times in a row (rule: ${rule}) — asking you instead.`
      )
    }
    if (this.consecutive >= CONSECUTIVE_DENIAL_CAP) {
      return this.cap(
        `Auto mode blocked ${this.consecutive} actions in a row — asking you instead.`
      )
    }
    // NOT reset by `cap()`: past the session total, every further block hands
    // over. Twenty blocks is auto mode telling the user it is the wrong mode
    // for this task (existing behaviour, kept).
    if (this.total >= TOTAL_DENIAL_CAP) {
      return this.cap(
        `Auto mode has blocked ${this.total} actions this session — asking you instead.`
      )
    }
    return null
  }

  /** An allowed action clears the streaks (the agent is not grinding). */
  recordAllow(): void {
    this.consecutive = 0
    this.sameCategory = 0
    this.lastCategory = undefined
  }

  /** Cap fired: the streaks restart so the NEXT grind is measured afresh. */
  private cap(reason: string): string {
    this.consecutive = 0
    this.sameCategory = 0
    this.lastCategory = undefined
    return reason
  }
}

/**
 * The deny text sent back to the model when auto mode blocks.
 *
 * Stage 2 is asked for `<reason>[Exact Rule Name] one short sentence</reason>`,
 * so the rule name is usually already there — but `fast` mode never asks for
 * one, and a model that drops the prefix leaves the agent guessing which bar it
 * hit (and therefore what consent to ask the user for). When we have a
 * validated `category` and the reason does not already name it, prefix it.
 * Matching is case-insensitive substring: the point is to avoid saying
 * "[Git Destructive] [Git Destructive] …", not to police wording.
 */
export function formatAutoModeDenyReason(result: { reason?: string; category?: string }): string {
  const base = result.reason?.trim() || 'flagged as potentially unsafe'
  const rule = result.category ? ruleNameForCategory(result.category) : undefined
  const named =
    rule && !base.toLowerCase().includes(rule.toLowerCase()) ? `[${rule}] ${base}` : base
  return `Auto mode blocked: ${named}`
}
