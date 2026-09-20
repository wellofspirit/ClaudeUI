/**
 * usage-ledger.ts — what ONE Codex turn added to a native thread's totals
 * (ADR-071 §4).
 *
 * Codex reports usage as a CUMULATIVE per-thread total on
 * `thread/tokenUsage/updated`, never as a per-turn figure, so a ledger row is a
 * delta and a delta needs a baseline. The S0 probe
 * (`docs/codex-spike.md` § "Token usage across a resume") settled what that
 * baseline has to be:
 *
 *  - the total belongs to the native THREAD and continues across a second turn,
 *    a resume after an unload, a resume by another process, and a fork — a
 *    fork's first total is the SOURCE's, not zero;
 *  - a resume replays one frame before any new turn, repeating the last
 *    completed turn's cumulative;
 *  - one turn can emit several frames under one turn id, one per model request;
 *  - a child thread meters itself under its own thread id and never appears in
 *    its parent's total.
 *
 * So: one baseline per native thread id, moved only at turn end, and a turn's
 * row is the newest cumulative minus the baseline as it stood when the turn
 * began. A replay is then a no-op, a fork's first turn is charged its own
 * tokens rather than the source's history, a multi-request turn is one row, and
 * a child keeps its own books.
 *
 * KNOWN LIMITS, both accepted by ADR-071 §4:
 *
 *  - The first frame a thread is SHOWN can only seed a baseline when the app
 *    did not create that thread — a brand-new thread has no frame before its
 *    first turn, so seeding from the first frame there would throw the first
 *    turn away. {@link CodexUsageLedger.openThread} therefore takes which case
 *    it is: a thread this app created (`thread/start`, and every spawned child,
 *    which is always new) starts at ZERO, and a resumed or forked one starts at
 *    whatever cumulative it is first shown. The one case zero cannot cover is a
 *    resume of a thread that never completed a turn: the app-server replays no
 *    frame for it, so its first turn seeds the baseline and is not recorded.
 *  - A turn whose end is never seen (a host killed mid-turn) leaves its tokens
 *    in the next observed cumulative, which charges them to the FOLLOWING turn.
 *    That misattributes one turn and neither drops nor double counts, which is
 *    the trade the ADR takes.
 */

import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'
import type { UsageTurnTokens } from '../services/usage-recorder'

/**
 * Every component of the breakdown. A delta is taken on all of them, and a
 * cumulative is judged to have gone backwards if ANY of them has, so the list
 * is stated once rather than per operation.
 */
const COMPONENTS: ReadonlyArray<keyof TokenUsageBreakdown> = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens'
]

/** A thread this app CREATED has no frame before its first turn; a thread it
 *  resumed or forked is already carrying history it must not be charged for. */
export type CodexThreadOrigin = 'created' | 'observed'

interface ThreadState {
  /** What has already been recorded. Null until the first frame seeds it. */
  baseline: TokenUsageBreakdown | null
  /** The newest cumulative SINCE the last turn end. Null = nothing to charge. */
  latest: TokenUsageBreakdown | null
}

const ZERO: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
}

/**
 * The per-thread baselines of ONE session. Pure: it holds numbers, answers
 * "what did this turn add", and knows nothing about rows, accounts or prices.
 */
export class CodexUsageLedger {
  private readonly threads = new Map<string, ThreadState>()

  /**
   * Start keeping books for a thread. Idempotent on purpose: a thread that is
   * re-resumed onto another host is the same thread with the same history, and
   * re-seeding it there would charge the next turn everything since the last
   * one.
   */
  openThread(threadId: string, origin: CodexThreadOrigin): void {
    if (this.threads.has(threadId)) return
    this.threads.set(threadId, {
      baseline: origin === 'created' ? { ...ZERO } : null,
      latest: null
    })
  }

  /**
   * One `thread/tokenUsage/updated` for `threadId`, carrying `tokenUsage.total`.
   *
   * A thread nobody opened is treated as observed rather than created: charging
   * a whole lifetime total to one turn is the worse of the two errors.
   */
  observe(threadId: string, total: TokenUsageBreakdown): void {
    const cumulative = normalize(total)
    let state = this.threads.get(threadId)
    if (!state) {
      state = { baseline: null, latest: null }
      this.threads.set(threadId, state)
    }
    const baseline = state.baseline
    // The first frame states where this thread already stood; it is not spend
    // this app watched happen. A component going DOWN means the total was
    // REPLACED rather than added to — `TokenUsageInfo::fill_to_context_window`
    // in the pinned source does exactly that — and there is no honest delta
    // across a replacement, so both cases re-seed and charge nothing.
    if (!baseline || COMPONENTS.some((key) => cumulative[key] < baseline[key])) {
      state.baseline = cumulative
      state.latest = null
      return
    }
    state.latest = cumulative
  }

  /**
   * A turn on `threadId` ended: what it added, or null when there is nothing to
   * record — no frame since the last turn (or since the baseline was seeded),
   * or a delta that is zero in every component.
   */
  turnEnded(threadId: string): TokenUsageBreakdown | null {
    const state = this.threads.get(threadId)
    const baseline = state?.baseline
    const latest = state?.latest
    if (!state || !baseline || !latest) return null
    const delta = {} as TokenUsageBreakdown
    for (const key of COMPONENTS) delta[key] = latest[key] - baseline[key]
    // Moved whether or not a row follows: the tokens are accounted for either
    // way, and a zero delta leaves the baseline where it already was.
    state.baseline = latest
    state.latest = null
    return COMPONENTS.every((key) => delta[key] === 0) ? null : delta
  }
}

/**
 * Codex's NESTED token shape as the DISJOINT one prices and ledger rows want.
 *
 * `inputTokens` is the whole prompt, with `cachedInputTokens` (cache hits) and
 * `cacheWriteInputTokens` (tokens written into the cache) as SUBSETS of it —
 * the OpenAI Responses API's `usage.input_tokens` /
 * `input_tokens_details.{cached_tokens, cache_write_tokens}`, copied field for
 * field in `codex-rs/codex-api/src/sse/responses.rs`. So the base rate applies
 * to what is left after both. `reasoningOutputTokens` is likewise a subset of
 * `outputTokens` and must never be added again.
 *
 * One statement of that mapping for this session's two readers — the price of
 * the meter ({@link import('./CodexSession').CodexSession.equivalentCost}) and
 * the tokens of a row. The dispatcher keeps its own copy for a target session
 * it does not own (`codexTurnCostUsd`).
 */
export function codexDisjointTokens(
  usage: Pick<
    TokenUsageBreakdown,
    'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'
  >
): UsageTurnTokens {
  return {
    input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
    output: usage.outputTokens,
    cacheWrite: usage.cacheWriteInputTokens,
    // OpenAI publishes ONE cache-write rate; the 5m/1h split is Anthropic's.
    cacheWrite1h: 0,
    cacheRead: usage.cachedInputTokens
  }
}

/**
 * A frame's totals as numbers this can subtract. The wire type says `number`,
 * and a missing or non-finite component would otherwise turn a whole row's
 * counts into NaN — a shape the ledger cannot detect as backwards either.
 */
function normalize(total: TokenUsageBreakdown): TokenUsageBreakdown {
  const clean = {} as TokenUsageBreakdown
  for (const key of COMPONENTS) {
    const value = total[key]
    clean[key] = Number.isFinite(value) ? Math.max(0, value) : 0
  }
  return clean
}
