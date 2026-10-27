/**
 * The OpenRouter tab's wire shapes (Usage Analytics › OpenRouter).
 *
 * Everything here is what the HOST chose to pass on from OpenRouter's read-only
 * API — mapped field by field, never a spread response — so nothing the
 * dashboard has no use for (the key creator's user id, workspace ids) reaches a
 * renderer or a remote client. The API key itself never appears in any of
 * these: the host reads it from the vault per request and keeps it there.
 */

/** Spend in USD over OpenRouter's own windows (UTC days, weeks and months). */
export interface OpenRouterSpendWindows {
  dailyUsd: number
  weeklyUsd: number
  monthlyUsd: number
  totalUsd: number
}

/** `GET /key` — the key the vault holds. */
export interface OpenRouterKeyInfo {
  /** OpenRouter's own label for the key: its name, or the key masked as its console shows it. */
  label: string
  /** null = the key has no spend limit. */
  limitUsd: number | null
  limitRemainingUsd: number | null
  /** null for a lifetime limit, or an interval this build does not know. */
  limitReset: 'daily' | 'weekly' | 'monthly' | null
  /** When the current limit window ends (ISO 8601), when the limit resets at all. */
  resetsAt: string | null
  includeByokInLimit: boolean
  usage: OpenRouterSpendWindows
  byokUsage: OpenRouterSpendWindows
  isFreeTier: boolean
  expiresAt: string | null
  dataRegions: string[]
  /** Requests to `:free` models today; null when OpenRouter did not report them. */
  freeModelRequests: { used: number; limit: number; remaining: number } | null
}

export interface OpenRouterOverview {
  fetchedAt: number
  /** `/key` failing fails the whole read: without it there is no tab to draw. */
  key: OpenRouterKeyInfo
  /** `GET /credits` — account-wide, across every key. null when that read failed. */
  credits: { totalUsd: number; usedUsd: number } | null
  /** Models the account's provider and privacy settings allow, of the whole catalog. */
  models: { available: number | null; total: number | null }
  /**
   * What ClaudeUI's own ledger recorded on THIS key since `sinceUtc` (the start
   * of the current UTC month, OpenRouter's monthly reset), over every machine
   * the usage hub knows. null when the ledger could not be read.
   */
  ledger: { sinceUtc: string; costUsd: number; machines: number } | null
  /** Which optional parts failed, and why: `{ credits: 'OpenRouter is unavailable' }`. */
  partialErrors: Record<string, string>
}

export type OpenRouterModelScope = 'user' | 'all'

export interface OpenRouterModelRow {
  id: string
  name: string
  contextLength: number | null
  /** USD per million tokens. */
  promptPerM: number | null
  completionPerM: number | null
  cacheReadPerM: number | null
  inputModalities: string[]
  reasoning: boolean
  /** Artificial Analysis indices from `/benchmarks`, null when the model has none. */
  intelligenceIndex: number | null
  codingIndex: number | null
}

/** One provider serving a model (`/models/{author}/{slug}/endpoints`). */
export interface OpenRouterEndpointRow {
  provider: string
  tag: string
  quantization: string | null
  promptPerM: number | null
  completionPerM: number | null
  contextLength: number | null
  /** OpenRouter's health code: 0 is normal, below 0 degraded. */
  status: number
  /** Percent. */
  uptime1d: number | null
  uptime30m: number | null
  latencyP50Ms: number | null
  /** Tokens per second. */
  throughputP50: number | null
}
