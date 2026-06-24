/**
 * Per-account usage-data provider (foundation §7, Phase 7 Pass 2).
 *
 * Windows (5h utilization + reset + WLS projection) are a SUBSCRIPTION concept,
 * but populating one needs a per-account usage-data provider, and not every
 * subscription exposes one:
 *   - Claude subscription → has /api/oauth/usage (ADR-011): the ClaudeUsageProvider
 *     below wraps usageFetcher and yields the window.
 *   - apiKey / free / unknown → no provider → no window (cumulative meter only).
 *
 * This is a thin abstraction over the existing usageFetcher (which already IS the
 * Claude provider) — it formalizes the per-account/per-billingType gate without
 * changing the poll. The gate is `billingType === 'subscription'` AND a provider
 * existing for the (engine, vendor).
 */

import type { BillingType } from '../../shared/types'
import { usageFetcher } from './usage-fetcher'

/** A window observation for a subscription account. */
export interface UsageWindow {
  usedPercent: number
  resetsAt: string | null
}

/** Per-account usage-data provider. Returns null when no window is available. */
export interface UsageProvider {
  /** Resolve the current 5h window for this account, or null if none/unavailable. */
  getWindow(): UsageWindow | null
}

/** Claude provider — wraps usageFetcher's /api/oauth/usage poll (ADR-011). */
const claudeUsageProvider: UsageProvider = {
  getWindow(): UsageWindow | null {
    const usage = usageFetcher.getLastUsage()
    if (!usage || usage.error) return null
    return { usedPercent: usage.fiveHour.usedPercent, resetsAt: usage.fiveHour.resetsAt }
  }
}

/**
 * Resolve the usage provider for an (engineId, vendorId, billingType) triple.
 * Returns null when no provider exists OR the account isn't subscription-billed
 * (windows are subscription-gated). opencode/apiKey/free → null (cumulative
 * meter, no window).
 */
export function resolveUsageProvider(
  engineId: string,
  vendorId: string,
  billingType: BillingType
): UsageProvider | null {
  if (billingType !== 'subscription') return null
  // Only Claude/anthropic has a usage provider today. ChatGPT-via-opencode is
  // conceptually windowed but exposes no usage API to us yet (foundation §7).
  if (engineId === 'claude' && vendorId === 'anthropic') return claudeUsageProvider
  return null
}
