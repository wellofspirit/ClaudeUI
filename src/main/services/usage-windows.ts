/**
 * Pure helpers for 5h API window canonicalization and account attribution.
 * Kept free of electron / service imports so unit tests can import directly.
 */

const MS_PER_MINUTE = 60_000

/** Tolerance for treating two observed resets_at values as the same window. */
export const WINDOW_SNAP_TOLERANCE_MS = 2 * MS_PER_MINUTE

/**
 * Canonicalize an observed resets_at timestamp against known window ends.
 *
 * The /api/oauth/usage `resets_at` carries jitter (e.g. 09:00:00.578Z vs
 * 09:00:00.000Z across polls) and is NOT hour-aligned in general
 * (03:40:00Z windows have been observed). Round to the minute to kill
 * sub-second jitter, then snap to an already-known window end within the
 * tolerance so one real window never registers as several (first-seen wins).
 */
export function canonicalizeWindowEnd(resetMs: number, knownEnds: number[]): number {
  const rounded = Math.round(resetMs / MS_PER_MINUTE) * MS_PER_MINUTE
  for (const end of knownEnds) {
    if (Math.abs(end - rounded) <= WINDOW_SNAP_TOLERANCE_MS) return end
  }
  return rounded
}

/** One record in account-log.jsonl — the account active from `ts` onward. */
export interface AccountLogRecord {
  ts: number
  accountUuid: string
  email: string
}

/**
 * Resolve which account was active at `ts` from the (ts-ascending) log.
 * Timestamps before the first record are unattributable → null.
 */
export function accountForTimestamp(log: AccountLogRecord[], ts: number): string | null {
  let result: string | null = null
  for (const rec of log) {
    if (rec.ts > ts) break
    result = rec.email
  }
  return result
}
