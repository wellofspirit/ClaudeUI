/**
 * opencode-pricing.ts — fetch, persist, and register supplemental model prices.
 *
 * Source: https://models.dev/api.json, the catalog opencode itself reads. We used
 * to read it second-hand through a transient opencode server's /config/providers,
 * but that view is zeroed for any provider the user is signed into with OAuth, so
 * a new model under a subscription came back with no price at all (ADR-071 §5).
 * Going to the source removes the server spin-up and the sign-in dependency.
 *
 * refreshPrices() fetches the catalog, converts it to PricingEntry[], persists it
 * to ~/.claude/ui/opencode-prices.json, and calls registerSupplementalPricing so
 * equivalentCostUsd resolves models the built-in table does not carry. On app
 * boot, loadPersistedPrices() registers the last-persisted file immediately and
 * refreshPricesIfStale() refreshes it in the background once a day.
 *
 * The file keeps its name so the persisted path stays put across this change.
 *
 * Cost unit: CONFIRMED USD per 1 million tokens. opencode's session.ts:442-445
 * (v1.17.9) computes cost as `Decimal(tokens.input).mul(costInfo.input).div(1_000_000)`
 * from these same numbers, so cost.* maps 1:1 to ModelPricing's *PerMTok fields.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { registerSupplementalPricing, type PricingEntry } from '../../shared/pricing'
import { writeJsonAtomic } from './write-json-atomic'
import { envFlag } from './context-window'
import { logger } from './logger'

const PRICES_FILE = path.join(os.homedir(), '.claude', 'ui', 'opencode-prices.json')

const MODELS_DEV_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 30_000
/** The catalog is ~4.7 MB. Anything near 32 MB is not the catalog. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the persisted catalog was usable the last time we touched it. Boot
 * calls loadPersistedPrices() and then refreshPricesIfStale(), in that order,
 * so a module-level flag carries "the file on disk is broken" between the two
 * without re-reading it. Without it, a truncated file's fresh mtime would read
 * as fresh and the app would run unpriced until the file aged out.
 * Starts true: nothing is known to be broken until a read says so.
 */
let persistedFileUsable = true

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build PricingEntry[] from a models.dev api.json payload:
 * `{ [providerId]: { id, name, models: { [modelId]: { cost?: {...} } } } }`.
 *
 * Nothing here throws. The payload is 222 providers of third-party data, so an
 * entry that is not the expected shape is skipped and its neighbours are kept.
 *
 * A zero list price is KEPT. On models.dev a `0` means the model is free (75
 * providers carry free tiers that way), which is the opposite of what a zero
 * meant in opencode's signed-in view — there it meant "your OAuth hides the
 * price". A free model's API-equivalent cost is a known 0, not unknown.
 *
 * `tiers`, `context_over_200k`, `reasoning` and the audio rates are ignored:
 * they need a per-turn context length and modality split the ledger does not
 * record yet, so long-context and audio turns are underpriced until it does.
 */
function buildEntries(payload: unknown): PricingEntry[] {
  const entries: PricingEntry[] = []
  if (!isRecord(payload)) return entries

  for (const [providerId, provider] of Object.entries(payload)) {
    if (!providerId || !isRecord(provider)) continue
    const models = provider.models
    if (!isRecord(models)) continue

    for (const [modelId, model] of Object.entries(models)) {
      if (!modelId || !isRecord(model)) continue
      const cost = model.cost
      if (!isRecord(cost)) continue // no pricing data for this model — skip

      const input = finiteNumber(cost.input)
      const output = finiteNumber(cost.output)
      if (input === null || output === null) continue

      // `?? input`, not `?? 0`: a cached token with no published discount is
      // billed at the input rate, and pricing it at zero understates every turn
      // on a provider that publishes no cache rates (most of OpenAI's).
      const cacheWrite = finiteNumber(cost.cache_write) ?? input
      const cacheRead = finiteNumber(cost.cache_read) ?? input

      entries.push({
        vendorId: providerId,
        // Exact modelId as the match string (lower-cased at lookup time).
        // findPricing matches supplemental entries by EXACT equality, so a
        // shorter id ("glm-4.6") never shadows a longer variant ("glm-4.6-air").
        match: modelId.toLowerCase(),
        pricing: {
          inputPerMTok: input,
          outputPerMTok: output,
          // models.dev publishes one cache-write rate; it covers both TTLs.
          cacheWritePerMTok: cacheWrite,
          cacheWrite1hPerMTok: cacheWrite,
          cacheReadPerMTok: cacheRead
        }
      })
    }
  }
  return entries
}

/**
 * Fetch and parse the catalog. Returns null for a response we decline to use (a
 * non-200, an oversized body); throws whatever fetch or JSON.parse throws, which
 * refreshPrices catches — both outcomes leave the persisted prices alone.
 */
async function fetchCatalog(): Promise<unknown | null> {
  const resp = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!resp.ok) {
    logger.warn('opencode-pricing', `models.dev returned HTTP ${resp.status}`)
    return null
  }

  const declared = Number(resp.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    logger.warn('opencode-pricing', `models.dev body declares ${declared} bytes — refusing`)
    return null
  }

  const text = await resp.text()
  const size = Buffer.byteLength(text, 'utf-8')
  if (size > MAX_BODY_BYTES) {
    logger.warn('opencode-pricing', `models.dev body is ${size} bytes — refusing`)
    return null
  }

  return JSON.parse(text)
}

/**
 * Persist for boot-time load. ~7,400 entries, so no pretty-printing.
 *
 * Atomic (temp file + rename): a torn write here is worse than no write. The
 * truncated file would carry a FRESH mtime, so loadPersistedPrices would fail
 * to parse it and refreshPricesIfStale would then call it fresh and skip the
 * refetch — a whole day with no supplemental prices. On any failure the
 * previous complete file survives untouched.
 */
function persistEntries(entries: PricingEntry[]): void {
  try {
    writeJsonAtomic(PRICES_FILE, entries, { dirMode: 0o700 })
    persistedFileUsable = true
  } catch (persistErr) {
    logger.warn('opencode-pricing', `Failed to persist prices: ${persistErr}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch fresh prices from models.dev, persist them, and register them as
 * supplemental pricing.
 *
 * Best-effort, and deliberately non-destructive: a failed fetch, a non-200, an
 * oversized body or a payload that yields no usable entry leaves both the
 * persisted file and the registered table exactly as they were, and returns
 * { count: 0 }. Good prices are better than no prices.
 */
export async function refreshPrices(): Promise<{ count: number; refreshedAt: number }> {
  const refreshedAt = Date.now()
  try {
    const payload = await fetchCatalog()
    if (payload === null) return { count: 0, refreshedAt }

    const entries = buildEntries(payload)
    if (entries.length === 0) {
      logger.warn('opencode-pricing', 'models.dev yielded no usable price entries — keeping prior')
      return { count: 0, refreshedAt }
    }

    persistEntries(entries)
    registerSupplementalPricing(entries)
    logger.info('opencode-pricing', `Registered ${entries.length} models.dev pricing entries`)
    return { count: entries.length, refreshedAt }
  } catch (err) {
    logger.warn(
      'opencode-pricing',
      `refreshPrices failed (prices optional): ${err instanceof Error ? err.message : String(err)}`
    )
    return { count: 0, refreshedAt }
  }
}

/**
 * Refresh only when the persisted catalog is missing or older than maxAgeMs.
 * Fire-and-forget at boot: never throws, never blocks.
 *
 * Skipped when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set — the catalog is
 * exactly the kind of traffic that variable is about. Note the app never sets it
 * itself (see src/core/sdk/args.ts for why); this honours whatever the user's
 * environment says. The refresh button ignores staleness and this gate both: the
 * user asked for it.
 */
export async function refreshPricesIfStale(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<void> {
  try {
    if (envFlag(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) return

    let ageMs = Number.POSITIVE_INFINITY // missing file — always stale
    try {
      // Clamped: a sub-millisecond mtime can read as "the future" against
      // Date.now(), and a negative age must not look fresher than maxAgeMs = 0.
      ageMs = Math.max(0, Date.now() - fs.statSync(PRICES_FILE).mtimeMs)
    } catch {
      /* no persisted catalog yet */
    }
    // A file we could not use is stale however new it is — see persistedFileUsable.
    if (persistedFileUsable && ageMs < maxAgeMs) return

    await refreshPrices()
  } catch (err) {
    logger.warn('opencode-pricing', `refreshPricesIfStale failed: ${err}`)
  }
}

/**
 * Load previously-persisted prices from disk and register them. Call once at app
 * boot (before any usage recalc) — no network needed for the prices we already have.
 *
 * Returns whether the file on disk can be relied on: true when entries were
 * registered or when there is simply no file yet, false when a file is there
 * but gave us nothing (unreadable, not JSON, not an entry array, empty). The
 * answer is also recorded for refreshPricesIfStale, so callers that ignore it
 * (the app's boot path does) still get the refetch.
 */
export function loadPersistedPrices(): boolean {
  persistedFileUsable = true
  try {
    if (!fs.existsSync(PRICES_FILE)) return true
    const raw = fs.readFileSync(PRICES_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as PricingEntry[]
    if (!Array.isArray(parsed) || parsed.length === 0) {
      logger.warn('opencode-pricing', 'Persisted price file holds no entries — will refetch')
      persistedFileUsable = false
      return false
    }
    registerSupplementalPricing(parsed)
    logger.info('opencode-pricing', `Loaded ${parsed.length} persisted pricing entries`)
    return true
  } catch (err) {
    logger.warn('opencode-pricing', `Failed to load persisted prices: ${err}`)
    persistedFileUsable = false
    return false
  }
}
