/**
 * usage-window-ledger.ts — the window-value ledger (ADR-071 §7).
 *
 * A limit window says how much of a plan was used, as a percent. The ledger
 * says what the turns inside it were worth, in dollars. `usage_window` holds
 * both for one `(account_key, window_kind, canonical_end)`, so the dashboard can
 * divide them and answer the question the owner actually asks of a
 * subscription: what does a full window of this plan deliver.
 *
 * THE BIAS IS STRUCTURAL, and every row this module returns carries a flag
 * saying so. `peak_percent` is the account's GLOBAL utilization — the provider
 * counts every machine and claude.ai too — while the dollars are only what THIS
 * ledger recorded. Usage anywhere else pushes the percent up without adding
 * dollars, so the implied value of a window reads LOW. ADR-072's hub fixes the
 * other-machines half by summing the numerator across machines; nothing fixes
 * the claude.ai half.
 *
 * This module owns the RULE: what a window spans, which windows a recompute
 * touches, when one closes, and what is derived on read. `db.ts` holds the SQL
 * it needs.
 */

import {
  getLedgerCostRows,
  getOpenUsageWindows,
  insertMissingUsageWindows,
  listUsageWindows,
  upsertUsageWindows,
  windowSampleGroups,
  type UsageWindowRow
} from './db'
import { logger } from './logger'

const MS_PER_HOUR = 60 * 60 * 1000

export const FIVE_HOUR_MS = 5 * MS_PER_HOUR
export const SEVEN_DAY_MS = 7 * 24 * MS_PER_HOUR

/**
 * How long a window of each kind lasts — the one statement of the rule that
 * migration v22's seed restates in SQL.
 *
 * `5h` is Claude's five-hour block. Everything else is a week: `7d`, and the
 * `7d:<slug>` per-model weekly buckets a Max plan reports. An unrecognised kind
 * falls to a week rather than to nothing, because a window whose start cannot be
 * computed has no numerator at all, and a week is the wider (so more forgiving)
 * of the two spans.
 */
export function windowDurationMs(kind: string): number {
  return kind === '5h' ? FIVE_HOUR_MS : SEVEN_DAY_MS
}

/**
 * How far back a recompute will MATERIALIZE a window it has no row for.
 *
 * Exactly `usage_window_sample`'s retention (`pruneUsageTables`): a sample older
 * than this does not exist, so a longer reach would find nothing and a shorter
 * one would silently drop a window the samples still describe — which matters
 * after the app has been closed for a while, when every window that passed
 * meanwhile is discovered in one pass.
 */
const SAMPLE_LOOKBACK_MS = 30 * 24 * MS_PER_HOUR

/** Below this peak, dividing by the percent turns noise into a headline (ADR-071 §7). */
export const MIN_PEAK_PERCENT_FOR_VALUE = 5

/**
 * How long after its end a window stays open to late arrivals.
 *
 * A turn does NOT reach the ledger at the instant it happened. The Claude
 * reconciler ticks every ten minutes, and a session the app was not watching is
 * reconciled on the next start — so a row whose `ts` falls inside a window can
 * land well after that window ended, and closing on the first pass after the end
 * would drop it with no way to notice. A day covers every realistic late
 * arrival: the reconciler's own cadence, an app left closed overnight, and a
 * transcript upsert on the first rebuild after a restart.
 *
 * ADR-071 §7's "closed is final" holds from the end of the grace onward.
 */
export const WINDOW_CLOSE_GRACE_MS = 24 * MS_PER_HOUR

function windowKey(accountKey: string, windowKind: string, canonicalEnd: number): string {
  return `${accountKey}|${windowKind}|${canonicalEnd}`
}

/**
 * Rebuild every window that can still change, and close the ones that cannot.
 *
 * WHICH WINDOWS. Two sets, and their union is the answer:
 *
 *  - every row with `closed = 0` — the windows still running, plus the ended
 *    ones still inside their grace (see below);
 *  - every window a sample in the lookback NAMES but that has no row at all.
 *    A window is "named" by a `usage_window_sample` carrying its
 *    `(account_key, window_kind, canonical_end)`; those are inserted with
 *    `OR IGNORE`, so a window that is already closed is never resurrected by a
 *    late sample and an open one keeps what it has.
 *
 * A CLOSED WINDOW IS NEVER TOUCHED AGAIN. That is what `closed` is for: the
 * sums are final, the samples behind the peak will be pruned, and a later pass
 * recomputing from a half-pruned table would only make the row worse.
 *
 * WHEN ONE CLOSES. Not when its end passes — {@link WINDOW_CLOSE_GRACE_MS}
 * after, because a turn reaches the ledger later than it happened and a window
 * shut at its own end would drop every late arrival. Until the grace is up the
 * window is recomputed on every pass like any other open one, so a row the
 * reconciler backfills is picked up. The pass that finally closes it has just
 * summed it, so the final sums are computed strictly after the window ended —
 * which is what "a final recompute has run" means. A window whose end and grace
 * both pass while the app is closed is summed and closed by the first pass after
 * start-up.
 *
 * THE PEAK CAN LAG BY ONE PASS. Nothing listens for a limits reading; the
 * recompute runs where usage moves (`BlockUsageService.rebuildFromEntries`), so
 * a reading that arrives between two rebuilds is not in the table until the
 * next one. It is never LOST — the sample is on disk and the next pass reads it.
 *
 * Advisory, like every other write on the usage path: a failure here must not
 * fail the rebuild that called it.
 */
export function recomputeUsageWindows(now: number): number {
  try {
    const groups = windowSampleGroups(now - SAMPLE_LOOKBACK_MS)

    insertMissingUsageWindows(
      groups.map((g) => ({
        accountKey: g.accountKey,
        windowKind: g.windowKind,
        canonicalEnd: g.canonicalEnd,
        windowStart: g.canonicalEnd - windowDurationMs(g.windowKind)
      }))
    )

    const open = getOpenUsageWindows()
    if (open.length === 0) return 0

    const byWindow = new Map(
      groups.map((g) => [windowKey(g.accountKey, g.windowKind, g.canonicalEnd), g])
    )

    const rebuilt: UsageWindowRow[] = open.map((w) => {
      const group = byWindow.get(windowKey(w.accountKey, w.windowKind, w.canonicalEnd))
      const windowStart = w.canonicalEnd - windowDurationMs(w.windowKind)

      let apiCostUsd = 0
      let billedCostUsd = 0
      let unknownCostCount = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheWriteTokens = 0
      let cacheReadTokens = 0

      for (const row of getLedgerCostRows(w.accountKey, windowStart, w.canonicalEnd)) {
        // The API-EQUIVALENT figure, literally: what the tokens were worth at
        // list price, whatever the turn was actually charged. That is the
        // question this ledger answers — how much work a window of the plan
        // delivered — and it is not the same as what the work cost, which is the
        // dashboard's own total and goes through the display rule instead.
        //
        // A turn nothing could price is COUNTED, never added as a zero
        // (ADR-030): a window that could not price half its turns must not read
        // as a cheap window.
        if (row.apiCostUsd !== null && Number.isFinite(row.apiCostUsd)) {
          apiCostUsd += row.apiCostUsd
        } else {
          unknownCostCount += 1
        }
        if (row.billedCostUsd !== null && Number.isFinite(row.billedCostUsd)) {
          billedCostUsd += row.billedCostUsd
        }
        inputTokens += row.inputTokens
        outputTokens += row.outputTokens
        cacheWriteTokens += row.cacheWriteTokens
        cacheReadTokens += row.cacheReadTokens
      }

      return {
        accountKey: w.accountKey,
        windowKind: w.windowKind,
        canonicalEnd: w.canonicalEnd,
        windowStart,
        // The highest reading ever SEEN, not the highest still on disk: samples
        // are pruned at 30 days, so a freshly recomputed maximum can only ever
        // be lower than one an earlier pass recorded.
        peakPercent: Math.max(w.peakPercent, group?.peakPercent ?? 0),
        apiCostUsd,
        billedCostUsd,
        unknownCostCount,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        sampleCount: Math.max(w.sampleCount, group?.sampleCount ?? 0),
        closed: w.canonicalEnd < now - WINDOW_CLOSE_GRACE_MS,
        updatedAt: now
      }
    })

    upsertUsageWindows(rebuilt)
    return rebuilt.length
  } catch (err) {
    logger.debug('UsageWindows', `recomputeUsageWindows failed: ${err}`)
    return 0
  }
}

/** One window row with what a reader derives from it. */
export interface UsageWindowSummaryRow extends UsageWindowRow {
  /** Dollars the ledger saw per 1% of the window, or null under the noise floor. */
  usdPerPercent: number | null
  /** What a FULL window would have been worth at that rate, or null under the noise floor. */
  impliedFullWindowUsd: number | null
  /**
   * Always true, and always shown: the numerator is this machine's ledger while
   * the denominator is the account's global utilization, so every derived figure
   * here reads LOW by however much the account was used elsewhere (ADR-071 §7).
   */
  biased: true
}

/**
 * The windows a surface reads, with the two derived figures.
 *
 * CLOSED WINDOWS ARE INCLUDED, and are most of the answer: `usage_window_sample`
 * is pruned at 30 days, so past that these rows are the only record that the
 * window existed and what it delivered.
 *
 * THE NOISE FLOOR LIVES HERE, NOT IN THE TABLE. A window whose peak is under
 * {@link MIN_PEAK_PERCENT_FOR_VALUE} keeps its real sums and its real peak —
 * they are facts — and reports no derived figure, because dividing dollars by a
 * percent near zero produces an implied window value of any size at all. Keeping
 * the rule on the read side means the floor can move without a migration and
 * without losing a row.
 */
/** What {@link usageWindowSummary} takes, and what the IPC channel accepts. */
export interface UsageWindowQuery {
  accountKey?: string
  kind?: string
  sinceTs?: number
}

/**
 * Narrow an untrusted query to the three fields, dropping anything else.
 *
 * Both handler files call this: the channel is on the remote transport too, so
 * the argument arrives off the wire, and every value reaches a prepared
 * statement's parameter — a wrong TYPE there is a driver error rather than a
 * filter, which would fail the whole read for the sake of one bad field.
 */
export function sanitizeUsageWindowQuery(raw: unknown): UsageWindowQuery {
  if (typeof raw !== 'object' || raw === null) return {}
  const { accountKey, kind, sinceTs } = raw as Record<string, unknown>
  return {
    ...(typeof accountKey === 'string' ? { accountKey } : {}),
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof sinceTs === 'number' && Number.isFinite(sinceTs) ? { sinceTs } : {})
  }
}

export function usageWindowSummary(opts: UsageWindowQuery = {}): UsageWindowSummaryRow[] {
  return listUsageWindows(opts).map((row) => {
    const rate =
      row.peakPercent >= MIN_PEAK_PERCENT_FOR_VALUE ? row.apiCostUsd / row.peakPercent : null
    return {
      ...row,
      usdPerPercent: rate,
      impliedFullWindowUsd: rate === null ? null : rate * 100,
      biased: true
    }
  })
}
