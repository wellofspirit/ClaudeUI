/**
 * Who does a Claude credential DIRECTORY belong to (S2e, ADR-071 §3 and §6).
 *
 * Multi-account (ADR-015) gives each account its own `.credentials.json` and
 * points cli.js at one of them. It does NOT give each account its own
 * `~/.claude.json`: that file is shared by every dir and by the terminal
 * `claude`, and cli.js rewrites its `oauthAccount` block only when it refetches
 * the profile (older than 24 h, or a missing field). So the block names
 * whichever cli.js process refetched last — which on a two-account machine is
 * routinely not the account the app is running under, and every ledger row,
 * every window sample and every limits reading keyed off it named the wrong
 * subscription.
 *
 * The credential in the dir is the only thing that cannot lie about this, and
 * `/api/oauth/profile` is what cli.js itself asks about it. This module is that
 * question, under the same refresh rules as the usage read (ADR-071 §6: a
 * refresh grant is never spent on a stored account except when a person asked
 * for it), plus the one-shot repair of the rows the old rule mis-attributed.
 *
 * The organization NAME is deliberately not fetched — cli.js reads it from a
 * second endpoint (`/api/oauth/claude_cli/roles`) and a label is not worth a
 * second request per poll. The display name comes from the account row's
 * `organization` column instead, which cli.js's own login response filled in
 * for that dir and which migration v23 leaves alone.
 */

import { anthropicAccountKey, UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import type { BillingType } from '../../shared/types'
import { authorizedOAuthGet, type ClaudeUsageError } from './claude-usage-api'
import { getMeta, repairClaudeAccountKey, setMeta } from './db'
import { logger } from './logger'
import {
  claudeAccountAttribution,
  claudeAccountLabel,
  claudeBillingTypeFromProfile,
  type AccountLogRecord
} from './usage-windows'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
/** cli.js's own timeout for this call — twice the usage read's. */
const PROFILE_TIMEOUT_MS = 10_000

/** The durable marker that says whether the one-shot re-key still has to run. */
export const CLAUDE_IDENTITY_REPAIR_KEY = 'claude_identity_repair'

const MS_PER_HOUR = 60 * 60 * 1000
/**
 * How far back `BlockUsageService.rollupUsageBucketsFromDb` rebuilds — its
 * `SCAN_WINDOW_MS`, restated because importing it would close a cycle
 * (block-usage reads the fetcher that calls this module). A bucket older than
 * this is never rebuilt, so the repair must not delete one.
 */
const ROLLUP_REACH_MS = 7 * 24 * MS_PER_HOUR

/** What a dir's own credential says about it. */
export interface ClaudeDirIdentity {
  accountUuid: string
  email: string
  organizationUuid: string
  /** From `organization.billing_type`; `unknown` when it names nothing we know. */
  billingType: BillingType
}

export type ClaudeIdentityResult =
  { identity: ClaudeDirIdentity } | { error: ClaudeUsageError; detail: string }

export interface ClaudeIdentityOptions {
  /** The `.credentials.json` whose owner is being asked about. */
  credentialsPath: string
  /** May this call spend a refresh grant? (ADR-071 §6.) */
  allowRefresh: boolean
  userAgent: string
}

/**
 * Resolves in flight, keyed by the credential file being read.
 *
 * Same reason as `claude-usage-api`'s map, and a separate one because the two
 * reads are different answers: a caller waiting on an identity must not be
 * handed a usage body. The refresh EXCHANGE itself is single-flighted across
 * both, inside `refreshClaudeToken`, which is where the single-use grant lives.
 */
const inFlight = new Map<string, Promise<ClaudeIdentityResult>>()

/**
 * Who this credential file belongs to. Never throws: every failure is a typed
 * {@link ClaudeUsageError}, and `unavailable` is the answer for a body that
 * does not carry all three of the fields an account key is built from.
 */
export function resolveClaudeDirIdentity(
  options: ClaudeIdentityOptions
): Promise<ClaudeIdentityResult> {
  const existing = inFlight.get(options.credentialsPath)
  if (existing) return existing
  const read = readIdentity(options).finally(() => {
    inFlight.delete(options.credentialsPath)
  })
  inFlight.set(options.credentialsPath, read)
  return read
}

async function readIdentity(options: ClaudeIdentityOptions): Promise<ClaudeIdentityResult> {
  const result = await authorizedOAuthGet({
    ...options,
    url: PROFILE_URL,
    label: 'profile API',
    timeoutMs: PROFILE_TIMEOUT_MS,
    // cli.js sends it, and a cached profile is exactly the failure this module
    // exists to stop.
    extraHeaders: { 'Cache-Control': 'no-cache' }
  })
  if ('error' in result) return result

  const body = result.body as {
    account?: { uuid?: unknown; email?: unknown } | null
    organization?: { uuid?: unknown; billing_type?: unknown } | null
  }
  const accountUuid = nonEmptyString(body.account?.uuid)
  const email = nonEmptyString(body.account?.email)
  const organizationUuid = nonEmptyString(body.organization?.uuid)
  // Both halves or neither, as ADR-071 §3 requires: half of
  // `anthropic:<org>:<account>` names no subscription, and a reading filed
  // under it would pool with another account's.
  if (!accountUuid || !email || !organizationUuid) {
    return { error: 'unavailable', detail: 'malformed profile' }
  }

  return {
    identity: {
      accountUuid,
      email,
      organizationUuid,
      billingType: claudeBillingTypeFromProfile(body.organization?.billing_type) ?? 'unknown'
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The `anthropic:<org>:<account>` key a resolved identity is filed under. */
export function claudeDirAccountKey(identity: ClaudeDirIdentity): string {
  return anthropicAccountKey(identity.organizationUuid, identity.accountUuid)
}

// ---------------------------------------------------------------------------
// The one-shot repair (S2e)
// ---------------------------------------------------------------------------

/** Is the re-key still owed? Cheap enough to ask on every poll. */
export function claudeIdentityRepairPending(): boolean {
  try {
    return getMeta(CLAUDE_IDENTITY_REPAIR_KEY) === 'pending'
  } catch (err) {
    logger.debug('ClaudeIdentity', `repair marker unreadable: ${err}`)
    return false
  }
}

/**
 * Settle the marker without moving anything, and say why.
 *
 * `done` either way — the marker answers "does the re-key still have to run",
 * not "did it move rows"; the reason is the log line's job. Single-account mode
 * is the main case: there is one credential file, `~/.claude.json` described it
 * correctly, and there is nothing to re-key.
 */
export function skipClaudeIdentityRepair(reason: string): void {
  try {
    if (!claudeIdentityRepairPending()) return
    setMeta(CLAUDE_IDENTITY_REPAIR_KEY, `done:${new Date().toISOString()}`)
    logger.info('ClaudeIdentity', `identity repair not needed: ${reason}`)
  } catch (err) {
    logger.debug('ClaudeIdentity', `repair marker write failed: ${err}`)
  }
}

export interface ClaudeIdentityRepairInput {
  /** The identity the ACTIVE dir's own credential just resolved to. */
  identity: ClaudeDirIdentity
  /**
   * The dir's display name (its `account` row's login-captured `organization`),
   * when there is one. It is not part of the identity because the profile
   * endpoint does not carry it — but a re-keyed row's label has to read exactly
   * like a live one's, and two subscriptions under one email differ by nothing
   * else on screen.
   */
  organizationName?: string | undefined
  /**
   * The account log's LAST record — the stale attribution every row since has
   * been written under. Null when the log is empty, which means nothing on disk
   * claims an account and there is nothing to move.
   */
  lastRecord: AccountLogRecord | null
  now?: number
}

/**
 * Re-key the Claude rows written under the stale attribution. Runs ONCE.
 *
 * WHY A TIME BOUND IS THE ONLY OPTION. Every Claude ledger row has
 * `account_id: null` — there is no dir id on a row to repair by. The account
 * log's last record is the moment the stale attribution took hold, and the
 * owner confirmed every Claude session since then ran under the ACTIVE dir. So
 * rows at or after that instant, under that stale key, belong to the dir; rows
 * before it are left exactly as they are.
 *
 * WHY IT MUST NOT RUN TWICE. After the first run the log's last record is the
 * dir itself, so a second run would find `staleKey === dirKey` and do nothing —
 * but only while the log is intact. The marker is the real guard: it is durable,
 * it is in the same database as the rows, and it does not depend on a JSONL file
 * the user could truncate.
 *
 * Advisory, like every other write on the usage path: a failure here must not
 * fail the poll that noticed it. The marker stays `pending`, and the next
 * successful resolve tries again.
 */
export function repairClaudeIdentityOnce(input: ClaudeIdentityRepairInput): void {
  try {
    if (!claudeIdentityRepairPending()) return

    const now = input.now ?? Date.now()
    const dirKey = claudeDirAccountKey(input.identity)
    const stale = input.lastRecord
      ? claudeAccountAttribution([input.lastRecord], now)
      : claudeAccountAttribution([], now)

    if (stale.accountKey === dirKey || stale.accountKey === UNKNOWN_ACCOUNT_KEY) {
      // `unknown` is the bucket EVERY unattributable row shares, across every
      // account — moving it onto one account would be a worse lie than leaving
      // it where it is.
      skipClaudeIdentityRepair(
        stale.accountKey === dirKey ? 'the log already names the active dir' : 'no stale key'
      )
      return
    }

    const since = input.lastRecord!.ts
    const bucketSinceHourUtc = Math.floor(since / MS_PER_HOUR) * MS_PER_HOUR
    const rollupFloor = Math.floor((now - ROLLUP_REACH_MS) / MS_PER_HOUR) * MS_PER_HOUR
    const counts = repairClaudeAccountKey({
      staleKey: stale.accountKey,
      accountKey: dirKey,
      accountLabel: claudeAccountLabel({
        email: input.identity.email,
        organizationName: input.organizationName
      }),
      accountUuid: input.identity.accountUuid,
      billingType: input.identity.billingType,
      since,
      bucketSinceHourUtc,
      bucketDeleteFromHourUtc: Math.max(bucketSinceHourUtc, rollupFloor)
    })

    setMeta(CLAUDE_IDENTITY_REPAIR_KEY, `done:${new Date(now).toISOString()}`)
    // The keys and the counts, never a token: this line is the only trace a
    // one-way re-key of the ledger leaves.
    logger.info(
      'ClaudeIdentity',
      `re-keyed ${stale.accountKey} → ${dirKey} since ${new Date(since).toISOString()}: ` +
        `${counts.events} event(s), ${counts.samples} sample(s), ${counts.windows} window(s) ` +
        `dropped, ${counts.buckets} bucket(s) dropped` +
        (counts.bucketsLeftBehind > 0
          ? `, ${counts.bucketsLeftBehind} bucket(s) left behind (older than the rollup's reach)`
          : '')
    )
  } catch (err) {
    logger.warn('ClaudeIdentity', `identity repair failed, will retry: ${err}`)
  }
}
