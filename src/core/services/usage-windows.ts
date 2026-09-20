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
export function accountForTimestamp(log: AccountLogRecord[], ts: number): string | null {
  return accountRecordForTimestamp(log, ts)?.email ?? null
}

/**
 * The whole record active at `ts`, for callers that need more than the email.
 * Same binary-search semantics as {@link accountForTimestamp}: the last record
 * at or before `ts` wins, and nothing before the first record is attributable.
 */
export function accountRecordForTimestamp(
  log: AccountLogRecord[],
  ts: number
): AccountLogRecord | null {
  let result: AccountLogRecord | null = null
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
 * ADR-011's time-based attribution, resolved into ADR-071's row columns.
 *
 * A record written before ADR-071 §3 names no organization, and half of
 * `anthropic:<org>:<account>` is not a key — two subscriptions under one
 * account uuid would collapse into it. Such a row goes in the `unknown`
 * bucket, WITHOUT a label: the bucket holds every unattributable row from
 * every account, so naming it after one of them would be a lie on screen.
 */
export function claudeAccountAttribution(
  log: AccountLogRecord[],
  ts: number
): ClaudeAccountAttribution {
  const rec = accountRecordForTimestamp(log, ts)
  if (!rec) {
    return {
      email: null,
      accountUuid: null,
      accountKey: UNKNOWN_ACCOUNT_KEY,
      accountLabel: null,
      billingType: 'unknown'
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

/** The email, with the organization name beside it when the log recorded one. */
function claudeAccountLabel(rec: AccountLogRecord): string {
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
  if (!active) return claudeAccountAttribution([], 0)
  const record: AccountLogRecord = {
    ts: 0,
    accountUuid: active.uuid,
    email: active.email,
    ...(active.organizationUuid ? { organizationUuid: active.organizationUuid } : {}),
    ...(active.organizationName ? { organizationName: active.organizationName } : {}),
    billingType:
      active.billingType !== 'unknown' ? active.billingType : (fallbackBillingType ?? 'unknown')
  }
  return claudeAccountAttribution([record], Date.now())
}
