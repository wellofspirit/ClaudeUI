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
  UsageBlock,
  UsageSnapshot,
  DailyUsageFile,
  BlockUsageData
} from '../../shared/types'
import { ClaudeSession } from './claude-session'
import { usageFetcher } from './usage-fetcher'
import { logger } from './logger'
import { canonicalizeWindowEnd, accountForTimestamp, type AccountLogRecord } from './usage-windows'
import {
  groupEntriesIntoBlocks,
  computeProjectionWLS as computeWLS,
  perEngineBreakdown,
  type AggEntry,
  type ApiWindow as AggApiWindow,
  type ProjectionSample as AggProjectionSample
} from './usage-aggregation'
import {
  getUsageEventsSince,
  getWindowSamples,
  insertUsageEvents,
  upsertDailyUsage,
  seedDailyUsageIfAbsent,
  getAllDailyUsage,
  hasDailyUsage,
  type UsageEventRow,
  type DailyUsageRow
} from './db'
import { v4 as uuid } from 'uuid'
import { equivalentCostUsd } from '../../shared/pricing'

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

// WINDOW_START_GRACE_MS moved to usage-aggregation.ts (grace-zone window lookup).

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
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      cacheReadPerMTok: 1
    }
  },
  {
    match: 'mythos',
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      cacheReadPerMTok: 1
    }
  },
  // Opus 4.5+ (cheaper — match these first before the older opus-4 variants)
  {
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
    match: 'opus',
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      cacheReadPerMTok: 0.5
    }
  },
  // Sonnet (all versions: 3.7, 4, 4.5, 4.6)
  {
    match: 'sonnet',
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
      cacheReadPerMTok: 0.3
    }
  },
  // Haiku 4.5
  {
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
    match: 'haiku-3',
    pricing: {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheWritePerMTok: 1,
      cacheWrite1hPerMTok: 1.6,
      cacheReadPerMTok: 0.08
    }
  },
  // Haiku (fallback)
  {
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

// Default pricing (sonnet-tier) for unknown models
const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheWrite1hPerMTok: 6,
  cacheReadPerMTok: 0.3
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

// isGenericModelName + mergeModelFamilies were extracted into
// usage-aggregation.ts (Phase 7 Pass 2) — used by the shared block builder.
// loadDailyHistory keeps its own inline family-merge for the daily chart.

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ParsedEntry {
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

function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

/**
 * Merge a day's per-model token map (model → tokens) by family, resolving each
 * family back to the most-token specific model name. Verbatim extraction of the
 * inline merge in loadDailyHistory, shared with the SQL daily path so both
 * produce identical model maps. Pure.
 */
function mergeDailyModelFamilies(models: Record<string, number>): Record<string, number> {
  const familyOf = (model: string): string => {
    const lower = model.toLowerCase()
    if (lower.includes('opus')) return 'opus'
    if (lower.includes('sonnet')) return 'sonnet'
    if (lower.includes('haiku')) return 'haiku'
    return model
  }
  const modelMap = new Map<string, number>()
  for (const [model, tok] of Object.entries(models)) {
    const family = familyOf(model)
    modelMap.set(family, (modelMap.get(family) || 0) + tok)
  }
  const resolved: Record<string, number> = {}
  for (const [family, tok] of modelMap) {
    let bestModel = family
    let bestTok = 0
    for (const [model, mTok] of Object.entries(models)) {
      if (familyOf(model) === family && mTok > bestTok) {
        bestModel = model
        bestTok = mTok
      }
    }
    resolved[bestModel] = tok
  }
  return resolved
}

function todayDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateStrFromTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// floorToHour was extracted into usage-aggregation.ts (Phase 7 Pass 2).

// ---------------------------------------------------------------------------
// BlockUsageService
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Projection types & constants
// ---------------------------------------------------------------------------

/** A single (tokens, apiPercent) observation for projection regression. */
interface ProjectionSample {
  timestamp: number
  tokens: number // total local tokens at this snapshot
  apiPercent: number // API 5hr usage % at this snapshot
}

// PROJECTION_HALF_LIFE_MS + MIN_REGRESSION_SAMPLES moved to usage-aggregation.ts
// (Phase 7 Pass 2) — the WLS math lives there now.
/** Max samples to keep in the ring buffer (~1hr at 2-min polling). */
const MAX_PROJECTION_SAMPLES = 30
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

  /**
   * Parse all Claude JSONL entries within the scan window (reusing the exact
   * parse + calculateCostFromTokens), each tagged with its time-attributed
   * account (email + uuid from the account log). The Phase 7 reconciler calls
   * this to import Claude usage_event rows — there is NO second JSONL parser.
   */
  async getClaudeEntriesForReconcile(): Promise<
    Array<ParsedEntry & { accountEmail: string | null; accountUuid: string | null }>
  > {
    const cutoff = Date.now() - SCAN_WINDOW_MS
    const entries = await this.scanJsonlWithCutoff(cutoff)
    const accountLog = this.loadAccountLog()
    // Build email → uuid from the log (latest wins).
    const emailToUuid = new Map<string, string>()
    for (const rec of accountLog) emailToUuid.set(rec.email, rec.accountUuid)
    return entries.map((e) => {
      const email = accountForTimestamp(accountLog, e.timestamp)
      return {
        ...e,
        accountEmail: email,
        accountUuid: email ? (emailToUuid.get(email) ?? null) : null
      }
    })
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
    const end = canonicalizeWindowEnd(
      resetMs,
      this.knownWindows.map((w) => w.end)
    )
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
        logger.debug(
          'BlockUsage',
          `Watcher: ${filesToUpdate.size} file(s) changed, but initial scan pending — skipping`
        )
        return
      }
      logger.debug(
        'BlockUsage',
        `Watcher: ${filesToUpdate.size} file(s) changed, incremental update`
      )
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

      logger.debug(
        'BlockUsage',
        `Incremental update: ${newEntryCount} new entries from ${changedFiles.size} file(s)`
      )

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
      currentWindowEnd = this.registerWindow(
        apiUsage.fiveHour.resetsAt,
        activeAccount?.email ?? null
      )
    }
    const windowKnown = currentWindowEnd !== null && currentWindowEnd > now

    const accountLog = this.loadAccountLog()

    // Full SQL (Phase 7 Pass 2): the dashboard blocks are now sourced from
    // usage_event, not the in-memory JSONL ParsedEntry list. We first upsert the
    // freshly-parsed JSONL entries into usage_event (idempotent on message_id —
    // converges with the reconciler + live opencode rows), then read Claude
    // entries BACK from the DB for grouping. The reconciler keeps usage_event
    // complete for out-of-tool sessions; this inline upsert guarantees block-
    // usage's own JSONL data is present before it reads (no flash of empty).
    this.upsertClaudeEntriesToDb(entries, accountLog)
    const dbEntries = this.claudeEntriesFromDb(now)

    // Apply the account filter for the view (persisted summaries stay unfiltered)
    const viewEntries = this.accountFilter
      ? dbEntries.filter(
          (e) => accountForTimestamp(accountLog, e.timestamp) === this.accountFilter
        )
      : dbEntries

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
    const recentBlocks = blocks.filter((b) => !b.isActive && now - b.endTime < 48 * MS_PER_HOUR)

    // Compute projection for the active block (paused while no window is known).
    // Phase 9a: pass viewEntries so updateProjection can reconstruct cumTokensAt(ts)
    // from the DB window samples (survives app restart).
    if (currentBlock) {
      currentBlock.projectedUsage = this.updateProjection(currentBlock, currentWindowEnd, now, viewEntries)
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

    // Daily history (Full SQL): roll up usage_event per day into daily_usage,
    // then read the 30-day chart from daily_usage (durable past the 7-day
    // usage_event window — older days were seeded once from the legacy JSON
    // files). The legacy JSON-file daily summaries keep being written for a
    // release as a fallback — drive that from the JSONL `entries` exactly as
    // before (allEntries === viewEntries when unfiltered) so persistDailySummary
    // behavior is unchanged. The chart itself now reads SQL.
    const jsonlViewEntries = this.accountFilter
      ? entries.filter((e) => accountForTimestamp(accountLog, e.timestamp) === this.accountFilter)
      : entries
    const filteredDailyHistory = await this.loadDailyHistory(entries, jsonlViewEntries)
    this.rollupDailyUsageFromDb(now)
    // Account-filtered views can't read the all-account daily_usage rollup, so
    // they use the entry-derived (account-attributable) history; unfiltered
    // views read the durable SQL rollup.
    const dailyHistory = this.accountFilter ? filteredDailyHistory : this.dailyHistoryFromDb()

    // Per-engine breakdown over the scan window from usage_event (ALL engines).
    // This is how opencode usage surfaces — the Claude blocks above stay
    // Claude-only (5h windows are a Claude-subscription concept). Best-effort.
    const perEngine = this.computePerEngine(now)

    const data: BlockUsageData = {
      currentBlock,
      recentBlocks,
      todaySnapshots,
      dailyHistory,
      accounts: this.knownAccounts(),
      accountFilter: this.accountFilter,
      perEngine
    }

    this.lastData = data
    this.pushToRenderer(data)
    return data
  }

  /**
   * Per-engine usage breakdown over the scan window, from usage_event (Phase 7
   * Pass 2). Both engines appear. Failures degrade to undefined (Claude-only
   * dashboard unaffected). Uses each row's equiv_cost_usd (falling back to
   * engine_cost_usd) so the cost matches the dashboard's equivalent-cost metric.
   */
  private computePerEngine(now: number): BlockUsageData['perEngine'] {
    try {
      const cutoff = now - SCAN_WINDOW_MS
      const rows: UsageEventRow[] = getUsageEventsSince(cutoff)
      if (rows.length === 0) return undefined
      const aggEntries: AggEntry[] = rows.map((r) => ({
        timestamp: r.ts,
        model: r.modelId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheCreationTokens: r.cacheWriteTokens,
        cacheReadTokens: r.cacheReadTokens,
        costUsd: r.equivCostUsd ?? r.engineCostUsd ?? 0,
        messageId: r.messageId,
        engineId: r.engineId
      }))
      const breakdown = perEngineBreakdown(aggEntries)
      return breakdown.length > 0 ? breakdown : undefined
    } catch (err) {
      logger.debug('BlockUsage', `per-engine breakdown failed: ${err}`)
      return undefined
    }
  }

  // -------------------------------------------------------------------------
  // Full SQL: usage_event-sourced blocks + daily_usage-sourced chart (Pass 2)
  // -------------------------------------------------------------------------

  /**
   * Upsert freshly-parsed Claude JSONL entries into usage_event (idempotent on
   * message_id). This makes block-usage self-sufficient: its own JSONL data is
   * present in the DB before it reads blocks back, so there's no flash of empty
   * even if the external reconciler hasn't run yet. equiv_cost from the pricing
   * table; engine_cost carries the exact calculateCostFromTokens value (so the
   * SQL-sourced block costs == the old JSONL block costs byte-for-byte).
   */
  private upsertClaudeEntriesToDb(entries: ParsedEntry[], accountLog: AccountLogRecord[]): void {
    try {
      const emailToUuid = new Map<string, string>()
      for (const rec of accountLog) emailToUuid.set(rec.email, rec.accountUuid)
      const rows: UsageEventRow[] = []
      for (const e of entries) {
        if (!e.messageId) continue
        const email = accountForTimestamp(accountLog, e.timestamp)
        const equiv = equivalentCostUsd('anthropic', e.model, {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheWriteTokens: e.cacheCreationTokens,
          cacheWrite1hTokens: 0,
          cacheReadTokens: e.cacheReadTokens
        })
        rows.push({
          id: uuid(),
          ts: e.timestamp,
          engineId: 'claude',
          vendorId: 'anthropic',
          accountId: null,
          accountUuid: email ? (emailToUuid.get(email) ?? null) : null,
          modelId: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheWriteTokens: e.cacheCreationTokens,
          cacheWrite1hTokens: 0,
          cacheReadTokens: e.cacheReadTokens,
          equivCostUsd: equiv ?? e.costUsd,
          engineCostUsd: e.costUsd,
          sessionId: null,
          messageId: e.messageId,
          source: 'backfill'
        })
      }
      insertUsageEvents(rows)
    } catch (err) {
      logger.debug('BlockUsage', `upsertClaudeEntriesToDb failed: ${err}`)
    }
  }

  /**
   * Read Claude entries back from usage_event as the ParsedEntry shape the block
   * grouping consumes. costUsd is sourced from engine_cost_usd (= the original
   * calculateCostFromTokens value) so blocks are byte-identical to the old
   * JSONL-sourced blocks. cacheCreationTokens = cache_write_tokens (combined
   * 5m+1h, matching the JSONL ParsedEntry).
   */
  private claudeEntriesFromDb(now: number): ParsedEntry[] {
    const cutoff = now - SCAN_WINDOW_MS
    const rows = getUsageEventsSince(cutoff, 'claude')
    return rows.map((r) => ({
      timestamp: r.ts,
      model: r.modelId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheCreationTokens: r.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens,
      costUsd: r.engineCostUsd ?? r.equivCostUsd ?? 0,
      messageId: r.messageId
    }))
  }

  /**
   * Roll up usage_event (last 7d, ALL engines) into daily_usage per
   * (date, engine, vendor, model). Day bucketing uses dateStrFromTimestamp
   * (LOCAL time) to match the historical chart exactly. Recomputed each
   * rebuild (source 'rollup', REPLACE) — older seeded days are untouched.
   * peak_api_percent is carried from the daily JSON snapshots when available.
   */
  private rollupDailyUsageFromDb(now: number): void {
    try {
      const cutoff = now - SCAN_WINDOW_MS
      const rows = getUsageEventsSince(cutoff)
      if (rows.length === 0) return

      // Bucket by (date, engineId, vendorId, modelId).
      const buckets = new Map<string, DailyUsageRow>()
      for (const r of rows) {
        const date = dateStrFromTimestamp(r.ts)
        const key = `${date}|${r.engineId}|${r.vendorId}|${r.modelId}`
        let b = buckets.get(key)
        if (!b) {
          b = {
            date,
            engineId: r.engineId,
            vendorId: r.vendorId,
            modelId: r.modelId,
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
            requestCount: 0,
            peakApiPercent: 0,
            source: 'rollup'
          }
          buckets.set(key, b)
        }
        b.inputTokens += r.inputTokens
        b.outputTokens += r.outputTokens
        b.cacheWriteTokens += r.cacheWriteTokens
        b.cacheReadTokens += r.cacheReadTokens
        // Claude daily cost matches the historical entry-derived total (engine
        // cost = calculateCostFromTokens). opencode rows use equiv (or engine).
        b.costUsd += (r.engineId === 'claude' ? r.engineCostUsd : r.equivCostUsd ?? r.engineCostUsd) ?? 0
        b.requestCount += 1
      }

      // Attach peak API % per date from the daily JSON snapshots (Claude only).
      const peakByDate = this.peakApiPercentByDate()
      for (const b of buckets.values()) {
        if (b.engineId === 'claude') b.peakApiPercent = peakByDate.get(b.date) ?? 0
      }

      upsertDailyUsage([...buckets.values()])
    } catch (err) {
      logger.debug('BlockUsage', `rollupDailyUsageFromDb failed: ${err}`)
    }
  }

  /** Peak API % per date from the daily JSON snapshot files (for the chart). */
  private peakApiPercentByDate(): Map<string, number> {
    const out = new Map<string, number>()
    try {
      if (!fs.existsSync(USAGE_DIR)) return out
      for (const file of fs.readdirSync(USAGE_DIR)) {
        if (!file.endsWith('.json')) continue
        const date = file.replace('.json', '')
        try {
          const daily = JSON.parse(
            fs.readFileSync(path.join(USAGE_DIR, file), 'utf-8')
          ) as DailyUsageFile
          let peak = 0
          for (const snap of daily.snapshots) {
            if (snap.apiUsagePercent > peak) peak = snap.apiUsagePercent
          }
          out.set(date, peak)
        } catch {
          // skip corrupt
        }
      }
    } catch {
      // usage dir missing
    }
    return out
  }

  /**
   * Build the dashboard's dailyHistory from daily_usage (SQL). Per-model token
   * maps merge generic→specific families (same as the old loadDailyHistory).
   * costUsd rounded to cents to match the legacy output.
   */
  private dailyHistoryFromDb(): BlockUsageData['dailyHistory'] {
    const rows = getAllDailyUsage()
    // Group rows by date.
    const byDate = new Map<
      string,
      { tokens: number; cost: number; models: Record<string, number>; peak: number; reqs: number }
    >()
    for (const r of rows) {
      let d = byDate.get(r.date)
      if (!d) {
        d = { tokens: 0, cost: 0, models: {}, peak: 0, reqs: 0 }
        byDate.set(r.date, d)
      }
      const tok = r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheReadTokens
      d.tokens += tok
      d.cost += r.costUsd
      d.reqs += r.requestCount
      if (r.peakApiPercent > d.peak) d.peak = r.peakApiPercent
      const normalized = normalizeModelName(r.modelId)
      if (normalized) d.models[normalized] = (d.models[normalized] || 0) + tok
    }

    const history: BlockUsageData['dailyHistory'] = []
    for (const date of [...byDate.keys()].sort()) {
      const d = byDate.get(date)!
      if (d.tokens === 0 && d.cost === 0) continue
      history.push({
        date,
        totalTokens: d.tokens,
        costUsd: Math.round(d.cost * 100) / 100,
        models: mergeDailyModelFamilies(d.models),
        peakApiPercent: d.peak,
        blockCount: 0
      })
    }
    return history
  }

  /**
   * One-time seed of daily_usage from the legacy daily JSON files, so historical
   * days BEYOND the 7-day usage_event window aren't lost. Idempotent: only
   * inserts (date, engine, vendor, model) keys not already present, and only
   * runs when daily_usage is empty (first launch after this migration). Legacy
   * files have a single all-Claude dailySummary (no per-model vendor split), so
   * each seeded row is engine 'claude' / vendor 'anthropic' / model = the
   * summary's model key.
   */
  seedDailyUsageFromFilesOnce(): void {
    try {
      if (hasDailyUsage()) return // already seeded / has rollups
      if (!fs.existsSync(USAGE_DIR)) return
      const seedRows: DailyUsageRow[] = []
      for (const file of fs.readdirSync(USAGE_DIR)) {
        if (!file.endsWith('.json')) continue
        const date = file.replace('.json', '')
        try {
          const daily = JSON.parse(
            fs.readFileSync(path.join(USAGE_DIR, file), 'utf-8')
          ) as DailyUsageFile
          const summary = daily.dailySummary
          if (!summary) continue
          let peak = 0
          for (const snap of daily.snapshots) {
            if (snap.apiUsagePercent > peak) peak = snap.apiUsagePercent
          }
          // The legacy summary has per-model TOTAL tokens (models: Record<model, tokens>)
          // but no per-model cost/request split — attribute total cost/requests to
          // the largest model, and 0 to the rest (cost is summed per day anyway).
          const modelEntries = Object.entries(summary.models)
          if (modelEntries.length === 0) {
            // No per-model breakdown — single synthetic row carrying the totals.
            seedRows.push({
              date,
              engineId: 'claude',
              vendorId: 'anthropic',
              modelId: 'claude',
              inputTokens: summary.totalTokens,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUsd: summary.costUsd,
              requestCount: summary.requestCount ?? 0,
              peakApiPercent: peak,
              source: 'seed'
            })
            continue
          }
          // Largest model carries cost + requests + peak; others carry tokens only.
          let largest = modelEntries[0][0]
          let largestTok = -1
          for (const [m, tok] of modelEntries) {
            if (tok > largestTok) {
              largestTok = tok
              largest = m
            }
          }
          for (const [model, tok] of modelEntries) {
            seedRows.push({
              date,
              engineId: 'claude',
              vendorId: 'anthropic',
              modelId: model,
              // Store the day's total tokens for this model on input_tokens — the
              // chart only sums the four token columns, so attributing the whole
              // model total to input_tokens preserves the per-day + per-model totals.
              inputTokens: tok,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUsd: model === largest ? summary.costUsd : 0,
              requestCount: model === largest ? (summary.requestCount ?? 0) : 0,
              peakApiPercent: model === largest ? peak : 0,
              source: 'seed'
            })
          }
        } catch {
          // skip corrupt
        }
      }
      if (seedRows.length > 0) {
        seedDailyUsageIfAbsent(seedRows)
        logger.info('BlockUsage', `Seeded daily_usage from ${seedRows.length} legacy file rows`)
      }
    } catch (err) {
      logger.debug('BlockUsage', `seedDailyUsageFromFilesOnce failed: ${err}`)
    }
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
        this.cachedMessageIds = new Set(entries.filter((e) => e.messageId).map((e) => e.messageId))
        this.initialScanDone = true
        logger.debug('BlockUsage', `Initial scan complete: ${entries.length} entries cached`)
        // Full SQL (Pass 2): one-time seed of daily_usage from the legacy daily
        // JSON files so historical >7d days aren't lost. Idempotent + gated on
        // an empty daily_usage table; runs before the first daily read below.
        this.seedDailyUsageFromFilesOnce()
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
   * Build a ProjectionSample from DB window samples for the current block.
   *
   * Phase 9a: re-sources the WLS input from `usage_window_sample` (DB) instead of
   * only the in-memory ring. This survives app restart since the DB persists across
   * sessions.
   *
   * `cumTokensAt(ts)` reconstructs the CURRENT block's cumulative tokens at each
   * sample timestamp — entries are scoped to `[blockStart, ts]`. This must NOT
   * include tokens from prior blocks: the in-memory ring tracked
   * `totalTokens(block.tokens)` (which resets to 0 at each block boundary), and the
   * WLS fits `tokens = k·apiPercent` through the ORIGIN — a constant token offset
   * from earlier blocks would inflate `k` (and the projected capacity) substantially.
   *
   * Note: recordWindowSampleFromUsage (usage-fetcher.ts) writes to the DB inside
   * pushToRenderer BEFORE sending usage:data, so the freshest sample may lag one
   * recalc cycle. This is acceptable per the drift decision.
   *
   * @param currentWindowEnd  Canonical end of the active 5h window.
   * @param blockStart        Start of the current block — entries before this are excluded.
   * @param blockEntries      ParsedEntries (may span multiple blocks) — scoped to the
   *                          current block before computing cumTokensAt(sample.ts).
   */
  private buildDbProjectionSamples(
    currentWindowEnd: number,
    blockStart: number,
    blockEntries: ParsedEntry[]
  ): AggProjectionSample[] {
    const accountUuid = usageFetcher.getActiveAccountUuid()
    if (!accountUuid) return []
    try {
      const dbSamples = getWindowSamples(accountUuid)
      // Filter to samples for the current window only.
      const windowSamples = dbSamples.filter((s) => s.canonicalEnd === currentWindowEnd)
      if (windowSamples.length === 0) return []

      // Scope to the CURRENT block (drop entries before blockStart) and sort by ts
      // — entries from prior blocks must not leak into this block's cumulative count.
      const blockOnly = blockEntries
        .filter((e) => e.timestamp >= blockStart)
        .sort((a, b) => a.timestamp - b.timestamp)

      // Single prefix-sum pass: prefixTokens[i] = Σ tokens of blockOnly[0..i].
      const tokensOf = (e: ParsedEntry): number =>
        e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
      const prefixTokens: number[] = []
      let running = 0
      for (const e of blockOnly) {
        running += tokensOf(e)
        prefixTokens.push(running)
      }
      // cumTokensAt(ts) = Σ tokens of block entries with timestamp ≤ ts (binary search
      // for the last entry at or before ts, then read its prefix sum).
      const cumTokensAt = (ts: number): number => {
        let lo = 0
        let hi = blockOnly.length - 1
        let idx = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (blockOnly[mid].timestamp <= ts) {
            idx = mid
            lo = mid + 1
          } else {
            hi = mid - 1
          }
        }
        return idx >= 0 ? prefixTokens[idx] : 0
      }

      return windowSamples.map((s) => ({
        timestamp: s.ts,
        tokens: cumTokensAt(s.ts),
        apiPercent: s.usedPercent
      }))
    } catch (err) {
      logger.debug('BlockUsage', `buildDbProjectionSamples failed: ${err}`)
      return []
    }
  }

  private updateProjection(
    block: UsageBlock,
    currentWindowEnd: number | null,
    now: number,
    blockEntries: ParsedEntry[] = []
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
    if (apiAge > 5 * MS_PER_MINUTE) return this.computeProjectionWLS(block, currentWindowEnd, blockEntries)
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

    return this.computeProjectionWLS(block, currentWindowEnd, blockEntries)
  }

  /**
   * Compute the projection from samples using WLS regression.
   *
   * Phase 7 Pass 2: the WLS MATH was extracted VERBATIM into
   * `usage-aggregation.ts` computeProjectionWLS (proven identical by the
   * equivalence test). This method delegates the math unchanged.
   *
   * Phase 9a: the sample SOURCE is now the DB (`usage_window_sample`) when
   * available, with the in-memory ring as fallback when the DB has no samples
   * for the current window (e.g. first boot before any poll has written to DB).
   * Minor numerical drift vs the ring-only approach is accepted — see docs/v2/
   * phase-9-usage-analytics.md §WLS projection.
   */
  private computeProjectionWLS(
    block: UsageBlock,
    currentWindowEnd?: number | null,
    blockEntries: ParsedEntry[] = []
  ): UsageBlock['projectedUsage'] {
    let samples: AggProjectionSample[]

    // Prefer DB samples (survive restart); fall back to in-memory ring when the
    // DB has no samples for this window (e.g. first launch before any poll).
    // Entries are scoped to this block (block.startTime) inside buildDbProjectionSamples
    // so prior blocks' tokens don't inflate the through-origin WLS fit.
    if (currentWindowEnd) {
      const dbSamples = this.buildDbProjectionSamples(currentWindowEnd, block.startTime, blockEntries)
      samples = dbSamples.length > 0 ? dbSamples : (this.projectionSamples as AggProjectionSample[])
    } else {
      samples = this.projectionSamples as AggProjectionSample[]
    }

    return computeWLS(
      samples,
      totalTokens(block.tokens),
      block.costUsd,
      Date.now()
    )
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
    const needsFill = recentBlocks.filter((b) => !b.projectedUsage || b.finalApiPercent == null)
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

          const timestamp = data.timestamp ? new Date(data.timestamp as string).getTime() : 0

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
          const costUsd = calculateCostFromTokens(
            model,
            inTok,
            outTok,
            cacheCreate,
            cache1h,
            cacheRead
          )

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

  /**
   * Group entries into 5h blocks.
   *
   * Phase 7 Pass 2: the grouping walk + buildBlock + mergeModelFamilies were
   * extracted VERBATIM into `usage-aggregation.ts` (proven byte-for-byte
   * identical by usage-aggregation-equivalence.test.ts). This method now maps
   * the Claude-shaped ParsedEntry list to the engine-tagged AggEntry shape and
   * delegates. The window registry + account log (instance state) are passed in.
   */
  private groupIntoBlocks(entries: ParsedEntry[]): UsageBlock[] {
    if (entries.length === 0) return []
    const accountLog = this.loadAccountLog()
    const aggEntries: AggEntry[] = entries.map((e) => ({
      timestamp: e.timestamp,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      cacheReadTokens: e.cacheReadTokens,
      costUsd: e.costUsd,
      messageId: e.messageId,
      engineId: 'claude'
    }))
    // knownWindows is structurally identical to AggApiWindow.
    return groupEntriesIntoBlocks(
      aggEntries,
      this.knownWindows as AggApiWindow[],
      accountLog,
      Date.now()
    )
  }

  // buildBlock + mergeModelFamilies + the grouping walk were extracted VERBATIM
  // into usage-aggregation.ts (Phase 7 Pass 2) — groupIntoBlocks delegates there.

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
  ): Map<
    string,
    { tokens: number; cost: number; models: Record<string, number>; requestCount: number }
  > {
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
        entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens
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

    // Merge model families in entry buckets (shared helper — identical logic
    // to the SQL daily path's mergeDailyModelFamilies).
    for (const bucket of entryBuckets.values()) {
      bucket.models = mergeDailyModelFamilies(bucket.models)
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
              JSON.parse(fs.readFileSync(path.join(USAGE_DIR, file), 'utf-8')) as DailyUsageFile
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
        entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens
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
          const daily = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyUsageFile
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
