/**
 * Internal pricing table — equivalent API cost (USD) per model.
 *
 * Resolution order:
 *   1. Built-in table (this file) — exact equivalent cost for Anthropic/OpenAI/Google models.
 *      Authoritative; supplemental entries never override these.
 *   2. Supplemental table — registered at runtime by main via registerSupplementalPricing()
 *      (opencode /config/providers prices, persisted to ~/.claude/ui/opencode-prices.json).
 *   3. Engine-reported cost (fallback/real-spend) — used by the recorder as engine_cost_usd.
 *
 * shared/ — no DB imports, no electron, no node-only APIs. Pure computation.
 */

export type VendorId = string

/** Per-model pricing in USD per million tokens. */
export interface ModelPricing {
  /** Standard input per MTok */
  inputPerMTok: number
  /** Standard output per MTok */
  outputPerMTok: number
  /** 5-minute TTL cache write (1.25× input for Anthropic) */
  cacheWritePerMTok: number
  /** 1-hour TTL cache write (2× input for Anthropic) */
  cacheWrite1hPerMTok: number
  /** Cache read per MTok */
  cacheReadPerMTok: number
}

/** A pricing entry: match string is tested with String.includes (case-insensitive). */
export interface PricingEntry {
  vendorId: VendorId
  match: string
  pricing: ModelPricing
}

/** Token counts passed to equivalentCostUsd. */
export interface TokenCostInput {
  inputTokens: number
  outputTokens: number
  /** 5-minute TTL cache write tokens */
  cacheWriteTokens: number
  /** 1-hour TTL cache write tokens */
  cacheWrite1hTokens: number
  /** Cache read tokens */
  cacheReadTokens: number
}

// ---------------------------------------------------------------------------
// Anthropic pricing (ported from block-usage.ts MODEL_PRICING)
// ---------------------------------------------------------------------------

const ANTHROPIC_PRICING: PricingEntry[] = [
  // Fable 5 / Mythos 5 — 2× Opus 4.8 ($10/$50)
  {
    vendorId: 'anthropic',
    match: 'fable',
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      cacheReadPerMTok: 1
    }
  },
  {
    vendorId: 'anthropic',
    match: 'mythos',
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      cacheReadPerMTok: 1
    }
  },
  // Opus 4.5+ (cheaper — must be matched before 'opus-4' which catches 4.0/4.1)
  {
    vendorId: 'anthropic',
    match: 'opus-4-5',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  {
    vendorId: 'anthropic',
    match: 'opus-4-6',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  {
    vendorId: 'anthropic',
    match: 'opus-4-7',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  {
    vendorId: 'anthropic',
    match: 'opus-4-8',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  // Opus 4.0 / 4.1 (older, more expensive)
  {
    vendorId: 'anthropic',
    match: 'opus-4',
    pricing: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheWritePerMTok: 18.75,
      cacheWrite1hPerMTok: 30,
      cacheReadPerMTok: 1.5
    }
  },
  // Opus fallback (assume newer pricing)
  {
    vendorId: 'anthropic',
    match: 'opus',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  // Sonnet (all versions)
  {
    vendorId: 'anthropic',
    match: 'sonnet',
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
      cacheReadPerMTok: 0.3
    }
  },
  // Haiku 4.x
  {
    vendorId: 'anthropic',
    match: 'haiku-4',
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheWritePerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
      cacheReadPerMTok: 0.1
    }
  },
  // Haiku 3.5
  {
    vendorId: 'anthropic',
    match: 'haiku-3',
    pricing: {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheWritePerMTok: 1,
      cacheWrite1hPerMTok: 1.6,
      cacheReadPerMTok: 0.08
    }
  },
  // Haiku fallback
  {
    vendorId: 'anthropic',
    match: 'haiku',
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheWritePerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
      cacheReadPerMTok: 0.1
    }
  }
]

// ---------------------------------------------------------------------------
// OpenAI pricing (best-effort, flagship models)
// Cache fields use 0.5× input for cache read; OpenAI does not have a separate
// cache-write cost (writes are billed as standard input). We set cacheWrite
// and cacheWrite1h equal to inputPerMTok as the closest equivalent.
// ---------------------------------------------------------------------------

const OPENAI_PRICING: PricingEntry[] = [
  // GPT-4o
  {
    vendorId: 'openai',
    match: 'gpt-4o-mini',
    pricing: {
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
      cacheWritePerMTok: 0.15,
      cacheWrite1hPerMTok: 0.15,
      cacheReadPerMTok: 0.075
    }
  },
  {
    vendorId: 'openai',
    match: 'gpt-4o',
    pricing: {
      inputPerMTok: 2.5,
      outputPerMTok: 10,
      cacheWritePerMTok: 2.5,
      cacheWrite1hPerMTok: 2.5,
      cacheReadPerMTok: 1.25
    }
  },
  // o3 / o4
  {
    vendorId: 'openai',
    match: 'o4-mini',
    pricing: {
      inputPerMTok: 1.1,
      outputPerMTok: 4.4,
      cacheWritePerMTok: 1.1,
      cacheWrite1hPerMTok: 1.1,
      cacheReadPerMTok: 0.275
    }
  },
  {
    vendorId: 'openai',
    match: 'o3-mini',
    pricing: {
      inputPerMTok: 1.1,
      outputPerMTok: 4.4,
      cacheWritePerMTok: 1.1,
      cacheWrite1hPerMTok: 1.1,
      cacheReadPerMTok: 0.275
    }
  },
  {
    vendorId: 'openai',
    match: 'o3',
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 40,
      cacheWritePerMTok: 10,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 2.5
    }
  },
  // GPT-4-turbo fallback
  {
    vendorId: 'openai',
    match: 'gpt-4-turbo',
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 30,
      cacheWritePerMTok: 10,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 5
    }
  },
  // GPT-4 fallback
  {
    vendorId: 'openai',
    match: 'gpt-4',
    pricing: {
      inputPerMTok: 30,
      outputPerMTok: 60,
      cacheWritePerMTok: 30,
      cacheWrite1hPerMTok: 30,
      cacheReadPerMTok: 15
    }
  },
  // GPT-3.5
  {
    vendorId: 'openai',
    match: 'gpt-3.5',
    pricing: {
      inputPerMTok: 0.5,
      outputPerMTok: 1.5,
      cacheWritePerMTok: 0.5,
      cacheWrite1hPerMTok: 0.5,
      cacheReadPerMTok: 0.25
    }
  }
]

// ---------------------------------------------------------------------------
// Google pricing (best-effort, flagship models)
// Gemini does not have formal cache-write/read costs via the API; we model
// cache fields as 0 (a conservative no-cost assumption).
// ---------------------------------------------------------------------------

const GOOGLE_PRICING: PricingEntry[] = [
  // Gemini 2.0 Flash
  {
    vendorId: 'google',
    match: 'gemini-2.0-flash',
    pricing: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.4,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0.025
    }
  },
  // Gemini 1.5 Pro
  {
    vendorId: 'google',
    match: 'gemini-1.5-pro',
    pricing: {
      inputPerMTok: 1.25,
      outputPerMTok: 5,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0.3125
    }
  },
  // Gemini 1.5 Flash
  {
    vendorId: 'google',
    match: 'gemini-1.5-flash',
    pricing: {
      inputPerMTok: 0.075,
      outputPerMTok: 0.3,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0.01875
    }
  },
  // Gemini 2.5 Pro
  {
    vendorId: 'google',
    match: 'gemini-2.5-pro',
    pricing: {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0.3125
    }
  },
  // Gemini 2.5 Flash
  {
    vendorId: 'google',
    match: 'gemini-2.5-flash',
    pricing: {
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0.0375
    }
  },
  // Gemini fallback
  {
    vendorId: 'google',
    match: 'gemini',
    pricing: {
      inputPerMTok: 1.25,
      outputPerMTok: 5,
      cacheWritePerMTok: 0,
      cacheWrite1hPerMTok: 0,
      cacheReadPerMTok: 0
    }
  }
]

// ---------------------------------------------------------------------------
// Aggregate pricing table
// ---------------------------------------------------------------------------

const PRICING_TABLE: PricingEntry[] = [
  ...ANTHROPIC_PRICING,
  ...OPENAI_PRICING,
  ...GOOGLE_PRICING
]

// ---------------------------------------------------------------------------
// Supplemental pricing (registered at runtime by main — pure; no I/O here)
// ---------------------------------------------------------------------------

/**
 * Runtime-registered supplemental entries, populated by opencode-pricing.ts
 * from the opencode /config/providers price table (models.dev data).
 * Replace-all semantics: each registerSupplementalPricing() call replaces the
 * previous batch (one source of truth per refresh).
 * Built-in PRICING_TABLE entries take precedence — supplemental is consulted
 * only when the built-in table returns null.
 */
let supplementalPricing: PricingEntry[] = []

/**
 * Register opencode-sourced (or any external) pricing entries.
 * Called by main/services/opencode-pricing.ts after fetching + persisting prices.
 * Pure: no I/O, no electron — main owns file persistence and calls this.
 *
 * Replace-all semantics: the entire supplemental batch is replaced on each call.
 * Built-in Anthropic/OpenAI/Google entries remain authoritative and are never replaced.
 */
export function registerSupplementalPricing(entries: PricingEntry[]): void {
  supplementalPricing = entries
}

/**
 * Look up ModelPricing for a (vendorId, modelId) pair.
 * Resolution order:
 *   1. Built-in PRICING_TABLE (authoritative — Anthropic/OpenAI/Google).
 *      Matched by SUBSTRING (entry.match) so a single family entry (`sonnet`)
 *      covers every dated variant (`claude-sonnet-4-6`).
 *   2. Supplemental table (opencode /config/providers prices, registered at runtime).
 *      Matched by EXACT equality — entries are full opencode model ids, so a
 *      shorter id (`claude-haiku-4-5`) must NOT shadow a longer variant
 *      (`claude-haiku-4-5-20251001`) the way substring matching would.
 *   3. Vendor-agnostic fallback — ONLY when vendorId itself is unrecognized (no
 *      entry, built-in or supplemental, is registered under it at all). This
 *      covers routing a model through a custom/gateway opencode provider (e.g. a
 *      company's internal OpenAI proxy, vendorId = the provider's own id) whose
 *      models are otherwise priced identically to a known vendor's. It does NOT
 *      run for a known vendor with an unpriced model (e.g. `openai` + a brand-new
 *      model id) — that stays a genuine miss, preserving existing vendor-scoped
 *      resolution:
 *        a. Exact modelId match across ALL supplemental entries (any vendor) —
 *           models.dev ids are specific enough that a cross-vendor exact match
 *           is safe.
 *        b. Substring match across ALL built-in tables, in PRICING_TABLE's
 *           declared order (anthropic → openai → google). If the same match
 *           string existed under multiple vendors this picks the first
 *           declared — deterministic, documented here rather than disambiguated.
 * Returns null when no entry matches (caller falls back to engine-reported cost).
 */
function findPricing(vendorId: VendorId, modelId: string): ModelPricing | null {
  const lower = modelId.toLowerCase()
  let vendorRecognized = false
  for (const entry of PRICING_TABLE) {
    if (entry.vendorId === vendorId) {
      vendorRecognized = true
      if (lower.includes(entry.match)) return entry.pricing
    }
  }
  for (const entry of supplementalPricing) {
    if (entry.vendorId === vendorId) {
      vendorRecognized = true
      if (lower === entry.match) return entry.pricing
    }
  }
  if (vendorRecognized) return null

  for (const entry of supplementalPricing) {
    if (lower === entry.match) return entry.pricing
  }
  for (const entry of PRICING_TABLE) {
    if (lower.includes(entry.match)) return entry.pricing
  }
  return null
}

/**
 * Compute equivalent API cost (USD) from token counts.
 *
 * Returns null when the (vendorId, modelId) pair is not in the internal table —
 * the caller should fall back to engine-reported cost or tokens-only display.
 *
 * The cacheWrite / cacheWrite1h split mirrors Anthropic's billing model:
 * - cacheWriteTokens: 5-minute TTL cache writes (1.25× input rate)
 * - cacheWrite1hTokens: 1-hour TTL cache writes (2× input rate); MUST be ≤ cacheWriteTokens
 *   (they are the 1h-TTL SUBSET of cacheWriteTokens, not additive). The guard below
 *   clamps automatically; callers that don't distinguish the split pass 0 for
 *   cacheWrite1hTokens and everything is billed at the 5m rate.
 *
 * For non-Anthropic vendors, cacheWrite1h is set equal to cacheWrite in the table
 * (same rate), so passing either 0 or the full amount is equivalent.
 */
export function equivalentCostUsd(
  vendorId: VendorId,
  modelId: string,
  tokens: TokenCostInput
): number | null {
  const p = findPricing(vendorId, modelId)
  if (!p) return null

  const { inputTokens, outputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens } = tokens

  // Clamp: the 1h subset cannot exceed the total cache-write tokens.
  const cache1h = Math.min(Math.max(cacheWrite1hTokens, 0), cacheWriteTokens)
  const cache5m = cacheWriteTokens - cache1h

  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok +
    (cache5m / 1_000_000) * p.cacheWritePerMTok +
    (cache1h / 1_000_000) * p.cacheWrite1hPerMTok +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerMTok
  )
}

