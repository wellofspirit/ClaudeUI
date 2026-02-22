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
import { usageFetcher } from './usage-fetcher'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const USAGE_DIR = path.join(os.homedir(), '.claude', 'ui', 'usage')
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000 // 5 hours
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // only scan entries from last 7 days
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

export class BlockUsageService {
  private window: BrowserWindow | null = null
  private fileCache: Map<string, FileCache> = new Map()
  private lastData: BlockUsageData | null = null
  private previousBlockIds: Set<string> = new Set()
  private recalculating = false

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

      // Persist snapshot + completed blocks
      const snapshot = this.buildSnapshot(currentBlock)
      const todaySnapshots = await this.persistSnapshot(snapshot, newlyCompleted)

      // Load 30-day history
      const dailyHistory = await this.loadDailyHistory(30)

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
      console.error('[BlockUsage] recalculation failed:', err)
      return this.lastData ?? this.emptyData()
    } finally {
      this.recalculating = false
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
        apiWindowEnd = resetMs
        apiWindowStart = resetMs - SESSION_DURATION_MS
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

    // Max theoretical usage for the 5hr window based on API usage %
    // If API says 62% and we have 145K tokens, then 100% ≈ 145K / 0.62 = 234K
    // Skip projection if API data is stale (>5 min old) — the ratio would be
    // wrong because currentTok has grown while apiPercent hasn't updated.
    const MAX_API_STALENESS_MS = 5 * MS_PER_MINUTE
    let projectedUsage: UsageBlock['projectedUsage'] = null
    if (isActive) {
      const apiUsage = usageFetcher.getLastUsage()
      const apiPercent = apiUsage?.fiveHour.usedPercent ?? 0
      const apiAge = apiUsage ? now - apiUsage.fetchedAt : Infinity
      const currentTok = totalTokens(tokens)
      if (apiPercent > 0 && currentTok > 0 && apiAge < MAX_API_STALENESS_MS) {
        const maxTokens = currentTok / (apiPercent / 100)
        const maxCost = costUsd / (apiPercent / 100)
        projectedUsage = {
          tokens: Math.round(maxTokens),
          costUsd: Math.round(maxCost * 100) / 100
        }
      }
    }

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
      projectedUsage
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
      burnRate: currentBlock?.burnRate ?? null
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

    // Add newly completed blocks (deduplicate by id)
    const existingIds = new Set(daily.completedBlocks.map((b) => b.id))
    for (const block of newlyCompleted) {
      if (!existingIds.has(block.id)) {
        daily.completedBlocks.push(block)
      }
    }

    // Write
    try {
      if (!fs.existsSync(USAGE_DIR)) {
        fs.mkdirSync(USAGE_DIR, { recursive: true })
      }
      fs.writeFileSync(filePath, JSON.stringify(daily), { mode: 0o600 })
    } catch (err) {
      console.error('[BlockUsage] failed to persist daily file:', err)
    }

    return daily.snapshots
  }

  private async loadDailyHistory(
    days: number
  ): Promise<BlockUsageData['dailyHistory']> {
    const history: BlockUsageData['dailyHistory'] = []
    const now = Date.now()

    for (let i = days - 1; i >= 0; i--) {
      const date = dateStrFromTimestamp(now - i * 24 * MS_PER_HOUR)
      const filePath = path.join(USAGE_DIR, `${date}.json`)

      try {
        if (!fs.existsSync(filePath)) continue
        const daily = JSON.parse(
          fs.readFileSync(filePath, 'utf-8')
        ) as DailyUsageFile

        // Aggregate completed blocks for this day
        let dayTokens = 0
        let dayCost = 0
        const modelTokens: Record<string, number> = {}
        let peakApi = 0

        for (const block of daily.completedBlocks) {
          dayTokens += totalTokens(block.tokens)
          dayCost += block.costUsd
          for (const m of block.models) {
            modelTokens[m.model] = (modelTokens[m.model] || 0) + totalTokens(m.tokens)
          }
        }

        // Also include active block tokens from latest snapshot
        if (daily.snapshots.length > 0) {
          const lastSnap = daily.snapshots[daily.snapshots.length - 1]
          if (lastSnap.blockTokens && lastSnap.activeBlockId) {
            // Check if this active block is already in completedBlocks
            const alreadyCounted = daily.completedBlocks.some(
              (b) => b.id === lastSnap.activeBlockId
            )
            if (!alreadyCounted) {
              dayTokens += totalTokens(lastSnap.blockTokens)
              dayCost += lastSnap.blockCostUsd
              for (const m of lastSnap.blockModels) {
                modelTokens[m.model] =
                  (modelTokens[m.model] || 0) + totalTokens(m.tokens)
              }
            }
          }

          // Peak API %
          for (const snap of daily.snapshots) {
            if (snap.apiUsagePercent > peakApi) peakApi = snap.apiUsagePercent
          }
        }

        if (dayTokens > 0 || daily.completedBlocks.length > 0) {
          history.push({
            date,
            totalTokens: dayTokens,
            costUsd: Math.round(dayCost * 100) / 100,
            models: modelTokens,
            peakApiPercent: peakApi,
            blockCount: daily.completedBlocks.length
          })
        }
      } catch {
        // Skip corrupt files
      }
    }

    return history
  }

  // -------------------------------------------------------------------------
  // Renderer Push
  // -------------------------------------------------------------------------

  private pushToRenderer(data: BlockUsageData): void {
    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('usage:block-data', data)
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
