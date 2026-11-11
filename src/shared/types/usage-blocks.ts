// ---------------------------------------------------------------------------
// Block usage types (ccusage-inspired token tracking per 5hr window)
// ---------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface ModelTokenBreakdown {
  model: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
}

export interface UsageBlock {
  id: string // ISO string of floored start time
  startTime: number // epoch ms, floored to hour
  endTime: number // startTime + 5hrs
  actualEndTime: number // timestamp of last entry
  isActive: boolean
  tokens: TokenCounts
  costUsd: number
  requestCount: number
  models: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  projectedUsage: { tokens: number; costUsd: number } | null
  /** Final API usage % when this block ended (from last snapshot). Used for accurate display. */
  finalApiPercent: number | null
  /** Whether the block boundary came from an observed API window (resets_at)
   *  rather than the floorToHour fallback. */
  windowAligned?: boolean
}

/** A single point-in-time snapshot, stored every poll cycle */
export interface UsageSnapshot {
  timestamp: number // when this snapshot was taken
  apiUsagePercent: number // 5hr API usage % at this moment
  apiResetAt: string | null // when the 5hr window resets
  activeBlockId: string | null // which block is active
  /** Cumulative totals for the active block at this point in time */
  blockTokens: TokenCounts | null
  blockCostUsd: number
  blockRequestCount: number
  /** Per-model cumulative totals for the active block */
  blockModels: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  /** Projected window capacity at this snapshot (from WLS regression) */
  projectedUsage: { tokens: number; costUsd: number } | null
}

/** Entry-derived daily summary — computed from deduplicated JSONL entries. */
export interface DailySummary {
  totalTokens: number
  costUsd: number
  models: Record<string, number> // model → total tokens
  blockCount: number
  requestCount: number
}

/** Daily file format: ~/.claude/ui/usage/YYYY-MM-DD.json */
export interface DailyUsageFile {
  date: string // YYYY-MM-DD
  snapshots: UsageSnapshot[] // time-series, one per poll cycle
  /** Completed blocks that overlapped with this day */
  completedBlocks: UsageBlock[]
  /** Authoritative daily totals computed from deduplicated JSONL entries.
   *  Added to fix overlapping-block double-counting — once persisted, this
   *  is used instead of summing completedBlocks. */
  dailySummary?: DailySummary
}

/** Data pushed to renderer for display */
export interface BlockUsageData {
  currentBlock: UsageBlock | null
  recentBlocks: UsageBlock[] // last 48hrs of completed blocks
  /** Today's time-series snapshots for intra-block analysis */
  todaySnapshots: UsageSnapshot[]
  /** Daily aggregates for 30-day chart */
  dailyHistory: Array<{
    date: string
    totalTokens: number // sum of all 4 token types
    costUsd: number
    models: Record<string, number> // model → totalTokens
    peakApiPercent: number // highest API % seen that day
    blockCount: number // number of blocks that day
  }>
  /** Distinct account emails seen in the account log (for the filter UI) */
  accounts: string[]
  /** Active account filter (email), or null for all accounts */
  accountFilter: string | null
  /**
   * Per-engine usage breakdown over the scan window (Phase 7 Pass 2).
   * Sourced from usage_event across ALL engines — this is how opencode usage
   * surfaces in the dashboard. Absent/empty when only Claude has data.
   */
  perEngine?: EngineUsageSummary[]
}

/** Per-engine usage summary for the dashboard (Phase 7 Pass 2 / Phase 9b). */
export interface EngineUsageSummary {
  engineId: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
  /** Per-model breakdown within this engine, sorted by total tokens desc (Phase 9b). */
  models: ModelTokenBreakdown[]
}
