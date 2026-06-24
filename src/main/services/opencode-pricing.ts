/**
 * opencode-pricing.ts — fetch, persist, and register opencode provider pricing.
 *
 * Phase 9b: opencode's /config/providers endpoint vends model costs sourced from
 * models.dev (USD per 1 million tokens). refreshPrices() acquires a transient
 * opencode server, reads those costs, converts them to PricingEntry[], persists
 * them to ~/.claude/ui/opencode-prices.json, and calls registerSupplementalPricing
 * so equivalentCostUsd resolves previously-unknown opencode model costs.
 *
 * On app boot, loadPersistedPrices() reads the last-persisted file and registers it
 * immediately — no server spin-up needed until the user hits "refresh prices".
 *
 * Cost unit: CONFIRMED USD per 1 million tokens. opencode's session.ts:442-445
 * (v1.17.9) computes cost as `Decimal(tokens.input).mul(costInfo.input).div(1_000_000)`,
 * so cost.* values are per-MTok and map 1:1 to ModelPricing's *PerMTok fields — no
 * scaling needed.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { registerSupplementalPricing, type PricingEntry } from '../../shared/pricing'
import { logger } from './logger'

const PRICES_FILE = path.join(os.homedir(), '.claude', 'ui', 'opencode-prices.json')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build PricingEntry[] from a /config/providers response. */
function buildEntries(providers: import('../opencode/protocol/types').Provider[]): PricingEntry[] {
  const entries: PricingEntry[] = []
  for (const provider of providers) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const cost = model.cost
      if (!cost) continue // no pricing data for this model — skip
      // models.dev cost unit: confirmed USD per 1M tokens (opencode session.ts
      // divides by 1e6), so ModelPricing's per-MTok fields take cost.* directly.
      // cache.write maps to both 5m and 1h write rates (opencode doesn't distinguish TTLs).
      const cacheWrite = cost.cache?.write ?? 0
      entries.push({
        vendorId: provider.id,
        // Use exact modelId as the match string (lower-cased at lookup time).
        // findPricing matches supplemental entries by EXACT equality, so a shorter
        // id (e.g. "glm-4.6") never shadows a longer variant ("glm-4.6-air").
        match: modelId.toLowerCase(),
        pricing: {
          inputPerMTok: cost.input,
          outputPerMTok: cost.output,
          cacheWritePerMTok: cacheWrite,
          cacheWrite1hPerMTok: cacheWrite,
          cacheReadPerMTok: cost.cache?.read ?? 0
        }
      })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch fresh prices from opencode /config/providers, persist them, and register
 * as supplemental pricing. Best-effort — on failure logs a warning and returns
 * { count: 0, refreshedAt: Date.now() }.
 */
export async function refreshPrices(): Promise<{ count: number; refreshedAt: number }> {
  const refreshedAt = Date.now()
  try {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    let entries: PricingEntry[]
    try {
      const resp = await client.getConfigProviders()
      entries = buildEntries(resp.providers ?? [])
    } finally {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }

    // Persist for boot-time load (no server spin-up needed on restart)
    try {
      const dir = path.dirname(PRICES_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(PRICES_FILE, JSON.stringify(entries, null, 2), 'utf-8')
    } catch (persistErr) {
      logger.warn('opencode-pricing', `Failed to persist prices: ${persistErr}`)
    }

    registerSupplementalPricing(entries)
    logger.info('opencode-pricing', `Registered ${entries.length} opencode pricing entries`)
    return { count: entries.length, refreshedAt }
  } catch (err) {
    logger.warn(
      'opencode-pricing',
      `refreshPrices failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
    )
    return { count: 0, refreshedAt }
  }
}

/**
 * Load previously-persisted prices from disk and register them without spinning
 * up the opencode server. Call once at app boot (before any usage recalc).
 */
export function loadPersistedPrices(): void {
  try {
    if (!fs.existsSync(PRICES_FILE)) return
    const raw = fs.readFileSync(PRICES_FILE, 'utf-8')
    const entries = JSON.parse(raw) as PricingEntry[]
    if (!Array.isArray(entries)) return
    registerSupplementalPricing(entries)
    logger.info('opencode-pricing', `Loaded ${entries.length} persisted opencode pricing entries`)
  } catch (err) {
    logger.warn('opencode-pricing', `Failed to load persisted prices: ${err}`)
  }
}
