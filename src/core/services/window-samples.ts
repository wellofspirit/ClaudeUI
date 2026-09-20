/**
 * The one writer of `usage_window_sample` (ADR-071 §6).
 *
 * Three callers record limit readings and none of them may invent its own
 * identity for a window: the active Claude poll (`UsageFetcher`), the limits
 * provider's on-demand read of an INACTIVE Claude account, and the ChatGPT
 * store when a live Codex session pushes a snapshot. They agree here on the two
 * things that make a sample comparable — the canonical window end (ADR-011's
 * snap rule, now applied to every window kind, not only the 5-hour one) and the
 * `(account_key, window_kind)` the row is filed under.
 *
 * The dedup is module state, not per-caller state, for two reasons: it is one
 * rule and belongs in one place for all three writers, and it has to outlive any
 * single one of them — a re-instantiated `UsageFetcher` that started with an
 * empty memory would re-write the sample it had already written.
 */

import { randomUUID } from 'node:crypto'
import { recordWindowSample } from './db'
import { canonicalizeWindowEnd } from './usage-windows'
import { logger } from './logger'

/** One window of a reading, as a writer sees it. */
export interface LimitSampleWindow {
  /** `5h`, `7d`, `7d:<model>` — see `AccountLimitWindow.kind`. */
  kind: string
  usedPercent: number
  resetsAt: string | null
}

export interface LimitSampleInput {
  accountKey: string
  /**
   * The Claude account uuid, when the vendor has one. It is what the WLS
   * projection still reads by (`getWindowSamples`), so a Claude sample without
   * it would vanish from the projection; a ChatGPT sample has none and files
   * its account key in that column instead.
   */
  accountUuid?: string | null
  windows: LimitSampleWindow[]
  now?: number
}

/** How many canonical ends to remember per series — a window lives 5 h or 7 d. */
const MAX_KNOWN_ENDS = 8

/** `accountKey:accountUuid:kind` → the canonical ends seen for that series. */
const knownEnds = new Map<string, number[]>()
/** Same key → the last sample written, so an unchanged reading writes nothing. */
const lastSample = new Map<string, string>()

/**
 * What makes two samples the same series.
 *
 * The account uuid is in the key, not only the account key, because `unknown` is
 * shared: two accounts that have never been active both key to it, and a single
 * `unknown:5h` series would let one account's reading dedup the other's away.
 */
function seriesKey(input: LimitSampleInput, kind: string): string {
  return `${input.accountKey}:${input.accountUuid ?? ''}:${kind}`
}

/** Drop the in-memory dedup. Tests only — production keeps it for the process's life. */
export function resetWindowSampleDedup(): void {
  knownEnds.clear()
  lastSample.clear()
}

/**
 * Record one reading's windows. Returns how many rows were actually written —
 * zero means every window was unchanged, undatable or already expired, which is
 * what a caller checks before announcing that limits moved.
 *
 * A window with no `resetsAt`, or one whose reset has already passed, is
 * SKIPPED: the canonical end is the window's identity (ADR-071 §7 keys the
 * value ledger by it), and a sample that cannot name its window would be a row
 * nothing could ever group.
 */
export function recordLimitSamples(input: LimitSampleInput): number {
  const now = input.now ?? Date.now()
  let written = 0
  for (const window of input.windows) {
    try {
      if (!window.resetsAt) continue
      const resetMs = new Date(window.resetsAt).getTime()
      if (isNaN(resetMs) || resetMs <= now) continue

      const series = seriesKey(input, window.kind)
      const ends = knownEnds.get(series) ?? []
      const canonicalEnd = canonicalizeWindowEnd(resetMs, ends)
      if (!ends.includes(canonicalEnd)) {
        ends.push(canonicalEnd)
        ends.sort((a, b) => a - b)
        if (ends.length > MAX_KNOWN_ENDS) ends.splice(0, ends.length - MAX_KNOWN_ENDS)
        knownEnds.set(series, ends)
      }

      const key = `${window.usedPercent}:${canonicalEnd}`
      if (lastSample.get(series) === key) continue // no new information

      recordWindowSample({
        id: randomUUID(),
        ts: now,
        accountUuid: input.accountUuid || input.accountKey,
        usedPercent: window.usedPercent,
        canonicalEnd,
        accountKey: input.accountKey,
        windowKind: window.kind
      })
      // Only after the row is actually in: marking the sample as written before
      // the insert would make a write lost to a locked database permanent, since
      // the next identical reading would dedup against a row that is not there.
      lastSample.set(series, key)
      written++
    } catch (err) {
      // Advisory, like every other write on this path: a failed sample must not
      // fail the reading it came from.
      logger.debug('WindowSamples', `recordWindowSample failed: ${err}`)
    }
  }
  return written
}
