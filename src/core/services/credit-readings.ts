/**
 * The one publisher of credit readings — what the hub relays for a credits plan
 * (ADR-072 §4, amended 2026-10-01).
 *
 * A ChatGPT business workspace reports no rate windows, so `window-samples`,
 * which the hub client listens to for everything else it relays, never hears of
 * it. Its credits and the member's monthly allowance travel as ONE reading per
 * account instead: never sampled, never a window, and the hub keeps only the
 * latest. The ChatGPT store publishes each account's MERGED current state here;
 * the hub client queues the newest per account and pushes it with the limits.
 *
 * `observedAt` is the instant the credits were READ, which the caller states:
 * for ChatGPT the last full `account/rateLimits/read`, never the instant a live
 * turn's push arrived, because a push carries the allowance Codex copied forward
 * from that read (`ChatgptRateLimitStore.creditsReadAt`). The hub keeps the
 * newest per account, so a reading dated later than it was taken would
 * overwrite another machine's genuinely newer one.
 *
 * A reading identical to the last one published — same content, same instant —
 * is not published again. Every live turn re-records the account, so without
 * that one read would be queued over and over; a NEW read is a new instant and
 * always goes, which is also what keeps the relay's age honest.
 */

import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { logger } from './logger'

export interface CreditReadingCredits {
  unlimited: boolean
  /** The vendor's own text, usually WITHHELD from a workspace member. */
  balance: string | null
}

export interface CreditReadingAllowance {
  used: number
  limit: number
  /** 0-100, what is LEFT, as the vendor states it. */
  remainingPercent: number
  resetsAt: string | null
}

/** One account's credits as the hub takes them (`HubCreditReading`). */
export interface CreditReadingWritten {
  accountKey: string
  accountLabel: string | null
  vendorId: string
  plan: string | null
  credits: CreditReadingCredits | null
  allowance: CreditReadingAllowance | null
  observedAt: number
}

type CreditReadingListener = (reading: CreditReadingWritten) => void

const listeners = new Set<CreditReadingListener>()

/** account key → what was last published, its instant included. */
const lastPublished = new Map<string, string>()

/** Be told about every credit reading worth relaying. Returns the unsubscribe. */
export function onCreditReading(listener: CreditReadingListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Drop every subscriber and the dedup. Tests only. */
export function resetCreditReadings(): void {
  listeners.clear()
  lastPublished.clear()
}

/**
 * Publish one account's credits. Returns whether anything was published: not
 * for the shared `unknown` key (ADR-071 §3, never an account), not for a reading
 * with nothing to say, and not for one that repeats the last exactly.
 */
export function publishCreditReading(reading: CreditReadingWritten): boolean {
  if (!reading.accountKey || reading.accountKey === UNKNOWN_ACCOUNT_KEY) return false
  if (reading.credits === null && reading.allowance === null) return false

  const content = JSON.stringify([
    reading.accountLabel,
    reading.vendorId,
    reading.plan,
    reading.credits,
    reading.allowance,
    reading.observedAt
  ])
  if (lastPublished.get(reading.accountKey) === content) return false
  lastPublished.set(reading.accountKey, content)

  for (const listener of listeners) {
    try {
      listener(reading)
    } catch (err) {
      // One subscriber failing must not keep the reading from the others.
      logger.warn('CreditReadings', `listener failed: ${err}`)
    }
  }
  return true
}
