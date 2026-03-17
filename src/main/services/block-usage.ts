/**
 * Block Usage Service — ccusage-inspired token tracking per 5hr billing window.
 *
 * Reads JSONL transcript files from ~/.claude/projects/, groups API calls into
 * 5-hour blocks with per-model breakdowns, calculates burn rates and projections,
 * and persists time-series snapshots to ~/.claude/ui/usage/ for analytics.
 *
 * Triggered by UsageFetcher after each successful poll cycle.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import type {
  TokenCounts,
  ModelTokenBreakdown,
  UsageBlock,
  UsageSnapshot,
  DailyUsageFile,
  BlockUsageData
} from '../../shared/types'
import { ClaudeSession } from './claude-session'
import { usageFetcher } from './usage-fetcher'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const USAGE_DIR = path.join(os.homedir(), '.claude', 'ui', 'usage')
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000 // 5 hours
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // only scan entries from last 7 days
const HISTORY_DAYS = 30 // how many days to show in daily chart
const MS_PER_HOUR = 3600_000
const MS_PER_MINUTE = 60_000

// ---------------------------------------------------------------------------
// Token-based cost calculation (per million tokens)
// https://platform.claude.com/docs/en/about-claude/pricing
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

const MODEL_PRICING: Array<{ match: string; pricing: ModelPricing }> = [
  // Opus 4.5+ (cheaper — match these first before the older opus-4 variants)
  {
    match: 'opus-4-5',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 }
  },
  {
    match: 'opus-4-6',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 }
  },
  // Opus 4.0 / 4.1 (older, more expensive)
  {
    match: 'opus-4',
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 }
  },
  // Opus fallback (assume newer pricing)
  {
    match: 'opus',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 }
  },
  // Sonnet (all versions: 3.7, 4, 4.5, 4.6)
  {
    match: 'sonnet',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 }
  },
  // Haiku 4.5
  {
    match: 'haiku-4',
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 }
  },
  // Haiku 3.5
  {
    match: 'haiku-3',
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1, cacheReadPerMTok: 0.08 }
  },
  // Haiku (fallback)
  {
    match: 'haiku',
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 }
  }
]

// Default pricing (sonnet-tier) for unknown models
const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3
}

function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase()
  for (const { match, pricing } of MODEL_PRICING) {
    if (lower.includes(match)) return pricing
  }
  return DEFAULT_PRICING
}

/** Calculate cost in USD from token counts and model */
function calculateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const p = getPricing(model)
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok +
    (cacheCreationTokens / 1_000_000) * p.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerMTok
  )
}

/**
 * Normalize model names so short forms ("sonnet", "haiku", "opus") and
 * full forms ("claude-sonnet-4-6", "claude-haiku-4-5-20251001") map to
 * the same canonical key. Filters out synthetic models.
 */
function normalizeModelName(model: string): string | null {
  const lower = model.toLowerCase()
  // Filter out synthetic / invalid models
  if (lower === '<synthetic>' || lower === 'unknown' || !model) return null
  // Already a full name like "claude-opus-4-6" — return as-is
  if (lower.startsWith('claude-')) return model
  // Short name: "sonnet" → needs a full name, but we don't know the exact version.
  // Map to a canonical short form that getPricing/getModelColor can handle.
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  return model
}

/**
 * Merge model entries with the same family together.
 * e.g. "claude-sonnet-4-6" and "claude-sonnet" both become the dominant variant.
 */
function mergeModelFamilies(
  modelMap: Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>
): Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }> {
  // Group by family: opus, sonnet, haiku, other
  const families = new Map<string, string[]>() // family → model names
  for (const model of modelMap.keys()) {
    const lower = model.toLowerCase()
    let family = 'other'
    if (lower.includes('opus')) family = 'opus'
    else if (lower.includes('sonnet')) family = 'sonnet'
    else if (lower.includes('haiku')) family = 'haiku'
    const existing = families.get(family) ?? []
    existing.push(model)
    families.set(family, existing)
  }

  // For each family, merge all variants into the one with the most requests
  const merged = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
  for (const [, models] of families) {
    if (models.length === 1) {
      merged.set(models[0], modelMap.get(models[0])!)
      continue
    }
    // Pick the model with most requests as the canonical name
    let canonical = models[0]
    let maxReqs = 0
    for (const m of models) {
      const data = modelMap.get(m)!
      if (data.requestCount > maxReqs) {
        maxReqs = data.requestCount
        canonical = m
      }
    }
    // Merge all into canonical
    const mergedData = { tokens: emptyTokenCounts(), costUsd: 0, requestCount: 0 }
    for (const m of models) {
      const data = modelMap.get(m)!
      mergedData.tokens = addTokens(mergedData.tokens, data.tokens)
      mergedData.costUsd += data.costUsd
      mergedData.requestCount += data.requestCount
    }
    merged.set(canonical, mergedData)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  messageId: string // for deduplication
}

interface FileCache {
  mtime: number
  entries: ParsedEntry[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyTokenCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens
  }
}

function todayDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateStrFromTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function floorToHour(ts: number): number {
  return Math.floor(ts / MS_PER_HOUR) * MS_PER_HOUR
}

// ---------------------------------------------------------------------------
// BlockUsageService
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Projection types & constants
// ---------------------------------------------------------------------------

/** A single (tokens, apiPercent) observation for projection regression. */
interface ProjectionSample {
  timestamp: number
  tokens: number     // total local tokens at this snapshot
  apiPercent: number  // API 5hr usage % at this snapshot
}

/** Exponential decay half-life for weighting projection samples. */
const PROJECTION_HALF_LIFE_MS = 5 * MS_PER_MINUTE
/** Max samples to keep in the ring buffer (~1hr at 2-min polling). */
const MAX_PROJECTION_SAMPLES = 30
/** Minimum samples before using regression (below this, use single-point). */
const MIN_REGRESSION_SAMPLES = 3
/** Don't include samples with apiPercent below this threshold (too noisy). */
const MIN_API_PERCENT_FOR_SAMPLE = 0.5

export class BlockUsageService {
  private window: BrowserWindow | null = null
  private fileCache: Map<string, FileCache> = new Map()
  private lastData: BlockUsageData | null = null
  private previousBlockIds: Set<string> = new Set()
  private recalculating = false
  private backfillDone = false

  /** Ring buffer of (tokens, apiPercent) samples for the current active block. */
  private projectionSamples: ProjectionSample[] = []
  /** Block ID the projection samples belong to. Cleared on block change. */
  private projectionBlockId: string | null = null

  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  getData(): BlockUsageData | null {
    return this.lastData
  }

  /** Main entry point — called after each usage-fetcher poll cycle. */
  async recalculate(): Promise<BlockUsageData> {
    // Prevent concurrent recalculations
    if (this.recalculating) return this.lastData ?? this.emptyData()
    this.recalculating = true

    try {
      const entries = await this.scanAllJsonl()
      const blocks = this.groupIntoBlocks(entries)

      // Detect newly completed blocks
      const currentBlockIds = new Set(blocks.map((b) => b.id))
      const newlyCompleted: UsageBlock[] = []
      for (const b of blocks) {
        if (!b.isActive && !this.previousBlockIds.has(b.id)) {
          newlyCompleted.push(b)
        }
      }
      this.previousBlockIds = currentBlockIds

      // Build current + recent
      const now = Date.now()
      const currentBlock = blocks.find((b) => b.isActive) ?? null
      const recentBlocks = blocks.filter(
        (b) => !b.isActive && now - b.endTime < 48 * MS_PER_HOUR
      )

      // Compute projection for the active block using regression
      if (currentBlock) {
        currentBlock.projectedUsage = this.updateProjection(currentBlock, now)
      }

      // Carry the last known projection to newly completed blocks.
      // When a block was active, its projection was stored in the last snapshot
      // via the projection sample buffer. Now that it's completed, transfer it.
      // NOTE: We do NOT capture finalApiPercent here — by the time we detect
      // completion (next poll cycle), the 5hr window has rotated and the current
      // API % belongs to the NEW window. The correct finalApiPercent comes from
      // the last snapshot persisted while the block was still active.
      if (newlyCompleted.length > 0) {
        for (const b of newlyCompleted) {
          if (b.id === this.projectionBlockId && this.projectionSamples.length > 0) {
            b.projectedUsage = this.computeProjectionWLS(b)
          }
        }
      }
      // Restore projectedUsage and finalApiPercent from persisted daily data.
      // This is the primary source for finalApiPercent — it comes from the last
      // snapshot recorded while each block was still active.
      this.backfillProjections(recentBlocks)

      // Persist snapshot + completed blocks
      const snapshot = this.buildSnapshot(currentBlock)
      const todaySnapshots = await this.persistSnapshot(snapshot, newlyCompleted)

      // On first run, backfill daily summaries for days beyond the 7-day scan
      // window. This is async and doesn't block the current recalculation.
      if (!this.backfillDone) {
        this.backfillDone = true
        this.backfillHistoricalSummaries().catch((err) =>
          logger.error('BlockUsage', 'Historical backfill failed', err)
        )
      }

      // Load 30-day history. Pass scanned entries so recent days are computed
      // directly from deduplicated JSONL (authoritative), not from persisted
      // completedBlocks which may contain overlapping re-grouped blocks.
      const dailyHistory = await this.loadDailyHistory(HISTORY_DAYS, entries)

      const data: BlockUsageData = {
        currentBlock,
        recentBlocks,
        todaySnapshots,
        dailyHistory
      }

      this.lastData = data
      this.pushToRenderer(data)
      return data
    } catch (err) {
      logger.error('BlockUsage', 'Recalculation failed', err)
      return this.lastData ?? this.emptyData()
    } finally {
      this.recalculating = false
    }
  }

  // -------------------------------------------------------------------------
  // Projection — Weighted Least Squares Regression
  // -------------------------------------------------------------------------

  /**
   * Add a new sample to the projection buffer and compute the projected
   * window capacity using weighted least squares regression.
   *
   * Model:   tokens = k × apiPercent   (proportional, through origin)
   * Solve:   k = Σ(wᵢ·tᵢ·pᵢ) / Σ(wᵢ·pᵢ²)   (weighted least squares)
   * Result:  projectedMax = k × 100
   *
   * Weights use exponential decay (half-life 5 min) so recent observations
   * dominate while older ones still smooth out noise. When fewer than 3
   * samples exist, falls back to the single most recent point.
   */
  private updateProjection(
    block: UsageBlock,
    now: number
  ): UsageBlock['projectedUsage'] {
    const apiUsage = usageFetcher.getLastUsage()
    if (!apiUsage || apiUsage.error) return null

    const apiPercent = apiUsage.fiveHour.usedPercent
    const apiAge = now - apiUsage.fetchedAt
    const currentTok = totalTokens(block.tokens)

    // Don't add a sample if API data is stale or values are too small
    if (apiAge > 5 * MS_PER_MINUTE) return this.computeProjectionWLS(block)
    if (apiPercent < MIN_API_PERCENT_FOR_SAMPLE || currentTok <= 0) return null

    // Reset buffer if the active block changed (new window)
    if (block.id !== this.projectionBlockId) {
      this.projectionSamples = []
      this.projectionBlockId = block.id
    }

    // Deduplicate: skip if the latest sample has the same tokens AND percent
    // (no new information since last poll)
    const last = this.projectionSamples[this.projectionSamples.length - 1]
    if (!last || last.tokens !== currentTok || last.apiPercent !== apiPercent) {
      this.projectionSamples.push({
        timestamp: now,
        tokens: currentTok,
        apiPercent
      })
    }

    // Cap ring buffer
    if (this.projectionSamples.length > MAX_PROJECTION_SAMPLES) {
      this.projectionSamples = this.projectionSamples.slice(-MAX_PROJECTION_SAMPLES)
    }

    return this.computeProjectionWLS(block)
  }

  /**
   * Compute the projection from the sample buffer using WLS regression.
   * Falls back to single-point estimate when not enough samples exist.
   */
  private computeProjectionWLS(block: UsageBlock): UsageBlock['projectedUsage'] {
    const samples = this.projectionSamples
    if (samples.length === 0) return null

    const now = Date.now()
    const currentTok = totalTokens(block.tokens)
    if (currentTok <= 0) return null

    // Compute cost-per-token ratio from current block (always fresh)
    const costPerToken = block.costUsd / currentTok

    // ---- Single-point fallback ----
    if (samples.length < MIN_REGRESSION_SAMPLES) {
      const latest = samples[samples.length - 1]
      if (latest.apiPercent <= 0) return null
      const maxTokens = latest.tokens / (latest.apiPercent / 100)
      return {
        tokens: Math.round(maxTokens),
        costUsd: Math.round(maxTokens * costPerToken * 100) / 100
      }
    }

    // ---- Weighted Least Squares: tokens = k × percent ----
    // k = Σ(wᵢ · tᵢ · pᵢ) / Σ(wᵢ · pᵢ²)
    let sumWTP = 0 // weighted tokens × percent
    let sumWPP = 0 // weighted percent²

    for (const s of samples) {
      if (s.apiPercent <= 0) continue
      const age = now - s.timestamp
      const w = Math.exp((-age * Math.LN2) / PROJECTION_HALF_LIFE_MS)
      sumWTP += w * s.tokens * s.apiPercent
      sumWPP += w * s.apiPercent * s.apiPercent
    }

    if (sumWPP === 0) return null

    const k = sumWTP / sumWPP // tokens per percent-point
    const maxTokens = k * 100

    // Sanity check: projection should be >= current tokens
    if (maxTokens < currentTok) return null

    return {
      tokens: Math.round(maxTokens),
      costUsd: Math.round(maxTokens * costPerToken * 100) / 100
    }
  }

  /**
   * Backfill projectedUsage on recent (completed) blocks from persisted daily
   * data. Three strategies, in priority order:
   *
   * 1. Stored projection on completedBlocks in the daily file (best — exact WLS
   *    result captured when the block was active).
   * 2. Stored projection on snapshots (same as above, per-poll granularity).
   * 3. Retroactive WLS computation from historical snapshot (apiPercent,
   *    blockTokens) pairs. This works even for old daily files that predate
   *    the projectedUsage field.
   *
   * Note: matching uses time-range overlap rather than exact block ID, because
   * the ID can differ between when the block was active (API-aligned start)
   * and when it's reconstructed now (floorToHour for past windows).
   */
  private backfillProjections(recentBlocks: UsageBlock[]): void {
    // Blocks are rebuilt from JSONL each recalculate(), so metadata like
    // projectedUsage and finalApiPercent need to be restored from persisted
    // daily files. For blocks that completed while the app was running,
    // these are set directly in recalculate() — this backfill handles
    // blocks from previous sessions or before finalApiPercent existed.
    const needsProjection = recentBlocks.filter((b) => !b.projectedUsage)
    const needsApiPercent = recentBlocks.filter((b) => b.finalApiPercent == null)
    if (needsProjection.length === 0 && needsApiPercent.length === 0) return

    // All blocks that still need something filled
    const needsFill = recentBlocks.filter(
      (b) => !b.projectedUsage || b.finalApiPercent == null
    )

    const findBlockForTimestamp = (ts: number): UsageBlock | undefined => {
      return needsFill.find((b) => ts >= b.startTime && ts <= b.endTime)
    }

    const findBlockById = (id: string): UsageBlock | undefined => {
      return needsFill.find((b) => b.id === id)
    }

    // Track the last (most recent) apiPercent seen per block (for legacy fallback)
    const lastApiPercent = new Map<string, number>()

    // Collect snapshot pairs per block for retroactive WLS (strategy 3)
    const blockSnapPairs = new Map<
      string,
      Array<{ tokens: number; apiPercent: number; timestamp: number }>
    >()

    // Scan the last 3 days of daily files (oldest first so later snapshots
    // overwrite earlier ones — we want the most recent data for each block)
    const now = Date.now()
    for (let i = 2; i >= 0; i--) {
      const date = dateStrFromTimestamp(now - i * 24 * MS_PER_HOUR)
      const filePath = path.join(USAGE_DIR, `${date}.json`)
      try {
        if (!fs.existsSync(filePath)) continue
        const daily = JSON.parse(
          fs.readFileSync(filePath, 'utf-8')
        ) as DailyUsageFile

        // Strategy 1: restore metadata from stored completedBlocks
        for (const cb of daily.completedBlocks) {
          const block = findBlockById(cb.id) ?? findBlockForTimestamp(cb.startTime)
          if (!block) continue
          if (!block.projectedUsage && cb.projectedUsage) {
            block.projectedUsage = cb.projectedUsage
          }
          if (block.finalApiPercent == null && cb.finalApiPercent != null) {
            block.finalApiPercent = cb.finalApiPercent
          }
        }

        // Scan snapshots for projection fill (strategy 2+3) and legacy apiPercent
        for (const snap of daily.snapshots) {
          if (!snap.activeBlockId) continue

          const block =
            findBlockById(snap.activeBlockId) ??
            findBlockForTimestamp(snap.timestamp)
          if (!block) continue

          // Strategy 2: use the LAST snapshot's projection (overwrite, not first-wins)
          if (!block.projectedUsage && snap.projectedUsage) {
            block.projectedUsage = snap.projectedUsage
          } else if (snap.projectedUsage) {
            // Overwrite with later (more accurate) projection
            block.projectedUsage = snap.projectedUsage
          }

          // Strategy 3: collect (apiPercent, blockTokens) pairs for later WLS
          if (snap.blockTokens && snap.apiUsagePercent >= MIN_API_PERCENT_FOR_SAMPLE) {
            const tok = totalTokens(snap.blockTokens)
            if (tok > 0) {
              let pairs = blockSnapPairs.get(block.id)
              if (!pairs) {
                pairs = []
                blockSnapPairs.set(block.id, pairs)
              }
              pairs.push({
                tokens: tok,
                apiPercent: snap.apiUsagePercent,
                timestamp: snap.timestamp
              })
            }
          }

          // Track last apiPercent for legacy blocks missing finalApiPercent
          if (block.finalApiPercent == null && snap.apiUsagePercent > 0) {
            lastApiPercent.set(block.id, snap.apiUsagePercent)
          }
        }
      } catch {
        // Skip corrupt files
      }
    }

    // Apply finalApiPercent from snapshots (legacy fallback for blocks
    // that were persisted before finalApiPercent existed)
    for (const block of needsApiPercent) {
      if (block.finalApiPercent != null) continue // already filled by strategy 1
      const pct = lastApiPercent.get(block.id)
      if (pct != null) {
        block.finalApiPercent = pct
      }
    }

    // Sanity-check projections: if projectedUsage.tokens < actual, discard it
    // (can happen when a stale snapshot's projection was stored early in the block)
    for (const block of needsProjection) {
      if (block.projectedUsage) {
        const blockTok = totalTokens(block.tokens)
        if (block.projectedUsage.tokens < blockTok) {
          block.projectedUsage = null // discard bad projection, let strategy 3 try
        }
      }
    }

    // Strategy 3: retroactive WLS for blocks still without a projection
    for (const [blockId, pairs] of blockSnapPairs) {
      const block = needsProjection.find((b) => b.id === blockId)
      if (!block || block.projectedUsage) continue // already filled
      if (pairs.length === 0) continue

      const blockTok = totalTokens(block.tokens)
      if (blockTok <= 0) continue
      const costPerToken = block.costUsd / blockTok

      if (pairs.length < MIN_REGRESSION_SAMPLES) {
        // Single-point fallback using the last pair
        const last = pairs[pairs.length - 1]
        if (last.apiPercent > 0) {
          const maxTokens = last.tokens / (last.apiPercent / 100)
          if (maxTokens >= blockTok) {
            block.projectedUsage = {
              tokens: Math.round(maxTokens),
              costUsd: Math.round(maxTokens * costPerToken * 100) / 100
            }
          }
        }
        continue
      }

      // WLS: tokens = k × percent, weighted by recency within the block
      const lastTs = pairs[pairs.length - 1].timestamp
      let sumWTP = 0
      let sumWPP = 0
      for (const s of pairs) {
        if (s.apiPercent <= 0) continue
        const age = lastTs - s.timestamp
        const w = Math.exp((-age * Math.LN2) / PROJECTION_HALF_LIFE_MS)
        sumWTP += w * s.tokens * s.apiPercent
        sumWPP += w * s.apiPercent * s.apiPercent
      }

      if (sumWPP === 0) continue
      const k = sumWTP / sumWPP
      const maxTokens = k * 100

      if (maxTokens >= blockTok) {
        block.projectedUsage = {
          tokens: Math.round(maxTokens),
          costUsd: Math.round(maxTokens * costPerToken * 100) / 100
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // JSONL Scanning
  // -------------------------------------------------------------------------

  /**
   * Recursively collect all .jsonl files under a directory.
   * Structure: ~/.claude/projects/<projectKey>/<sessionId>.jsonl
   *            ~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-*.jsonl
   */
  private collectJsonlFiles(dir: string): string[] {
    const results: string[] = []
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          results.push(...this.collectJsonlFiles(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath)
        }
      }
    } catch {
      // Skip inaccessible directories
    }
    return results
  }

  private async scanAllJsonl(): Promise<ParsedEntry[]> {
    const cutoff = Date.now() - SCAN_WINDOW_MS

    // Recursively find all .jsonl files (including subagent files)
    const jsonlFiles = this.collectJsonlFiles(CLAUDE_PROJECTS_DIR)

    const allEntries: ParsedEntry[] = []
    const seenIds = new Set<string>()

    for (const filePath of jsonlFiles) {
      // Check mtime for cache validity
      let mtime: number
      try {
        mtime = fs.statSync(filePath).mtimeMs
      } catch {
        continue
      }

      // Skip files not modified within scan window (rough heuristic)
      if (mtime < cutoff) continue

      // Use cached entries if file hasn't changed
      const cached = this.fileCache.get(filePath)
      let entries: ParsedEntry[]
      if (cached && cached.mtime === mtime) {
        entries = cached.entries
      } else {
        entries = await this.parseJsonlFile(filePath, cutoff)
        this.fileCache.set(filePath, { mtime, entries })
      }

      // Deduplicate across files
      for (const entry of entries) {
        if (entry.timestamp < cutoff) continue
        if (entry.messageId && seenIds.has(entry.messageId)) continue
        if (entry.messageId) seenIds.add(entry.messageId)
        allEntries.push(entry)
      }
    }

    // Sort chronologically
    allEntries.sort((a, b) => a.timestamp - b.timestamp)
    return allEntries
  }

  private parseJsonlFile(filePath: string, cutoff: number): Promise<ParsedEntry[]> {
    return new Promise((resolve) => {
      const entries: ParsedEntry[] = []

      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: stream })

      rl.on('line', (line) => {
        try {
          const data = JSON.parse(line)

          if (data.type === 'result') {
            // Result entries contain cost but no per-message tokens; skip for now
            return
          }

          if (data.type !== 'assistant' || !data.message?.usage) return

          const timestamp = data.timestamp
            ? new Date(data.timestamp as string).getTime()
            : 0

          if (!timestamp || timestamp < cutoff) return

          const usage = data.message.usage
          const rawModel = (data.message.model as string) || 'unknown'
          const model = normalizeModelName(rawModel)
          if (!model) return // Skip synthetic / invalid models

          const messageId = (data.message.id as string) || ''
          const inTok = (usage.input_tokens as number) || 0
          const outTok = (usage.output_tokens as number) || 0
          const cacheCreate = (usage.cache_creation_input_tokens as number) || 0
          const cacheRead = (usage.cache_read_input_tokens as number) || 0

          // Calculate cost from tokens using model pricing (not from JSONL costUSD)
          const costUsd = calculateCostFromTokens(model, inTok, outTok, cacheCreate, cacheRead)

          entries.push({
            timestamp,
            model,
            inputTokens: inTok,
            outputTokens: outTok,
            cacheCreationTokens: cacheCreate,
            cacheReadTokens: cacheRead,
            costUsd,
            messageId
          })
        } catch {
          // Skip malformed lines
        }
      })

      rl.on('close', () => resolve(entries))
      rl.on('error', () => resolve(entries))
    })
  }

  // -------------------------------------------------------------------------
  // Block Grouping (ccusage algorithm)
  // -------------------------------------------------------------------------

  private groupIntoBlocks(entries: ParsedEntry[]): UsageBlock[] {
    if (entries.length === 0) return []

    // Derive authoritative API window boundaries from resets_at when available.
    // The API tells us exactly when the current 5hr window ends, so we can
    // back-calculate the precise start instead of guessing with floorToHour().
    const apiUsage = usageFetcher.getLastUsage()
    const apiResetAt = apiUsage?.fiveHour.resetsAt
    let apiWindowStart: number | null = null
    let apiWindowEnd: number | null = null
    if (apiResetAt) {
      const resetMs = new Date(apiResetAt).getTime()
      if (!isNaN(resetMs)) {
        // Round to the nearest second to eliminate sub-second jitter in the
        // API's resets_at value. Without this, each poll gets a slightly
        // different millisecond, producing dozens of unique block IDs for
        // the same 5-hour window — breaking snapshot-to-block matching.
        const resetRounded = Math.round(resetMs / 1000) * 1000
        apiWindowEnd = resetRounded
        apiWindowStart = resetRounded - SESSION_DURATION_MS
      }
    }

    /** Return the authoritative block start for a given timestamp. */
    const blockStartFor = (ts: number): number => {
      if (
        apiWindowStart !== null &&
        apiWindowEnd !== null &&
        ts >= apiWindowStart &&
        ts < apiWindowEnd
      ) {
        return apiWindowStart
      }
      return floorToHour(ts)
    }

    const blocks: UsageBlock[] = []
    let blockEntries: ParsedEntry[] = []
    let blockStart = 0

    for (const entry of entries) {
      if (blockEntries.length === 0) {
        // Start a new block
        blockStart = blockStartFor(entry.timestamp)
        blockEntries = [entry]
        continue
      }

      const idealStart = blockStartFor(entry.timestamp)
      const timeSinceBlockStart = entry.timestamp - blockStart
      const lastEntry = blockEntries[blockEntries.length - 1]
      const timeSinceLastEntry = entry.timestamp - lastEntry.timestamp

      // Start a new block when:
      // 1. Entry exceeds 5hr from block start or last entry (existing gap logic), OR
      // 2. Entry falls inside the API window but the current block isn't API-aligned
      //    (the API boundary is authoritative and must be respected)
      const apiWindowMismatch =
        idealStart !== blockStart &&
        apiWindowStart !== null &&
        idealStart === apiWindowStart

      if (
        timeSinceBlockStart > SESSION_DURATION_MS ||
        timeSinceLastEntry > SESSION_DURATION_MS ||
        apiWindowMismatch
      ) {
        // Close current block and start new one
        blocks.push(this.buildBlock(blockEntries, blockStart))
        blockStart = idealStart
        blockEntries = [entry]
      } else {
        blockEntries.push(entry)
      }
    }

    // Close final block
    if (blockEntries.length > 0) {
      blocks.push(this.buildBlock(blockEntries, blockStart))
    }

    // Clamp isActive = false for blocks that precede the current API window.
    // When the API rolls to a new 5hr window, old blocks may still have
    // endTime > now (due to floorToHour misalignment), but the API boundary
    // is authoritative — those blocks are no longer active.
    if (apiWindowStart !== null) {
      for (const block of blocks) {
        if (block.isActive && block.startTime < apiWindowStart) {
          block.isActive = false
        }
      }
    }

    return blocks
  }

  private buildBlock(entries: ParsedEntry[], blockStart: number): UsageBlock {
    const now = Date.now()
    const endTime = blockStart + SESSION_DURATION_MS
    const actualEndTime = entries[entries.length - 1].timestamp

    // Aggregate totals
    const tokens = emptyTokenCounts()
    let costUsd = 0
    const modelMap = new Map<
      string,
      { tokens: TokenCounts; costUsd: number; requestCount: number }
    >()

    for (const entry of entries) {
      tokens.inputTokens += entry.inputTokens
      tokens.outputTokens += entry.outputTokens
      tokens.cacheCreationTokens += entry.cacheCreationTokens
      tokens.cacheReadTokens += entry.cacheReadTokens
      costUsd += entry.costUsd

      const existing = modelMap.get(entry.model)
      if (existing) {
        existing.tokens = addTokens(existing.tokens, {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          cacheReadTokens: entry.cacheReadTokens
        })
        existing.costUsd += entry.costUsd
        existing.requestCount += 1
      } else {
        modelMap.set(entry.model, {
          tokens: {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheCreationTokens: entry.cacheCreationTokens,
            cacheReadTokens: entry.cacheReadTokens
          },
          costUsd: entry.costUsd,
          requestCount: 1
        })
      }
    }

    // Merge model families (e.g. "sonnet" + "claude-sonnet-4-6" → canonical name)
    const mergedMap = mergeModelFamilies(modelMap)
    const models: ModelTokenBreakdown[] = Array.from(mergedMap.entries()).map(
      ([model, data]) => ({
        model,
        tokens: data.tokens,
        costUsd: data.costUsd,
        requestCount: data.requestCount
      })
    )

    // Determine if active
    const isActive = now < endTime && now - actualEndTime < SESSION_DURATION_MS

    // Burn rate (only meaningful if duration > 0)
    let burnRate: UsageBlock['burnRate'] = null
    const durationMs = actualEndTime - entries[0].timestamp
    if (durationMs > 0) {
      const durationMin = durationMs / MS_PER_MINUTE
      const tok = totalTokens(tokens)
      burnRate = {
        tokensPerMin: Math.round(tok / durationMin),
        costPerHour: Math.round((costUsd / durationMin) * 60 * 100) / 100
      }
    }

    // Projection is computed in recalculate() using regression over multiple
    // samples — not here in buildBlock() which only sees a single point.
    const projectedUsage: UsageBlock['projectedUsage'] = null

    return {
      id: new Date(blockStart).toISOString(),
      startTime: blockStart,
      endTime,
      actualEndTime,
      isActive,
      tokens,
      costUsd: Math.round(costUsd * 10000) / 10000,
      requestCount: entries.length,
      models,
      burnRate,
      projectedUsage,
      finalApiPercent: null
    }
  }

  // -------------------------------------------------------------------------
  // Time-Series Persistence
  // -------------------------------------------------------------------------

  private buildSnapshot(currentBlock: UsageBlock | null): UsageSnapshot {
    const apiUsage = usageFetcher.getLastUsage()
    return {
      timestamp: Date.now(),
      apiUsagePercent: apiUsage?.fiveHour.usedPercent ?? 0,
      apiResetAt: apiUsage?.fiveHour.resetsAt ?? null,
      activeBlockId: currentBlock?.id ?? null,
      blockTokens: currentBlock?.tokens ?? null,
      blockCostUsd: currentBlock?.costUsd ?? 0,
      blockRequestCount: currentBlock?.requestCount ?? 0,
      blockModels: currentBlock?.models ?? [],
      burnRate: currentBlock?.burnRate ?? null,
      projectedUsage: currentBlock?.projectedUsage ?? null
    }
  }

  private async persistSnapshot(
    snapshot: UsageSnapshot,
    newlyCompleted: UsageBlock[]
  ): Promise<UsageSnapshot[]> {
    const today = todayDateStr()
    const filePath = path.join(USAGE_DIR, `${today}.json`)

    // Load existing daily file
    let daily: DailyUsageFile
    try {
      if (fs.existsSync(filePath)) {
        daily = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyUsageFile
      } else {
        daily = { date: today, snapshots: [], completedBlocks: [] }
      }
    } catch {
      daily = { date: today, snapshots: [], completedBlocks: [] }
    }

    // Append snapshot
    daily.snapshots.push(snapshot)

    // Add newly completed blocks, routing each to the correct day's file.
    // On app restart, previousBlockIds is empty, so ALL completed blocks from
    // the 7-day scan window appear as "newly completed" — we must attribute
    // each to its actual day (by actualEndTime), not dump them all into today.
    const existingIds = new Set(daily.completedBlocks.map((b) => b.id))
    const otherDayBlocks = new Map<string, UsageBlock[]>() // date → blocks
    for (const block of newlyCompleted) {
      const blockDay = dateStrFromTimestamp(block.actualEndTime)
      if (blockDay === today) {
        if (!existingIds.has(block.id)) {
          daily.completedBlocks.push(block)
        }
      } else {
        // Route to the correct day's file
        let arr = otherDayBlocks.get(blockDay)
        if (!arr) {
          arr = []
          otherDayBlocks.set(blockDay, arr)
        }
        arr.push(block)
      }
    }

    // Write today's file
    try {
      if (!fs.existsSync(USAGE_DIR)) {
        fs.mkdirSync(USAGE_DIR, { recursive: true })
      }
      fs.writeFileSync(filePath, JSON.stringify(daily), { mode: 0o600 })
    } catch (err) {
      logger.error('BlockUsage', 'Failed to persist daily file', err)
    }

    // Persist blocks that belong to other days into their respective files
    for (const [otherDate, blocks] of otherDayBlocks) {
      try {
        const otherPath = path.join(USAGE_DIR, `${otherDate}.json`)
        let otherDaily: DailyUsageFile
        if (fs.existsSync(otherPath)) {
          otherDaily = JSON.parse(fs.readFileSync(otherPath, 'utf-8')) as DailyUsageFile
        } else {
          otherDaily = { date: otherDate, snapshots: [], completedBlocks: [] }
        }
        const otherIds = new Set(otherDaily.completedBlocks.map((b) => b.id))
        for (const block of blocks) {
          if (!otherIds.has(block.id)) {
            otherDaily.completedBlocks.push(block)
          }
        }
        fs.writeFileSync(otherPath, JSON.stringify(otherDaily), { mode: 0o600 })
      } catch (err) {
        logger.error('BlockUsage', `Failed to persist blocks to ${otherDate}`, err)
      }
    }

    return daily.snapshots
  }

  /**
   * Build daily usage history for the chart.
   *
   * For days covered by the JSONL scan window (last 7 days), totals are
   * computed directly from deduplicated entries — this is authoritative and
   * immune to the overlapping-blocks problem where app restarts re-group
   * the same entries into differently-aligned blocks.
   *
   * For older days (beyond the JSONL window), we fall back to persisted
   * daily summaries stored in `dailySummary` (entry-derived, not block-derived).
   * Legacy daily files that only have `completedBlocks` are skipped for cost
   * aggregation since those blocks may overlap and double-count.
   */
  private async loadDailyHistory(
    _days: number,
    entries: ParsedEntry[]
  ): Promise<BlockUsageData['dailyHistory']> {

    // Phase 1: Compute daily totals from JSONL entries (authoritative).
    // Entries are already deduplicated by messageId in scanAllJsonl().
    const entryBuckets = new Map<
      string,
      { tokens: number; cost: number; models: Record<string, number>; requestCount: number }
    >()

    for (const entry of entries) {
      const day = dateStrFromTimestamp(entry.timestamp)
      let bucket = entryBuckets.get(day)
      if (!bucket) {
        bucket = { tokens: 0, cost: 0, models: {}, requestCount: 0 }
        entryBuckets.set(day, bucket)
      }
      const tok =
        entry.inputTokens + entry.outputTokens +
        entry.cacheCreationTokens + entry.cacheReadTokens
      bucket.tokens += tok
      bucket.cost += entry.costUsd
      bucket.requestCount += 1

      const normalized = normalizeModelName(entry.model)
      if (normalized) {
        bucket.models[normalized] = (bucket.models[normalized] || 0) + tok
      }
    }

    // Merge model families in entry buckets (same logic as block building)
    for (const bucket of entryBuckets.values()) {
      const modelMap = new Map<string, number>()
      for (const [model, tok] of Object.entries(bucket.models)) {
        const lower = model.toLowerCase()
        let family = model
        if (lower.includes('opus')) family = 'opus'
        else if (lower.includes('sonnet')) family = 'sonnet'
        else if (lower.includes('haiku')) family = 'haiku'
        modelMap.set(family, (modelMap.get(family) || 0) + tok)
      }
      // Resolve family keys back to the most specific model name
      const resolved: Record<string, number> = {}
      for (const [family, tok] of modelMap) {
        // Find the original model name that contributed most tokens
        let bestModel = family
        let bestTok = 0
        for (const [model, mTok] of Object.entries(bucket.models)) {
          const lower = model.toLowerCase()
          const mFamily =
            lower.includes('opus') ? 'opus' :
            lower.includes('sonnet') ? 'sonnet' :
            lower.includes('haiku') ? 'haiku' : model
          if (mFamily === family && mTok > bestTok) {
            bestModel = model
            bestTok = mTok
          }
        }
        resolved[bestModel] = tok
      }
      bucket.models = resolved
    }

    // Phase 2: Load ALL daily files for peak API % and older-day summaries.
    // Scan the usage directory directly to find all available files, not just
    // the last N days — backfilled data may go back further.
    const dailyFiles = new Map<string, DailyUsageFile>()
    try {
      if (fs.existsSync(USAGE_DIR)) {
        const files = fs.readdirSync(USAGE_DIR)
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const date = file.replace('.json', '')
          try {
            dailyFiles.set(
              date,
              JSON.parse(
                fs.readFileSync(path.join(USAGE_DIR, file), 'utf-8')
              ) as DailyUsageFile
            )
          } catch {
            // Skip corrupt files
          }
        }
      }
    } catch {
      // Usage dir may not exist yet
    }

    // Phase 2b: Persist entry-derived summaries so correct data survives past
    // the JSONL scan window. Only write today's each poll; older days once.
    const todayStr = todayDateStr()
    for (const [date, bucket] of entryBuckets) {
      if (date === todayStr) {
        this.persistDailySummary(date, bucket)
      } else if (!dailyFiles.get(date)?.dailySummary) {
        this.persistDailySummary(date, bucket)
      }
    }

    // Phase 3: Build history array from all available dates.
    // Collect all dates that have either entry data or a daily file.
    const allDates = new Set<string>([...entryBuckets.keys(), ...dailyFiles.keys()])
    const history: BlockUsageData['dailyHistory'] = []

    for (const date of [...allDates].sort()) {
      const entryBucket = entryBuckets.get(date)
      const daily = dailyFiles.get(date)

      let dayTokens = 0
      let dayCost = 0
      let dayModels: Record<string, number> = {}
      let blockCount = 0

      if (entryBucket) {
        // Use authoritative entry-derived data
        dayTokens = entryBucket.tokens
        dayCost = entryBucket.cost
        dayModels = entryBucket.models
        blockCount = 0 // not meaningful for entry-based aggregation
      } else if (daily?.dailySummary) {
        // Fall back to persisted entry-derived summary (for days past JSONL window)
        dayTokens = daily.dailySummary.totalTokens
        dayCost = daily.dailySummary.costUsd
        dayModels = daily.dailySummary.models
        blockCount = daily.dailySummary.blockCount ?? 0
      }

      if (dayTokens === 0 && dayCost === 0) continue

      // Peak API % from snapshots
      let peakApi = 0
      if (daily) {
        for (const snap of daily.snapshots) {
          if (snap.apiUsagePercent > peakApi) peakApi = snap.apiUsagePercent
        }
      }

      history.push({
        date,
        totalTokens: dayTokens,
        costUsd: Math.round(dayCost * 100) / 100,
        models: dayModels,
        peakApiPercent: peakApi,
        blockCount
      })
    }

    return history
  }

  /**
   * Persist an entry-derived daily summary into the daily file.
   * This is stored alongside (not replacing) completedBlocks/snapshots,
   * so older code paths aren't broken. Once the JSONL ages past the scan
   * window, this summary becomes the authoritative source.
   */
  private persistDailySummary(
    date: string,
    bucket: { tokens: number; cost: number; models: Record<string, number>; requestCount: number }
  ): void {
    const filePath = path.join(USAGE_DIR, `${date}.json`)
    try {
      let daily: DailyUsageFile
      if (fs.existsSync(filePath)) {
        daily = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyUsageFile
      } else {
        daily = { date, snapshots: [], completedBlocks: [] }
      }
      // Always overwrite with latest computation (entries may have grown)
      daily.dailySummary = {
        totalTokens: bucket.tokens,
        costUsd: Math.round(bucket.cost * 100) / 100,
        models: bucket.models,
        blockCount: 0,
        requestCount: bucket.requestCount
      }
      if (!fs.existsSync(USAGE_DIR)) {
        fs.mkdirSync(USAGE_DIR, { recursive: true })
      }
      fs.writeFileSync(filePath, JSON.stringify(daily), { mode: 0o600 })
    } catch (err) {
      logger.error('BlockUsage', `Failed to persist daily summary for ${date}`, err)
    }
  }

  // -------------------------------------------------------------------------
  // Historical Backfill
  // -------------------------------------------------------------------------

  /**
   * One-time scan of JSONL files beyond the normal 7-day window to compute
   * and persist `dailySummary` for days that don't have one yet.
   *
   * Runs asynchronously on first recalculate() — doesn't block the UI.
   * Once summaries are persisted, subsequent app sessions skip the backfill
   * (the daily files already have `dailySummary`).
   */
  private async backfillHistoricalSummaries(): Promise<void> {
    const now = Date.now()
    const normalCutoff = now - SCAN_WINDOW_MS

    // Scan ALL available JSONL files (no cutoff — grab everything)
    const entries = await this.scanJsonlWithCutoff(0)
    if (entries.length === 0) return

    // Group entries older than the normal 7-day window by day
    const dayBuckets = new Map<
      string,
      { tokens: number; cost: number; models: Record<string, number>; requestCount: number }
    >()
    for (const entry of entries) {
      // Skip entries in the normal scan window (already handled by recalculate)
      if (entry.timestamp >= normalCutoff) continue

      const day = dateStrFromTimestamp(entry.timestamp)
      let bucket = dayBuckets.get(day)
      if (!bucket) {
        bucket = { tokens: 0, cost: 0, models: {}, requestCount: 0 }
        dayBuckets.set(day, bucket)
      }
      const tok =
        entry.inputTokens + entry.outputTokens +
        entry.cacheCreationTokens + entry.cacheReadTokens
      bucket.tokens += tok
      bucket.cost += entry.costUsd
      bucket.requestCount += 1

      const normalized = normalizeModelName(entry.model)
      if (normalized) {
        bucket.models[normalized] = (bucket.models[normalized] || 0) + tok
      }
    }

    if (dayBuckets.size === 0) return

    // Check which days already have a dailySummary (skip those)
    let backfilled = 0
    for (const [date, bucket] of dayBuckets) {
      const filePath = path.join(USAGE_DIR, `${date}.json`)
      try {
        if (fs.existsSync(filePath)) {
          const daily = JSON.parse(
            fs.readFileSync(filePath, 'utf-8')
          ) as DailyUsageFile
          if (daily.dailySummary) continue // already has correct summary
        }
      } catch {
        // File corrupt or missing — will be created by persistDailySummary
      }
      this.persistDailySummary(date, bucket)
      backfilled++
    }

    logger.info(
      'BlockUsage',
      `Backfilled daily summaries for ${backfilled} days (${dayBuckets.size} total with data)`
    )

    // Trigger a re-render so the chart updates with the backfilled data
    if (backfilled > 0 && this.lastData) {
      const entries7d = await this.scanAllJsonl()
      const dailyHistory = await this.loadDailyHistory(HISTORY_DAYS, entries7d)
      this.lastData = { ...this.lastData, dailyHistory }
      this.pushToRenderer(this.lastData)
    }
  }

  /**
   * Scan JSONL files with a custom cutoff (used by backfill for wider window).
   * Reuses the same parsing logic and file cache as scanAllJsonl.
   */
  private async scanJsonlWithCutoff(cutoff: number): Promise<ParsedEntry[]> {
    const jsonlFiles = this.collectJsonlFiles(CLAUDE_PROJECTS_DIR)
    const allEntries: ParsedEntry[] = []
    const seenIds = new Set<string>()

    for (const filePath of jsonlFiles) {
      let mtime: number
      try {
        mtime = fs.statSync(filePath).mtimeMs
      } catch {
        continue
      }
      if (mtime < cutoff) continue

      const cached = this.fileCache.get(filePath)
      let entries: ParsedEntry[]
      if (cached && cached.mtime === mtime) {
        entries = cached.entries
      } else {
        entries = await this.parseJsonlFile(filePath, cutoff)
        this.fileCache.set(filePath, { mtime, entries })
      }

      for (const entry of entries) {
        if (entry.timestamp < cutoff) continue
        if (entry.messageId && seenIds.has(entry.messageId)) continue
        if (entry.messageId) seenIds.add(entry.messageId)
        allEntries.push(entry)
      }
    }

    allEntries.sort((a, b) => a.timestamp - b.timestamp)
    return allEntries
  }

  // -------------------------------------------------------------------------
  // Renderer Push
  // -------------------------------------------------------------------------

  private pushToRenderer(data: BlockUsageData): void {
    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('usage:block-data', data)
      }
      for (const w of ClaudeSession.getExtraWindows()) {
        if (!w.isDestroyed()) w.webContents.send('usage:block-data', data)
      }
    } catch {
      // Window may have been closed
    }
  }

  private emptyData(): BlockUsageData {
    return {
      currentBlock: null,
      recentBlocks: [],
      todaySnapshots: [],
      dailyHistory: []
    }
  }
}

/** Singleton instance */
export const blockUsageService = new BlockUsageService()
