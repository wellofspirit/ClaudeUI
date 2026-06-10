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
import { watch, type FSWatcher } from 'node:fs'
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
import {
  canonicalizeWindowEnd,
  accountForTimestamp,
  type AccountLogRecord
} from './usage-windows'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const USAGE_DIR = path.join(os.homedir(), '.claude', 'ui', 'usage')
const ACCOUNT_LOG_PATH = path.join(USAGE_DIR, 'account-log.jsonl')
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000 // 5 hours
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // only scan entries from last 7 days
const MS_PER_HOUR = 3600_000
const MS_PER_MINUTE = 60_000
const RECALC_DEBOUNCE_MS = 30_000 // 30 seconds — debounce after file change events

/** Grace for attaching entries that slightly precede a window's derived start. */
const WINDOW_START_GRACE_MS = 30 * MS_PER_MINUTE

/** A 5h rate-limit window observed via resets_at. */
interface ApiWindow {
  start: number // end - 5h
  end: number // canonical (minute-rounded, snap-deduped)
  /** Account email active when this window was observed (null = unknown/seeded). */
  account: string | null
}

// ---------------------------------------------------------------------------
// Token-based cost calculation (per million tokens)
// https://platform.claude.com/docs/en/about-claude/pricing
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  /** 5-minute TTL cache write rate (1.25× input) */
  cacheWritePerMTok: number
  /** 1-hour TTL cache write rate (2× input) */
  cacheWrite1hPerMTok: number
  cacheReadPerMTok: number
}

const MODEL_PRICING: Array<{ match: string; pricing: ModelPricing }> = [
  // Fable 5 / Mythos 5 — 2× Opus 4.8 ($10/$50)
  {
    match: 'fable',
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 }
  },
  {
    match: 'mythos',
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 }
  },
  // Opus 4.5+ (cheaper — match these first before the older opus-4 variants)
  {
    match: 'opus-4-5',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 }
  },
  {
    match: 'opus-4-6',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 }
  },
  {
    match: 'opus-4-7',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 }
  },
  {
    match: 'opus-4-8',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 }
  },
  // Opus 4.0 / 4.1 (older, more expensive)
  {
    match: 'opus-4',
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheWrite1hPerMTok: 30, cacheReadPerMTok: 1.5 }
  },
  // Opus fallback (assume newer pricing)
  {
    match: 'opus',
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 }
  },
  // Sonnet (all versions: 3.7, 4, 4.5, 4.6)
  {
    match: 'sonnet',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 }
  },
  // Haiku 4.5
  {
    match: 'haiku-4',
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 }
  },
  // Haiku 3.5
  {
    match: 'haiku-3',
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1, cacheWrite1hPerMTok: 1.6, cacheReadPerMTok: 0.08 }
  },
  // Haiku (fallback)
  {
    match: 'haiku',
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 }
  }
]

// Default pricing (sonnet-tier) for unknown models
const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3
}

function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase()
  for (const { match, pricing } of MODEL_PRICING) {
    if (lower.includes(match)) return pricing
  }
  return DEFAULT_PRICING
}

/**
 * Calculate cost in USD from token counts and model.
 *
 * `cacheCreation1hTokens` is the subset of `cacheCreationTokens` written with
 * the 1-hour TTL (billed at 2× input vs 1.25× for the 5-minute TTL). When the
 * JSONL usage lacks the `cache_creation` breakdown, pass 0 — everything is
 * billed at the 5m rate, matching the pre-split behavior.
 */
function calculateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheCreation1hTokens: number,
  cacheReadTokens: number
): number {
  const p = getPricing(model)
  // Clamp: the 1h subset can never exceed the total (guards malformed usage)
  const cache1h = Math.min(Math.max(cacheCreation1hTokens, 0), cacheCreationTokens)
  const cache5m = cacheCreationTokens - cache1h
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok +
    (cache5m / 1_000_000) * p.cacheWritePerMTok +
    (cache1h / 1_000_000) * p.cacheWrite1hPerMTok +
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
 * A generic model name has no version digits after the family.
 * e.g. "claude-opus", "claude-sonnet" are generic; "claude-opus-4-6" is specific.
 */
function isGenericModelName(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)$/i.test(model)
}

/**
 * Merge generic model names (e.g. "claude-sonnet") into their specific versioned
 * counterparts (e.g. "claude-sonnet-4-6"), but keep distinct versions separate.
 *
 * Generic names appear when the SDK uses short forms in JSONL entries. They should
 * be folded into the specific variant with the most requests. Distinct versioned
 * models (e.g. "claude-opus-4-5" vs "claude-opus-4-6") are kept separate because
 * they have different pricing and the user should see the breakdown.
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

  const merged = new Map<string, { tokens: TokenCounts; costUsd: number; requestCount: number }>()
  for (const [, models] of families) {
    if (models.length === 1) {
      merged.set(models[0], modelMap.get(models[0])!)
      continue
    }

    // Split into generic ("claude-sonnet") and specific ("claude-sonnet-4-6")
    const generic = models.filter(isGenericModelName)
    const specific = models.filter((m) => !isGenericModelName(m))

    // Keep each specific version as its own entry
    for (const m of specific) {
      merged.set(m, { ...modelMap.get(m)! })
    }

    // Merge generic counts into the most-requested specific variant,
    // or keep the generic entry if there are no specific variants.
    if (generic.length > 0) {
      // Sum all generic entries
      const genericData = { tokens: emptyTokenCounts(), costUsd: 0, requestCount: 0 }
      for (const m of generic) {
        const data = modelMap.get(m)!
        genericData.tokens = addTokens(genericData.tokens, data.tokens)
        genericData.costUsd += data.costUsd
        genericData.requestCount += data.requestCount
      }

      if (specific.length > 0) {
        // Find the specific variant with the most requests and merge generic into it
        let target = specific[0]
        let maxReqs = 0
        for (const m of specific) {
          const data = merged.get(m)!
          if (data.requestCount > maxReqs) {
            maxReqs = data.requestCount
            target = m
          }
        }
        const existing = merged.get(target)!
        existing.tokens = addTokens(existing.tokens, genericData.tokens)
        existing.costUsd += genericData.costUsd
        existing.requestCount += genericData.requestCount
      } else {
        // Only generic entries — keep as-is
        merged.set(generic[0], genericData)
      }
    }
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
  /** Whether the initial full scan has completed. */
  private initialScanDone = false
  /** Cached merged entries from all JSONL files (populated after first full scan). */
  private cachedEntries: ParsedEntry[] = []
  /** Set of message IDs already in cachedEntries (for dedup). */
  private cachedMessageIds: Set<string> = new Set()

  /** File system watcher for the projects directory. */
  private watcher: FSWatcher | null = null
  /** Debounce timer for recalculation after file changes. */
  private recalcDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /** Configurable debounce interval (ms) — set via settings. */
  private recalcDebounceMs: number = RECALC_DEBOUNCE_MS
  /** Set of file paths that changed since last recalculation. */
  private changedFiles: Set<string> = new Set()

  /** Ring buffer of (tokens, apiPercent) samples for the current active block. */
  private projectionSamples: ProjectionSample[] = []
  /** Canonical window end the projection samples belong to. Cleared on window change. */
  private projectionWindowEnd: number | null = null

  /** Known 5h API windows, sorted by end ascending. */
  private knownWindows: ApiWindow[] = []
  /** Whether known windows were seeded from persisted daily snapshots. */
  private windowSeedDone = false

  /** Account filter for the usage view (email, null = all accounts). */
  private accountFilter: string | null = null
  /** Cached account log + file mtime for invalidation. */
  private accountLog: AccountLogRecord[] = []
  private accountLogMtime = 0

  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  /** Update the debounce interval for incremental recalculations. */
  setDebounceSecs(secs: number): void {
    this.recalcDebounceMs = Math.max(5, secs) * 1000
    logger.debug('BlockUsage', `Debounce interval set to ${this.recalcDebounceMs}ms`)
  }

  getData(): BlockUsageData | null {
    return this.lastData
  }

  /** Set the account filter (email, null = all) and rebuild the view. */
  setAccountFilter(account: string | null): void {
    if (this.accountFilter === account) return
    this.accountFilter = account
    if (this.initialScanDone) {
      this.rebuildFromEntries(this.cachedEntries).catch((err) =>
        logger.error('BlockUsage', 'Rebuild after account filter change failed', err)
      )
    }
  }

  getAccountFilter(): string | null {
    return this.accountFilter
  }

  // -------------------------------------------------------------------------
  // API window registry
  // -------------------------------------------------------------------------

  /** Register an observed resets_at, returning the canonical window end. */
  private registerWindow(resetAtIso: string, account: string | null): number | null {
    const resetMs = new Date(resetAtIso).getTime()
    if (isNaN(resetMs)) return null
    const end = canonicalizeWindowEnd(resetMs, this.knownWindows.map((w) => w.end))
    const existing = this.knownWindows.find((w) => w.end === end)
    if (existing) {
      if (existing.account === null && account) existing.account = account
      return end
    }
    this.knownWindows.push({ start: end - SESSION_DURATION_MS, end, account })
    this.knownWindows.sort((a, b) => a.end - b.end)
    // Prune windows older than the scan window
    const cutoff = Date.now() - SCAN_WINDOW_MS
    this.knownWindows = this.knownWindows.filter((w) => w.end >= cutoff)
    return end
  }

  /**
   * Seed the window registry from apiResetAt values persisted in the last
   * two daily files, so block boundaries survive an app restart.
   */
  private seedWindowsFromDailyFiles(): void {
    if (this.windowSeedDone) return
    this.windowSeedDone = true
    const now = Date.now()
    for (let i = 1; i >= 0; i--) {
      const date = dateStrFromTimestamp(now - i * 24 * MS_PER_HOUR)
      try {
        const filePath = path.join(USAGE_DIR, `${date}.json`)
        if (!fs.existsSync(filePath)) continue
        const daily = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyUsageFile
        for (const snap of daily.snapshots) {
          if (snap.apiResetAt) this.registerWindow(snap.apiResetAt, null)
        }
      } catch {
        // Skip corrupt files
      }
    }
    if (this.knownWindows.length > 0) {
      logger.debug('BlockUsage', `Seeded ${this.knownWindows.length} window(s) from daily files`)
    }
  }

  /**
   * Find the window an entry belongs to. Prefers a window containing the
   * timestamp (account-matching first when two accounts' windows overlap);
   * falls back to the next window when the entry slightly precedes its
   * derived start (resets_at − 5h is an estimate of the true start).
   */
  private findWindowFor(ts: number, account: string | null): ApiWindow | null {
    const containing = this.knownWindows.filter((w) => ts >= w.start && ts < w.end)
    if (containing.length > 0) {
      const matching = containing.find((w) => w.account === null || w.account === account)
      return matching ?? containing[0]
    }
    // Dead zone between windows: attach to the next window within grace
    for (const w of this.knownWindows) {
      if (ts < w.start && w.start - ts <= WINDOW_START_GRACE_MS) return w
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Account log
  // -------------------------------------------------------------------------

  /** Load (and cache) the account log written by UsageFetcher. */
  private loadAccountLog(): AccountLogRecord[] {
    try {
      const mtime = fs.statSync(ACCOUNT_LOG_PATH).mtimeMs
      if (mtime === this.accountLogMtime) return this.accountLog
      const lines = fs.readFileSync(ACCOUNT_LOG_PATH, 'utf-8').split('\n')
      const log: AccountLogRecord[] = []
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line) as AccountLogRecord
          if (typeof rec.ts === 'number' && typeof rec.email === 'string') log.push(rec)
        } catch {
          // Skip malformed lines
        }
      }
      log.sort((a, b) => a.ts - b.ts)
      this.accountLog = log
      this.accountLogMtime = mtime
      return log
    } catch {
      return this.accountLog
    }
  }

  /** Distinct account emails known from the log. */
  private knownAccounts(): string[] {
    return [...new Set(this.loadAccountLog().map((r) => r.email))]
  }

  /**
   * Start watching the JSONL projects directory for changes.
   * Does a full scan on first call, then reacts to file change events.
   * Safe to call multiple times.
   */
  startWatching(): void {
    if (this.watcher) return

    try {
      // recursive: true watches all subdirectories — catches new session files
      // and subagent files without needing to manage per-directory watchers.
      this.watcher = watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return
        const fullPath = path.join(CLAUDE_PROJECTS_DIR, filename)
        this.changedFiles.add(fullPath)
        this.scheduleRecalc()
      })
      this.watcher.on('error', (err) => {
        logger.debug('BlockUsage', `Watcher error: ${err}`)
      })
      logger.debug('BlockUsage', 'Started watching JSONL directory')
    } catch (err) {
      logger.debug('BlockUsage', `Failed to start watcher: ${err}`)
    }
  }

  /** Stop watching. */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.recalcDebounceTimer) {
      clearTimeout(this.recalcDebounceTimer)
      this.recalcDebounceTimer = null
    }
  }

  /** Schedule a debounced recalculation after file change events. */
  private scheduleRecalc(): void {
    if (this.recalcDebounceTimer) return // already scheduled
    this.recalcDebounceTimer = setTimeout(() => {
      this.recalcDebounceTimer = null
      const filesToUpdate = new Set(this.changedFiles)
      this.changedFiles.clear()
      if (!this.initialScanDone) {
        // First scan hasn't completed yet — skip incremental, it'll come
        logger.debug('BlockUsage', `Watcher: ${filesToUpdate.size} file(s) changed, but initial scan pending — skipping`)
        return
      }
      logger.debug('BlockUsage', `Watcher: ${filesToUpdate.size} file(s) changed, incremental update`)
      this.incrementalUpdate(filesToUpdate).catch((err) => {
        logger.debug('BlockUsage', `Watch-triggered incremental update failed: ${err}`)
      })
    }, this.recalcDebounceMs)
  }

  /**
   * Incremental update — only reparse the files that changed, merge new entries
   * into the cached entry list, then rebuild blocks and push to renderer.
   * Much cheaper than a full recalculate: no directory walk, no stat of unchanged files.
   */
  private async incrementalUpdate(changedFiles: Set<string>): Promise<void> {
    if (this.recalculating) return
    this.recalculating = true

    try {
      const cutoff = Date.now() - SCAN_WINDOW_MS
      let newEntryCount = 0

      for (const filePath of changedFiles) {
        let mtime: number
        try {
          mtime = fs.statSync(filePath).mtimeMs
        } catch {
          continue
        }
        if (mtime < cutoff) continue

        // Reparse only this file
        const entries = await this.parseJsonlFile(filePath, cutoff)
        this.fileCache.set(filePath, { mtime, entries })

        // Merge new (unseen) entries into the cache
        for (const entry of entries) {
          if (entry.timestamp < cutoff) continue
          if (entry.messageId && this.cachedMessageIds.has(entry.messageId)) continue
          if (entry.messageId) this.cachedMessageIds.add(entry.messageId)
          this.cachedEntries.push(entry)
          newEntryCount++
        }
      }

      if (newEntryCount === 0) {
        logger.debug('BlockUsage', 'Incremental update: no new entries')
        return
      }

      logger.debug('BlockUsage', `Incremental update: ${newEntryCount} new entries from ${changedFiles.size} file(s)`)

      // New activity while no API window is known → a new window likely just
      // started; ask the fetcher to discover the new resets_at promptly.
      usageFetcher.fetchIfWindowUnknown()

      // Re-sort (new entries appended at end, but may not be chronological)
      this.cachedEntries.sort((a, b) => a.timestamp - b.timestamp)

      // Prune entries older than scan window
      const pruneIdx = this.cachedEntries.findIndex((e) => e.timestamp >= cutoff)
      if (pruneIdx > 0) {
        const pruned = this.cachedEntries.splice(0, pruneIdx)
        for (const e of pruned) {
          if (e.messageId) this.cachedMessageIds.delete(e.messageId)
        }
      }

      // Rebuild blocks from the full cached entries and push update
      await this.rebuildFromEntries(this.cachedEntries)
    } catch (err) {
      logger.error('BlockUsage', 'Incremental update failed', err)
    } finally {
      this.recalculating = false
    }
  }

  /**
   * Rebuild blocks, projections, snapshots from a set of entries and push to renderer.
   * Shared between the full recalculate path (after first scan) and incremental updates.
   */
  private async rebuildFromEntries(entries: ParsedEntry[]): Promise<BlockUsageData> {
    const now = Date.now()

    // Register the currently observed API window (if any) before grouping
    this.seedWindowsFromDailyFiles()
    const apiUsage = usageFetcher.getLastUsage()
    const activeAccount = usageFetcher.getActiveAccount()
    let currentWindowEnd: number | null = null
    if (apiUsage && !apiUsage.error && apiUsage.fiveHour.resetsAt) {
      currentWindowEnd = this.registerWindow(apiUsage.fiveHour.resetsAt, activeAccount?.email ?? null)
    }
    const windowKnown = currentWindowEnd !== null && currentWindowEnd > now

    // Apply the account filter for the view (persisted summaries stay unfiltered)
    const accountLog = this.loadAccountLog()
    const viewEntries = this.accountFilter
      ? entries.filter((e) => accountForTimestamp(accountLog, e.timestamp) === this.accountFilter)
      : entries

    const blocks = this.groupIntoBlocks(viewEntries)

    // Detect newly completed blocks. Recent provisional blocks (not aligned
    // to a known API window) are skipped — they exist only because the next
    // window hasn't been observed yet, and will regroup once it is. Persisting
    // them creates phantom completed blocks with bogus metadata.
    const currentBlockIds = new Set(blocks.map((b) => b.id))
    const newlyCompleted: UsageBlock[] = []
    for (const b of blocks) {
      if (b.isActive || this.previousBlockIds.has(b.id)) continue
      const provisional = !b.windowAligned && now - b.actualEndTime < 6 * MS_PER_HOUR
      if (provisional) continue
      newlyCompleted.push(b)
    }
    this.previousBlockIds = currentBlockIds

    // Build current + recent
    const currentBlock = blocks.find((b) => b.isActive) ?? null
    const recentBlocks = blocks.filter(
      (b) => !b.isActive && now - b.endTime < 48 * MS_PER_HOUR
    )

    // Compute projection for the active block (paused while no window is known)
    if (currentBlock) {
      currentBlock.projectedUsage = this.updateProjection(currentBlock, currentWindowEnd, now)
    }

    // Carry projections to newly completed blocks
    if (newlyCompleted.length > 0) {
      for (const b of newlyCompleted) {
        if (b.endTime === this.projectionWindowEnd && this.projectionSamples.length > 0) {
          b.projectedUsage = this.computeProjectionWLS(b)
        }
      }
    }
    this.restoreBlockMetadata(recentBlocks)

    // Persist snapshot + completed blocks. While no window is known the
    // snapshot carries no signal (0% / null reset) — skip it rather than
    // poison the time-series, but still persist completed blocks.
    const snapshot = windowKnown ? this.buildSnapshot(currentBlock) : null
    const todaySnapshots = await this.persistSnapshot(snapshot, newlyCompleted)

    // Load history — unfiltered entries drive persistence, view entries drive display
    const dailyHistory = await this.loadDailyHistory(entries, viewEntries)

    const data: BlockUsageData = {
      currentBlock,
      recentBlocks,
      todaySnapshots,
      dailyHistory,
      accounts: this.knownAccounts(),
      accountFilter: this.accountFilter
    }

    this.lastData = data
    this.pushToRenderer(data)
    return data
  }

  /** Main entry point — full scan on first call, incremental thereafter. */
  async recalculate(): Promise<BlockUsageData> {
    // Prevent concurrent recalculations
    if (this.recalculating) return this.lastData ?? this.emptyData()
    this.recalculating = true

    try {
      const entries = await this.scanAllJsonl()

      // Populate the entry cache after the first full scan
      if (!this.initialScanDone) {
        this.cachedEntries = entries
        this.cachedMessageIds = new Set(
          entries.filter((e) => e.messageId).map((e) => e.messageId)
        )
        this.initialScanDone = true
        logger.debug('BlockUsage', `Initial scan complete: ${entries.length} entries cached`)
      }

      // On first run, backfill daily summaries for days beyond the 7-day scan
      // window. This is async and doesn't block the current recalculation.
      if (!this.backfillDone) {
        this.backfillDone = true
        this.backfillHistoricalSummaries().catch((err) =>
          logger.error('BlockUsage', 'Historical backfill failed', err)
        )
      }

      return await this.rebuildFromEntries(entries)
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
    currentWindowEnd: number | null,
    now: number
  ): UsageBlock['projectedUsage'] {
    const apiUsage = usageFetcher.getLastUsage()
    if (!apiUsage || apiUsage.error) return null

    // No known window (expired / not yet reported): the percent denominator
    // is meaningless — pause the projection entirely.
    if (currentWindowEnd === null || currentWindowEnd <= now) return null

    const apiPercent = apiUsage.fiveHour.usedPercent
    const apiAge = now - apiUsage.fetchedAt
    const currentTok = totalTokens(block.tokens)

    // Reset buffer if the API window changed (new window or account switch —
    // both arrive as a different resets_at)
    if (currentWindowEnd !== this.projectionWindowEnd) {
      this.projectionSamples = []
      this.projectionWindowEnd = currentWindowEnd
    }

    // A materially lower percent than already sampled means the window
    // semantics changed under us (roll/switch the resets_at didn't catch) —
    // old samples would inflate the fit through the origin. Drop them.
    const maxSampled = this.projectionSamples.reduce((m, s) => Math.max(m, s.apiPercent), 0)
    if (apiPercent < maxSampled - 5) {
      this.projectionSamples = []
    }

    // Don't add a sample if API data is stale or values are too small
    if (apiAge > 5 * MS_PER_MINUTE) return this.computeProjectionWLS(block)
    if (apiPercent < MIN_API_PERCENT_FOR_SAMPLE || currentTok <= 0) return null

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

    // Compute cost-per-token ratio from current block (always fresh). This is
    // a blended rate over the block's actual model + cache-TTL mix — per-entry
    // costs already price 5m vs 1h cache writes separately, so the projection
    // inherits the split without modeling TTLs itself.
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
   * Restore persisted metadata (projectedUsage, finalApiPercent) on recent
   * completed blocks after an app restart. Matching is by exact block ID only
   * — time-overlap matching cross-contaminated metadata between realigned
   * blocks, and the canonical-window grouping makes IDs stable across runs.
   * A stored projection inconsistent with the block's own finalApiPercent
   * (>1.5× the capacity its final data point implies) is discarded.
   */
  private restoreBlockMetadata(recentBlocks: UsageBlock[]): void {
    const needsFill = recentBlocks.filter(
      (b) => !b.projectedUsage || b.finalApiPercent == null
    )
    if (needsFill.length === 0) return

    const byId = new Map(needsFill.map((b) => [b.id, b]))

    const now = Date.now()
    for (let i = 2; i >= 0; i--) {
      const date = dateStrFromTimestamp(now - i * 24 * MS_PER_HOUR)
      const filePath = path.join(USAGE_DIR, `${date}.json`)
      try {
        if (!fs.existsSync(filePath)) continue
        const daily = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyUsageFile
        for (const cb of daily.completedBlocks) {
          const block = byId.get(cb.id)
          if (!block) continue
          if (!block.projectedUsage && cb.projectedUsage) {
            block.projectedUsage = cb.projectedUsage
          }
          if (block.finalApiPercent == null && cb.finalApiPercent != null) {
            block.finalApiPercent = cb.finalApiPercent
          }
        }
      } catch {
        // Skip corrupt files
      }
    }

    // Sanity-clamp restored projections against the block's own final percent
    for (const block of needsFill) {
      if (!block.projectedUsage) continue
      const blockTok = totalTokens(block.tokens)
      if (block.projectedUsage.tokens < blockTok) {
        block.projectedUsage = null
        continue
      }
      if (block.finalApiPercent != null && block.finalApiPercent > 0) {
        const impliedCapacity = blockTok / (block.finalApiPercent / 100)
        if (block.projectedUsage.tokens > impliedCapacity * 1.5) {
          block.projectedUsage = null
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
          // TTL breakdown of cache writes (cli.js sessions use the 1h cache,
          // billed at 2× input). Older transcripts may lack the breakdown —
          // treated as all-5m, matching the pre-split behavior.
          const cacheBreakdown = usage.cache_creation as
            | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
            | undefined
          const cache1h = (cacheBreakdown?.ephemeral_1h_input_tokens as number) || 0

          // Calculate cost from tokens using model pricing (not from JSONL costUSD)
          const costUsd = calculateCostFromTokens(model, inTok, outTok, cacheCreate, cache1h, cacheRead)

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

    const accountLog = this.loadAccountLog()

    /** Authoritative block start for a timestamp + whether window-derived. */
    const blockStartFor = (ts: number): { start: number; aligned: boolean } => {
      const win = this.findWindowFor(ts, accountForTimestamp(accountLog, ts))
      if (win) return { start: win.start, aligned: true }
      return { start: floorToHour(ts), aligned: false }
    }

    const blocks: UsageBlock[] = []
    let blockEntries: ParsedEntry[] = []
    let blockStart = 0
    let blockAligned = false

    for (const entry of entries) {
      if (blockEntries.length === 0) {
        const ideal = blockStartFor(entry.timestamp)
        blockStart = ideal.start
        blockAligned = ideal.aligned
        blockEntries = [entry]
        continue
      }

      const ideal = blockStartFor(entry.timestamp)
      const timeSinceBlockStart = entry.timestamp - blockStart
      const lastEntry = blockEntries[blockEntries.length - 1]
      const timeSinceLastEntry = entry.timestamp - lastEntry.timestamp

      // Start a new block when:
      // 1. Entry exceeds 5hr from block start or last entry (gap logic), OR
      // 2. Entry maps to a known API window different from the current block
      //    (window boundaries are authoritative). Fallback floorToHour starts
      //    change every hour and must NOT split blocks on their own.
      const windowMismatch = ideal.aligned && ideal.start !== blockStart

      if (
        timeSinceBlockStart > SESSION_DURATION_MS ||
        timeSinceLastEntry > SESSION_DURATION_MS ||
        windowMismatch
      ) {
        blocks.push(this.buildBlock(blockEntries, blockStart, blockAligned))
        blockStart = ideal.start
        blockAligned = ideal.aligned
        blockEntries = [entry]
      } else {
        blockEntries.push(entry)
        // A provisional block upgrades in place when a later entry resolves
        // to a window whose start matches the block's
        if (!blockAligned && ideal.aligned && ideal.start === blockStart) {
          blockAligned = true
        }
      }
    }

    // Close final block
    if (blockEntries.length > 0) {
      blocks.push(this.buildBlock(blockEntries, blockStart, blockAligned))
    }

    // Clamp isActive = false for blocks that precede the current API window.
    // When the API rolls to a new 5hr window, old blocks may still have
    // endTime > now (due to floorToHour misalignment), but the API boundary
    // is authoritative — those blocks are no longer active.
    const now = Date.now()
    const currentWindow = this.knownWindows.find((w) => now >= w.start && now < w.end)
    if (currentWindow) {
      for (const block of blocks) {
        if (block.isActive && block.startTime < currentWindow.start) {
          block.isActive = false
        }
      }
    }

    return blocks
  }

  private buildBlock(entries: ParsedEntry[], blockStart: number, windowAligned: boolean): UsageBlock {
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
      finalApiPercent: null,
      windowAligned
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
    snapshot: UsageSnapshot | null,
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

    // Append snapshot (null while no API window is known — nothing to record)
    if (snapshot) daily.snapshots.push(snapshot)

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

  /** Aggregate entries into per-day buckets. */
  private bucketEntriesByDay(
    entries: ParsedEntry[]
  ): Map<string, { tokens: number; cost: number; models: Record<string, number>; requestCount: number }> {
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
    return entryBuckets
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
   *
   * `allEntries` (unfiltered) drives summary persistence; `viewEntries`
   * (account-filtered) drives the returned display history. When a filter is
   * active, fallback days from persisted summaries are skipped — they are
   * all-account aggregates and can't be filtered retroactively.
   */
  private async loadDailyHistory(
    allEntries: ParsedEntry[],
    viewEntries: ParsedEntry[]
  ): Promise<BlockUsageData['dailyHistory']> {
    const filtered = viewEntries !== allEntries
    const persistBuckets = this.bucketEntriesByDay(allEntries)
    const entryBuckets = filtered ? this.bucketEntriesByDay(viewEntries) : persistBuckets

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
    // Always from UNFILTERED buckets — summaries are all-account aggregates.
    const todayStr = todayDateStr()
    for (const [date, bucket] of persistBuckets) {
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
      } else if (daily?.dailySummary && !filtered) {
        // Fall back to persisted entry-derived summary (for days past JSONL
        // window). Skipped under an account filter — summaries are
        // all-account aggregates and can't be filtered retroactively.
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
      const dailyHistory = await this.loadDailyHistory(entries7d, entries7d)
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
      dailyHistory: [],
      accounts: [],
      accountFilter: this.accountFilter
    }
  }
}

/** Singleton instance */
export const blockUsageService = new BlockUsageService()
