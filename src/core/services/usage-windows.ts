/**
 * Pure helpers for 5h API window canonicalization and account attribution.
 * Kept free of electron / service imports so unit tests can import directly.
 */

import {
  anthropicAccountKey,
  UNKNOWN_ACCOUNT_KEY,
  type AccountIdentity
} from '../../shared/account-key'
import type { BillingType } from '../../shared/types'

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

/**
 * One record in account-log.jsonl — the account active from `ts` onward.
 *
 * The three fields below the first two arrived with ADR-071 §3; every record
 * written before it has only `ts`, `accountUuid` and `email`, and stays
 * readable. Absent is not "none": a row resolved to such a record gets
 * {@link UNKNOWN_ACCOUNT_KEY}, never a key built from half the pair.
 */
export interface AccountLogRecord {
  ts: number
  accountUuid: string
  email: string
  /** The subscription half of `anthropic:<org>:<account>` (ADR-071 §3). */
  organizationUuid?: string
  /** Display only — what tells two subscriptions under one email apart. */
  organizationName?: string
  /** How the account was billed when the record was written. */
  billingType?: BillingType
  /**
   * The account key OUTRIGHT, for an account whose key is not built from the
   * uuid pair: a Claude API key, whose identity is a digest of the key itself
   * (S2f). Present only on those records; an OAuth one still derives its key
   * from `organizationUuid` + `accountUuid`.
   */
  accountKey?: string
  /** Never set on a real record — the discriminant of {@link AccountLogMarker}. */
  unresolved?: undefined
}

/**
 * A MARKER line in account-log.jsonl: at `ts` the active credential folder
 * moved and the app could not read whose it is (S2g).
 *
 * It names no account on purpose. The folder changed, so every turn after `ts`
 * ran on the new credential — and the previous record, which names the OLD
 * subscription, must not be allowed to claim those turns. A row whose timestamp
 * falls under a marker is DEFERRED (see {@link claudeAccountAttribution}): not
 * written at all until the identity resolves and the real record lands at this
 * same instant. The owner's rule is that no row is ever re-keyed after it is
 * written, so a row that cannot be keyed yet waits — but only for
 * {@link DEFERRAL_MAX_MS}, after which it is written as `unknown` rather than
 * lost.
 *
 * `email` is the empty string rather than absent because every reader of the
 * log validates that field before accepting a line. The record fields are
 * declared as `undefined` so a marker and a record can be read out of one array
 * without a cast, and so the shape says outright that it carries none of them.
 */
export interface AccountLogMarker {
  ts: number
  email: string
  unresolved: true
  accountUuid?: undefined
  organizationUuid?: undefined
  organizationName?: undefined
  billingType?: undefined
  accountKey?: undefined
}

/** Anything a line of account-log.jsonl can be. */
export type AccountLogEntry = AccountLogRecord | AccountLogMarker

/** Is this entry S2g's "the folder moved and we cannot say whose it is"? */
export function isUnresolvedMarker(entry: AccountLogEntry): entry is AccountLogMarker {
  return entry.unresolved === true
}

/**
 * The `oauthAccount.billingType` values cli.js itself treats as a subscription
 * (its own set, read out of the pinned bundle 2.1.268). Anything outside this
 * set and outside `usage_based` is a value we have not seen, so it resolves to
 * nothing rather than to a guess — see {@link claudeBillingTypeFromProfile}.
 */
const CLAUDE_SUBSCRIPTION_BILLING_TYPES = new Set([
  'stripe_subscription',
  'stripe_subscription_contracted',
  'stripe_subscription_enterprise_self_serve',
  'aws_marketplace',
  'c4e_consumption_trial',
  'apple_subscription',
  'google_play_subscription'
])

/**
 * Map `~/.claude.json`'s `oauthAccount.billingType` onto our vocabulary, or
 * null when the value says nothing we understand.
 *
 * `usage_based` is Anthropic's pay-per-token billing on an OAuth account — real
 * money per turn, which is what `apiKey` means to the cost rule, so it maps
 * there rather than to `subscription`. Null (not `'unknown'`) is the miss, so a
 * caller can fall back to another signal before settling for unknown.
 */
export function claudeBillingTypeFromProfile(value: unknown): BillingType | null {
  if (typeof value !== 'string' || !value) return null
  if (CLAUDE_SUBSCRIPTION_BILLING_TYPES.has(value)) return 'subscription'
  if (value === 'usage_based') return 'apiKey'
  return null
}

/**
 * Resolve which account was active at `ts` from the (ts-ascending) log.
 * Timestamps before the first record are unattributable → null.
 */
export function accountForTimestamp(log: AccountLogEntry[], ts: number): string | null {
  const entry = accountRecordForTimestamp(log, ts)
  // A marker names no account, so a timestamp under one is as unattributable as
  // one before the log's first record. Callers that must not WRITE such a row
  // go through {@link claudeAccountAttribution}, which says "deferred" instead.
  if (!entry || isUnresolvedMarker(entry)) return null
  return entry.email
}

/**
 * The whole entry active at `ts`, for callers that need more than the email.
 *
 * A forward scan of a ts-ascending log, stopping at the first entry after `ts`:
 * the last entry at or before `ts` wins, and nothing before the first one is
 * attributable. Of two entries with the SAME `ts` the later line wins, which is
 * how S2g's real record supersedes the marker it closes. Linear, and
 * deliberately so — the log holds one line per account SWITCH, so it is tens of
 * entries on a machine years old.
 */
export function accountRecordForTimestamp(
  log: AccountLogEntry[],
  ts: number
): AccountLogEntry | null {
  let result: AccountLogEntry | null = null
  for (const rec of log) {
    if (rec.ts > ts) break
    result = rec
  }
  return result
}

/** What a Claude usage row stores about the account it is attributed to. */
export interface ClaudeAccountAttribution extends AccountIdentity {
  /** The account's email at that time — what the usage view's filter matches on. */
  email: string | null
  accountUuid: string | null
  billingType: BillingType
}

/**
 * The third answer {@link claudeAccountAttribution} can give: this timestamp
 * falls under an {@link AccountLogMarker}, so the account that ran the turn is
 * not knowable YET and the row must not be written.
 *
 * A sentinel rather than an `unknown` attribution, and a union rather than a
 * flag, so a writer cannot reach the row builder without deciding what to do
 * about it — writing the row as `unknown` and re-keying it later is exactly
 * what the owner ruled out (ADR-072's hub reads the ledger as append-only).
 */
export const ATTRIBUTION_DEFERRED = 'deferred'

export type ClaudeAttributionResult = ClaudeAccountAttribution | typeof ATTRIBUTION_DEFERRED

/**
 * How long a marker may hold rows back before they are written as `unknown`
 * (orchestrator ruling, 2026-09-21; the number is pending the owner's word).
 *
 * IN PRACTICE A DEFERRAL LASTS SECONDS TO MINUTES: the retry loop re-reads the
 * identity at 5 s, 15 s and 60 s, and the usual recovery is cli.js rewriting
 * the credential on the user's next turn. This bound is not that story. It is
 * here so that no row can be held back FOR EVER by a fault nobody anticipated,
 * and so that an abandoned gap ends — a folder switched away from before its
 * identity resolved is never revisited, and its rows would otherwise sit unread
 * until they aged out of the transcript scan window and were lost.
 *
 * Past the bound the row is written to the `unknown` account. That is a FIRST
 * write, not a re-key, so the append-only rule ADR-072's hub relies on still
 * holds; such a row shows locally under the unknown account and never reaches
 * the hub. If the identity resolves after the bound, the real record still
 * lands at the marker's instant and the rows still unwritten are keyed to it —
 * only the ones already written as `unknown` stay `unknown`.
 */
export const DEFERRAL_MAX_MS = 24 * 60 * 60 * 1000

/** The `unknown` bucket: a turn whose account nothing on disk can name. */
export function unattributedClaude(): ClaudeAccountAttribution {
  return {
    email: null,
    accountUuid: null,
    accountKey: UNKNOWN_ACCOUNT_KEY,
    accountLabel: null,
    billingType: 'unknown'
  }
}

/**
 * ADR-011's time-based attribution, resolved into ADR-071's row columns.
 *
 * A record written before ADR-071 §3 names no organization, and half of
 * `anthropic:<org>:<account>` is not a key — two subscriptions under one
 * account uuid would collapse into it. Such a row goes in the `unknown`
 * bucket, WITHOUT a label: the bucket holds every unattributable row from
 * every account, so naming it after one of them would be a lie on screen.
 *
 * {@link ATTRIBUTION_DEFERRED} is the answer under a marker (S2g), for as long
 * as {@link DEFERRAL_MAX_MS} allows. `now` is a parameter so a caller — and a
 * test — can ask the question at a definite instant.
 */
export function claudeAccountAttribution(
  log: AccountLogEntry[],
  ts: number,
  now: number = Date.now()
): ClaudeAttributionResult {
  const rec = accountRecordForTimestamp(log, ts)
  if (!rec) return unattributedClaude()
  if (isUnresolvedMarker(rec)) {
    // The bound is on the MARKER's age, not the row's: everything under one
    // marker becomes writable at the same moment, so an hour of the ledger
    // cannot be half deferred and half `unknown` for ever.
    return now - rec.ts < DEFERRAL_MAX_MS ? ATTRIBUTION_DEFERRED : unattributedClaude()
  }
  return claudeAttributionFromRecord(rec)
}

/**
 * One log record as row columns — the answer for a caller that already HOLDS a
 * record, so there is no marker to fall under and no deferred answer to handle.
 * Shared with the live path below and with S2e's one-shot repair.
 */
export function claudeAttributionFromRecord(rec: AccountLogRecord): ClaudeAccountAttribution {
  // A record that states its key outright (an API-key account) is taken at its
  // word: there is no pair to derive one from, and its email IS the label —
  // `<vendor> key …abcd`, which is already the display form.
  if (rec.accountKey) {
    return {
      email: rec.email,
      accountUuid: rec.accountUuid,
      accountKey: rec.accountKey,
      accountLabel: rec.email,
      billingType: rec.billingType ?? 'unknown'
    }
  }
  // Both halves or neither: the log reader only validates `ts` and `email`, so
  // a truncated line could otherwise mint `anthropic:<org>:undefined` — a key
  // that would travel to ADR-072's hub as if it named something.
  const org = rec.organizationUuid && rec.accountUuid ? rec.organizationUuid : undefined
  return {
    email: rec.email,
    accountUuid: rec.accountUuid,
    accountKey: org ? anthropicAccountKey(org, rec.accountUuid) : UNKNOWN_ACCOUNT_KEY,
    accountLabel: org ? claudeAccountLabel(rec) : null,
    billingType: rec.billingType ?? 'unknown'
  }
}

/**
 * The email, with the organization name beside it when one is known.
 *
 * Exported because a row's label is written in more than one place and they
 * must agree: the live attribution above, and S2e's one-shot re-key, which
 * rewrites `account_label` on rows that were attributed to the wrong account.
 * A structural parameter rather than an `AccountLogRecord`, so a caller that
 * has the two fields but no log record can use it.
 */
export function claudeAccountLabel(rec: {
  email: string
  organizationName?: string | undefined
}): string {
  return rec.organizationName ? `${rec.email} (${rec.organizationName})` : rec.email
}

/**
 * The account fields {@link activeClaudeAttribution} needs — `UsageFetcher`'s
 * `ActiveAccount`, structurally, so this module stays free of service imports.
 */
export interface ActiveClaudeAccount {
  uuid: string
  email: string
  organizationUuid?: string
  organizationName?: string
  /** Set only for an account keyed by its API key rather than by a uuid pair. */
  accountKey?: string
  billingType: BillingType
}

/**
 * Attribute a turn or a reading to the account that is active RIGHT NOW.
 *
 * {@link claudeAccountAttribution} answers "which account was active at `ts`"
 * from the log; this answers "which account is active" from the live read of
 * `~/.claude.json`, by running that same rule over a one-record log. Same rule,
 * so a row written live and a row attributed by time cannot disagree about the
 * key, the label or the billing type.
 *
 * `fallbackBillingType` is the caller's second signal for an account whose
 * profile named no billing type — `ClaudeAuthProvider`'s probe cache, which the
 * host exposes and which may have filled in since the account was read. It is a
 * parameter rather than a lookup so this file keeps importing nothing.
 *
 * NOTE (S3a): the cross-engine dispatcher's `claudeDispatchAccount()` still
 * holds an inline copy of this, because that file is being changed in a
 * concurrent slice. It switches to this helper when the two land.
 */
export function activeClaudeAttribution(
  active: ActiveClaudeAccount | null,
  fallbackBillingType?: BillingType | null
): ClaudeAccountAttribution {
  if (!active) return unattributedClaude()
  // Never deferred: the caller HAS the account, so there is no marker to fall
  // under — which is why this returns the attribution outright.
  return claudeAttributionFromRecord({
    ts: 0,
    accountUuid: active.uuid,
    email: active.email,
    ...(active.organizationUuid ? { organizationUuid: active.organizationUuid } : {}),
    ...(active.organizationName ? { organizationName: active.organizationName } : {}),
    ...(active.accountKey ? { accountKey: active.accountKey } : {}),
    billingType:
      active.billingType !== 'unknown' ? active.billingType : (fallbackBillingType ?? 'unknown')
  })
}
