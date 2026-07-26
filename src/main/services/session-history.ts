import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type {
  ChatMessage,
  ContentBlock,
  DirectoryGroup,
  SessionInfo,
  TaskNotification,
  StatusLineData,
  ForkAnchorResult,
  ModelCostEntry,
  EngineId
} from '../../shared/types'
import { logger } from './logger'
import { getContextWindowSize } from './context-window'
import { findForkAnchorUuid } from './fork-anchor'
import { resolvePiForkAnchor } from './pi-session-list'
import { calculateCostFromTokens, normalizeModelName } from './block-usage'
import { dispatchedCostsByRouting } from './db'
import { cwdToProjectKey } from '../../shared/project-key'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

const CACHE_DIR = path.join(os.homedir(), '.claude', 'ui')
const CACHE_FILE = path.join(CACHE_DIR, 'directory-cache.json')

// ─── Disk-based metadata cache ───────────────────────────────────────────────

interface CachedSessionMeta {
  mtime: number
  title: string
  cwd: string
  timestamp: number
  customTitle: string | null
  aiTitle: string | null
  summary: string | null
  hasConversation: boolean
}

// Bumped whenever CachedSessionMeta shape changes — forces a full re-parse on upgrade.
const CACHE_SCHEMA_VERSION = 2

interface DiskCacheFile {
  version: number
  entries: Record<string, CachedSessionMeta>
}

type DiskCache = Record<string, CachedSessionMeta>

function loadDiskCache(): DiskCache {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {}
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as DiskCacheFile | DiskCache
    if (typeof raw === 'object' && raw !== null && 'version' in raw && 'entries' in raw) {
      const file = raw as DiskCacheFile
      return file.version === CACHE_SCHEMA_VERSION ? file.entries : {}
    }
    // Legacy unversioned cache — discard (forces re-parse with new fields).
    return {}
  } catch (err) {
    logger.warn('SessionHistory', 'Failed to load disk cache', err)
    return {}
  }
}

function saveDiskCache(cache: DiskCache): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
    }
    const file: DiskCacheFile = { version: CACHE_SCHEMA_VERSION, entries: cache }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(file), { mode: 0o600 })
  } catch (err) {
    logger.warn('SessionHistory', 'Failed to save disk cache', err)
  }
}

/**
 * Incremental accumulator reconstructing accumulated ACTIVE (turn-processing)
 * duration from a Claude transcript's parsed JSONL lines
 * (StatusLineData.totalDurationMs — see shared/types.ts). Real transcripts
 * carry no `type: "result"` lines (the historical duration source), so
 * duration is rebuilt from line timestamps instead:
 *
 * A **turn boundary** is a real user prompt line — `type === 'user'` with no
 * `toolUseResult` and not `isMeta`. Everything from a boundary up to (but not
 * including) the next boundary belongs to that turn — including tool-result
 * user lines and meta lines, which are part of the in-flight turn, not new
 * turns themselves. A turn's span is its first parseable-timestamp line to
 * its last, summed across every turn (the trailing turn runs to EOF).
 *
 * Lines with a missing/unparseable ISO `timestamp` are skipped for span math
 * but do not break the current turn — the next line with a valid timestamp
 * still extends it. Negative or NaN spans are clamped to 0.
 *
 * `push()` lines one at a time (streaming — no line retention; O(1) state) and
 * read `total()` at end-of-stream. `total()` finalizes the trailing turn but
 * does not consume the accumulator: further push/total cycles keep working.
 */
export function createTurnSpanAccumulator(): {
  push(line: Record<string, unknown>): void
  total(): number
} {
  let totalMs = 0
  let turnOpen = false
  let turnStartMs: number | null = null
  let turnEndMs: number | null = null

  const finalizeTurn = (): void => {
    if (turnStartMs !== null && turnEndMs !== null) {
      const span = turnEndMs - turnStartMs
      if (Number.isFinite(span) && span > 0) totalMs += span
    }
    turnStartMs = null
    turnEndMs = null
  }

  return {
    push(line: Record<string, unknown>): void {
      const isBoundary = line.type === 'user' && !line.toolUseResult && !line.isMeta
      if (isBoundary) {
        finalizeTurn()
        turnOpen = true
      }
      if (!turnOpen) return

      const ts = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
      if (!Number.isFinite(ts)) return
      if (turnStartMs === null) turnStartMs = ts
      turnEndMs = ts
    },
    total(): number {
      // Fold the trailing (unfinalized) turn in WITHOUT consuming state: keep
      // the open turn's span live so a subsequent push can still extend it.
      let result = totalMs
      if (turnStartMs !== null && turnEndMs !== null) {
        const span = turnEndMs - turnStartMs
        if (Number.isFinite(span) && span > 0) result += span
      }
      return result
    }
  }
}

/**
 * Batch convenience over `createTurnSpanAccumulator` — same semantics for a
 * fully materialized line array (tests, small transcripts). Streaming callers
 * (computeTokenMetrics) use the accumulator directly to avoid retaining every
 * parsed line in memory.
 */
export function computeTurnSpanDurationMs(lines: Array<Record<string, unknown>>): number {
  const acc = createTurnSpanAccumulator()
  for (const line of lines) acc.push(line)
  return acc.total()
}

/**
 * Compute token metrics from a JSONL transcript file.
 * Mirrors ccstatusline's approach: sums message.usage from every assistant entry.
 */
/** Per-model token aggregate used only for the modelCosts cost reconstruction
 *  (kept separate from the legacy totalInputTokens/etc sums below, which are
 *  NOT deduplicated by message id and are left behaviorally unchanged). */
interface ModelTokenAgg {
  input: number
  output: number
  cacheCreation: number
  cacheCreation1h: number
  cacheRead: number
}

/**
 * Fold one parsed transcript line's assistant usage into the shared per-model
 * cost map (Slice B state) — factored out so the SAME accumulation (and the
 * same `seenMessageIds` dedup set) can be applied to both the main transcript
 * and its subagent transcripts (see `foldSubagentCosts` below). No-ops for
 * anything that isn't a priced assistant usage line.
 */
function foldAssistantCostLine(
  data: Record<string, unknown>,
  modelTokens: Map<string, ModelTokenAgg>,
  seenMessageIds: Set<string>
): void {
  if (data.type !== 'assistant') return
  const message = data.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage) return

  const rawModel = typeof message?.model === 'string' ? (message.model as string) : undefined
  const normalizedModel = rawModel ? normalizeModelName(rawModel) : null
  if (!normalizedModel) return

  const messageId = typeof message?.id === 'string' ? (message.id as string) : ''
  if (messageId !== '' && seenMessageIds.has(messageId)) return
  if (messageId) seenMessageIds.add(messageId)

  const agg = modelTokens.get(normalizedModel) ?? {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheCreation1h: 0,
    cacheRead: 0
  }
  agg.input += (usage.input_tokens as number) || 0
  agg.output += (usage.output_tokens as number) || 0
  agg.cacheCreation += (usage.cache_creation_input_tokens as number) ?? 0
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined
  agg.cacheCreation1h += (cacheCreation?.ephemeral_1h_input_tokens as number) ?? 0
  agg.cacheRead += (usage.cache_read_input_tokens as number) ?? 0
  modelTokens.set(normalizedModel, agg)
}

/**
 * Stream one subagent transcript's assistant lines into the shared per-model
 * cost map. Cost-only — deliberately does NOT touch the legacy token sums,
 * context length, or turn-span duration accumulator (those are main-chain
 * semantics: context-window display and active session time).
 */
function foldSubagentFile(
  filePath: string,
  modelTokens: Map<string, ModelTokenAgg>,
  seenMessageIds: Set<string>
): Promise<void> {
  return new Promise((resolve) => {
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to open subagent transcript for cost scan', err)
      resolve()
      return
    }
    const rl = readline.createInterface({ input: stream })
    rl.on('line', (line) => {
      try {
        const data = JSON.parse(line)
        foldAssistantCostLine(data, modelTokens, seenMessageIds)
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to parse line in subagent cost scan', err)
      }
    })
    rl.on('close', () => resolve())
    rl.on('error', () => resolve())
  })
}

/**
 * Task-tool subagent transcripts are stored as SEPARATE files —
 * `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl` (alongside
 * `agent-<id>.meta.json` and a `tool-results/` dir) — not lines in the main
 * transcript, so the main streaming pass above never sees them. A session
 * that leans on subagents can have most of its actual spend live only in
 * these files, invisible to the per-model cost recompute. This folds them
 * into the SAME modelTokens map / seenMessageIds set used for the main file,
 * sequentially (a session can have dozens of agent files — no unbounded
 * fan-out).
 *
 * Not a double-count risk: the cost base this function feeds is seeded ONCE
 * at ClaudeSession construction (transcript state at that moment), and live
 * tracking during the running session comes from cli.js's own authoritative
 * `result.modelUsage`, which already covers everything the current process
 * — including its own subagent API calls — spends (see the modelCosts doc
 * comment below for the seam with live costBaseUsd/liveTotalCostUsd).
 */
async function foldSubagentCosts(
  filePath: string,
  modelTokens: Map<string, ModelTokenAgg>,
  seenMessageIds: Set<string>
): Promise<void> {
  const subagentsDir = path.join(
    path.dirname(filePath),
    path.basename(filePath, '.jsonl'),
    'subagents'
  )
  if (!fs.existsSync(subagentsDir)) return // common case — no subagents used

  let files: string[]
  try {
    files = fs.readdirSync(subagentsDir)
  } catch (err) {
    logger.warn('SessionHistory', 'Failed to read subagents directory', err)
    return
  }

  const agentFiles = files
    .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .sort()

  for (const f of agentFiles) {
    await foldSubagentFile(path.join(subagentsDir, f), modelTokens, seenMessageIds)
  }
}

export async function computeTokenMetrics(
  filePath: string,
  model?: string
): Promise<StatusLineData> {
  const empty: StatusLineData = {
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalApiDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    contextWindowSize: 0,
    usedPercentage: null,
    remainingPercentage: null,
    modelCosts: []
  }

  if (!fs.existsSync(filePath)) return empty

  return new Promise((resolve) => {
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let totalCostUsd = 0
    let totalApiDurationMs = 0
    let contextLength = 0

    // Track the most recent non-sidechain assistant for context length
    let mostRecentMainChainUsage: Record<string, number> | null = null
    // Authoritative model id for window sizing: the transcript records the
    // *resolved* id (e.g. "claude-opus-4-8"), so it disambiguates aliases like
    // "default" that the caller can't resolve. Latest main-chain wins.
    let transcriptModel: string | undefined
    // Incremental turn-span duration reconstruction — O(1) state, no line
    // retention (transcripts run tens of MB and this function re-reads the
    // whole file after every turn during reconciliation).
    const turnSpanAcc = createTurnSpanAccumulator()

    // Per-model cost reconstruction (Slice B): deduplicated by message id —
    // same semantic as block-usage.ts's scanAllJsonl (first occurrence of a
    // given message id wins). Unlike the legacy token sums above (unchanged,
    // not deduplicated), this map is used ONLY to derive modelCosts/totalCostUsd
    // via pricing-table math, so getting the dedup right here matters more.
    const modelTokens = new Map<string, ModelTokenAgg>()
    const seenMessageIds = new Set<string>()

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      try {
        const data = JSON.parse(line)
        turnSpanAcc.push(data)

        if (data.type === 'assistant' && data.message?.usage) {
          const usage = data.message.usage
          inputTokens += usage.input_tokens || 0
          outputTokens += usage.output_tokens || 0
          cachedTokens +=
            (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)

          if (data.isSidechain !== true && !data.isApiErrorMessage) {
            mostRecentMainChainUsage = usage
            if (typeof data.message.model === 'string') transcriptModel = data.message.model
          }

          foldAssistantCostLine(data, modelTokens, seenMessageIds)
        } else if (data.type === 'result') {
          // Real transcripts carry no `type: "result"` lines (verified across
          // 46 real transcripts), so this branch is dead in practice today.
          // Kept so a future CLI version that reintroduces result lines picks
          // the cost figure back up automatically (additive with the modelCosts
          // sum below — no realistic transcript has both). duration_ms is
          // deliberately NOT accumulated here — the turn-span accumulator
          // (above) is the sole source for the emitted totalDurationMs.
          totalCostUsd += (data.total_cost_usd as number) || 0
          totalApiDurationMs += (data.duration_api_ms as number) || 0
        }
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to parse line in computeTokenMetrics', err)
      }
    })

    rl.on('close', async () => {
      if (mostRecentMainChainUsage) {
        contextLength =
          (mostRecentMainChainUsage.input_tokens || 0) +
          (mostRecentMainChainUsage.cache_read_input_tokens ?? 0) +
          (mostRecentMainChainUsage.cache_creation_input_tokens ?? 0)
      }

      const totalTokens = inputTokens + outputTokens + cachedTokens
      // Prefer the transcript's resolved id over the caller-supplied alias.
      const effectiveModel = transcriptModel ?? model
      const ctxWindow = effectiveModel ? getContextWindowSize(effectiveModel) : 200_000
      const usedPercentage =
        contextLength > 0 ? Math.round((contextLength / ctxWindow) * 100) : null
      const remainingPercentage = usedPercentage !== null ? 100 - usedPercentage : null
      // Turn-span reconstruction is the sole source for totalDurationMs — see
      // the createTurnSpanAccumulator doc comment for why.
      const totalDurationMs = turnSpanAcc.total()

      // Per-model cost reconstruction: real Claude transcripts carry no cost
      // figure at all (see the dead `result` branch above), so this pricing-table
      // recompute is the effective source for both modelCosts and totalCostUsd.
      // Acceptable imprecision: this is pricing-table math against historical
      // tokens, while a live session's cost comes from cli.js's authoritative
      // costUSD (see claude-session.ts's costBaseUsd/liveTotalCostUsd seam).
      //
      // Task-tool subagent spend lives in separate transcript files (see
      // foldSubagentCosts's doc comment) — fold it into the same modelTokens
      // map before deriving modelCosts/totalCostUsd below.
      await foldSubagentCosts(filePath, modelTokens, seenMessageIds)

      const modelCosts: ModelCostEntry[] = []
      for (const [modelId, agg] of modelTokens) {
        const costUsd = calculateCostFromTokens(
          modelId,
          agg.input,
          agg.output,
          agg.cacheCreation,
          agg.cacheCreation1h,
          agg.cacheRead
        )
        modelCosts.push({ engineId: 'claude', modelId, costUsd })
        totalCostUsd += costUsd
      }

      resolve({
        totalCostUsd,
        totalDurationMs,
        totalApiDurationMs,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        cachedTokens,
        totalTokens,
        contextWindowSize: contextLength,
        usedPercentage,
        remainingPercentage,
        modelCosts
      })
    })

    rl.on('error', () => resolve(empty))
  })
}

/**
 * Scan ~/.claude/projects/ for session directories and build DirectoryGroup[].
 * Uses a disk-based metadata cache (~/.claude/ui/directory-cache.json) keyed by
 * file path + mtime. Only re-parses files whose mtime has changed.
 */
export async function listDirectories(): Promise<DirectoryGroup[]> {
  let projectDirs: string[]
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((name) => {
      const full = path.join(CLAUDE_PROJECTS_DIR, name)
      return fs.statSync(full).isDirectory()
    })
  } catch (err) {
    logger.warn('SessionHistory', 'Failed to read projects directory', err)
    return []
  }

  const cache = loadDiskCache()
  let cacheChanged = false

  const groups: DirectoryGroup[] = []

  for (const projectKey of projectDirs) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey)
    let jsonlFiles: string[]
    try {
      jsonlFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to read project directory', err)
      continue
    }

    if (jsonlFiles.length === 0) continue

    // Collect files that need re-parsing (cache miss or stale mtime)
    const fileEntries: { file: string; filePath: string; mtime: number; sessionId: string }[] = []
    const staleFiles: typeof fileEntries = []

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file)
      let mtime: number
      try {
        mtime = fs.statSync(filePath).mtimeMs
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to stat session file', err)
        continue
      }
      const sessionId = file.replace('.jsonl', '')
      const entry = { file, filePath, mtime, sessionId }
      fileEntries.push(entry)

      const cached = cache[filePath]
      if (!cached || cached.mtime !== mtime) {
        staleFiles.push(entry)
      }
    }

    // Parse stale files in parallel
    if (staleFiles.length > 0) {
      const results = await Promise.all(staleFiles.map((f) => parseSessionMeta(f.filePath)))
      for (let i = 0; i < staleFiles.length; i++) {
        const meta = results[i]
        const f = staleFiles[i]
        if (meta) {
          cache[f.filePath] = { mtime: f.mtime, ...meta }
        } else {
          // File had no parseable content — cache minimal entry
          cache[f.filePath] = {
            mtime: f.mtime,
            title: 'Untitled',
            cwd: '',
            timestamp: f.mtime,
            customTitle: null,
            aiTitle: null,
            summary: null,
            hasConversation: false
          }
        }
        cacheChanged = true
      }
    }

    // Build sessions from cache
    const sessions: SessionInfo[] = []
    let groupCwd = ''

    for (const f of fileEntries) {
      const meta = cache[f.filePath]
      if (!meta) continue

      // Skip sessions with no user or assistant messages
      if (meta.hasConversation === false) continue

      if (!groupCwd && meta.cwd) groupCwd = meta.cwd

      // Priority: custom-title (user override) > ai-title (cli.js auto) > summary (compact) > first user prompt title
      const displayTitle =
        meta.customTitle || meta.aiTitle || meta.summary || meta.title || 'Untitled'

      sessions.push({
        sessionId: f.sessionId,
        cwd: meta.cwd || '',
        projectKey,
        title: displayTitle,
        timestamp: meta.timestamp || f.mtime,
        lastActivityAt: f.mtime,
        aiTitle: meta.aiTitle || null,
        engineId: 'claude'
      })
    }

    if (sessions.length === 0) continue

    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)

    const folderName = groupCwd ? groupCwd.split(/[\\/]/).pop() || groupCwd : projectKey

    groups.push({
      cwd: groupCwd,
      projectKey,
      folderName,
      sessions
    })
  }

  // Persist cache if anything changed
  if (cacheChanged) {
    saveDiskCache(cache)
  }

  groups.sort((a, b) => {
    const aMax = a.sessions[0]?.lastActivityAt || 0
    const bMax = b.sessions[0]?.lastActivityAt || 0
    return bMax - aMax
  })

  return groups
}

// ─── Unified single-pass JSONL metadata parser ───────────────────────────────

interface SessionMeta {
  title: string
  cwd: string
  timestamp: number
  customTitle: string | null
  aiTitle: string | null
  summary: string | null
  hasConversation: boolean
}

/**
 * Parse a JSONL file in a single streaming pass, extracting:
 * - title: first external user prompt (first 80 chars)
 * - cwd & timestamp from that first prompt
 * - customTitle: last `type: "custom-title"` entry
 * - aiTitle: last `type: "ai-title"` entry (cli.js auto-generated)
 * - summary: last `type: "summary"` entry
 */
function parseSessionMeta(filePath: string): Promise<SessionMeta | null> {
  return new Promise((resolve) => {
    let title: string | null = null
    let cwd = ''
    let timestamp = 0
    let customTitle: string | null = null
    let aiTitle: string | null = null
    let summary: string | null = null
    let foundHeader = false
    let hasConversation = false

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      // Quick-skip empty lines
      if (!line) return

      try {
        // Fast pre-checks to avoid JSON.parse on irrelevant lines
        const hasCustomTitle = line.includes('"custom-title"')
        const hasAiTitle = line.includes('"ai-title"')
        const hasSummary = line.includes('"summary"')
        const hasUser = !foundHeader && line.includes('"user"')
        const hasAssistant = !hasConversation && line.includes('"assistant"')

        if (!hasCustomTitle && !hasAiTitle && !hasSummary && !hasUser && !hasAssistant) return

        const obj = JSON.parse(line)

        // Track whether this session has any real user or assistant messages
        if (!hasConversation) {
          if (obj.type === 'assistant' && obj.message?.content && !obj.isMeta) {
            hasConversation = true
          } else if (
            obj.type === 'user' &&
            obj.userType === 'external' &&
            obj.message?.content &&
            !obj.isMeta
          ) {
            hasConversation = true
          }
        }

        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
          customTitle = obj.customTitle
        } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle) {
          aiTitle = obj.aiTitle
        } else if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary) {
          summary = obj.summary
        } else if (
          !foundHeader &&
          obj.type === 'user' &&
          obj.userType === 'external' &&
          !obj.isMeta &&
          obj.message?.content
        ) {
          const content = obj.message.content
          let text = ''
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
            if (textBlock) text = textBlock.text as string
          }

          if (text) {
            title = text.slice(0, 80).replace(/\n/g, ' ').trim()
            timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            cwd = obj.cwd || ''
            foundHeader = true
          }
        }
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to parse line in parseSessionMeta', err)
      }
    })

    rl.on('close', () => {
      if (!title && !customTitle && !aiTitle && !summary) {
        resolve(null)
        return
      }
      resolve({
        title: title || 'Untitled',
        cwd,
        timestamp: timestamp || Date.now(),
        customTitle,
        aiTitle,
        summary,
        hasConversation
      })
    })

    rl.on('error', () => resolve(null))
  })
}

export interface SessionHistoryResult {
  messages: ChatMessage[]
  taskNotifications: TaskNotification[]
  customTitle: string | null
  statusLine: StatusLineData | null
  /** Maps agentId → toolUseId for subagent JSONL lookup */
  agentIdToToolUseId: Record<string, string>
  /**
   * Warnings worth resurfacing when the session is reopened — currently the
   * model_refusal_fallback / model_fallback system entries (the model swap is
   * sticky for the session, so the user should know which model answered).
   */
  warnings: string[]
}

/**
 * Render text for a `fallback` content block — the canonical-replacement frame
 * cli.js emits when a refused partial is retracted and the turn retried on a
 * fallback model (docs/protocol/04-system-subtypes.md §4.20). Live sessions
 * normally evict the whole message via retracted_message_uuids; this text is
 * the fallback rendering when the frame survives (history, older CLIs).
 */
export function fallbackBlockText(block: Record<string, unknown>): string {
  const from = (block.from as Record<string, unknown> | undefined)?.model
  const to = (block.to as Record<string, unknown> | undefined)?.model
  return `Switched models${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}.`
}

/**
 * Parse task-notification XML from JSONL content strings.
 * Returns null if no task notification found.
 */
function parseTaskNotificationXml(
  text: string
): Omit<TaskNotification, 'toolUseId' | 'outputFile'> | null {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)
  if (!match) return null

  const xml = match[1]
  const get = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }

  const taskId = get('task-id')
  const status = get('status') as 'completed' | 'failed' | 'stopped'
  const summary = get('summary')

  // Parse usage block if present
  const usageStr = get('usage')
  let usage: TaskNotification['usage'] | undefined
  if (usageStr) {
    const getNum = (key: string): number => {
      const m = usageStr.match(new RegExp(`${key}:\\s*(\\d+)`))
      return m ? Number(m[1]) : 0
    }
    usage = {
      totalTokens: getNum('total_tokens'),
      toolUses: getNum('tool_uses'),
      durationMs: getNum('duration_ms')
    }
  }

  if (!taskId || !status) return null
  return { taskId, status, summary, usage }
}

/** Parse CLI command XML into structured data */
function parseCliCommand(
  text: string
): { commandName: string; commandArgs?: string; commandOutput?: string } | null {
  // Format 1: <command-name>X</command-name><command-message>Y</command-message><command-args>Z</command-args>
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (nameMatch) {
    const commandName = nameMatch[1].trim()
    const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    return {
      commandName,
      commandArgs: argsMatch ? argsMatch[1].trim() : undefined
    }
  }
  // Format 2: <local-command-stdout>X</local-command-stdout> or <local-command-caveat>...
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
  const stderrMatch = text.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)
  if (stdoutMatch || stderrMatch) {
    const output =
      (stdoutMatch?.[1] || '') + (stderrMatch ? (stdoutMatch ? '\n' : '') + stderrMatch[1] : '')
    return {
      commandName: 'output',
      commandOutput: output.trim() || undefined
    }
  }
  // local-command-caveat — skip, just noise
  if (text.includes('<local-command-caveat>')) return null
  return null
}

/** Extract <output-file> path from task-notification XML */
function extractOutputFile(text: string): string {
  const m = text.match(/<output-file>([\s\S]*?)<\/output-file>/)
  return m ? m[1].trim() : ''
}

/**
 * Resolve the JSONL line `uuid` to pass to cli.js `--resume-session-at` when
 * forking ("branching") a new session from an assistant message.
 *
 * cli.js truncates the resumed transcript to `messages.slice(0, w + 1)` where
 * `w` is the index of the line whose `uuid === <anchor>` — everything after is
 * dropped (no summarization). If we anchored on the bare assistant line and it
 * had issued tool calls, the following `tool_result` lines would be sliced off,
 * leaving a dangling `tool_use` → the API rejects the next turn with a 400.
 *
 * So we anchor at the LAST line of the target assistant turn: the assistant
 * line itself when it issued no tools, otherwise the last trailing
 * `tool_result` user-line that resolves its tool_uses (stopping at the next
 * assistant turn). The resulting prefix is always tool-cycle balanced.
 *
 * `messageId` is the renderer's `ChatMessage.id`, which for assistant messages
 * is the `betaMessage.id` (`msg_xxx`); we also accept a raw line uuid as a
 * fallback. The matching itself is against the JSONL line `uuid`, never the
 * `msg_xxx` id (verified against cli.js's truncation: `j.uuid === resumeSessionAt`).
 *
 * Engine-dispatched (ADR-030/033-style split): pi has no stable id to match
 * `messageId` against at all (a live assistant `ChatMessage.id` is a
 * synthesized uuid, never persisted — see `findPiForkAnchorEntryId`'s doc
 * comment in fork-anchor.ts), so its resolution is POSITION-based via
 * `messageIndex` instead, delegated wholesale to `resolvePiForkAnchor`
 * (pi-session-list.ts). The Claude branch below is UNCHANGED from before this
 * dispatch existed — `messageIndex` is simply unused on that path.
 */
export async function resolveForkAnchor(
  sessionId: string,
  cwd: string,
  messageId: string,
  engineId: EngineId,
  messageIndex: number
): Promise<ForkAnchorResult> {
  if (engineId === 'pi') return resolvePiForkAnchor(sessionId, messageIndex)

  const projectKey = cwdToProjectKey(cwd)
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)
  if (!fs.existsSync(filePath)) return { anchorUuid: null, reason: 'transcript-not-found' }

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { anchorUuid: null, reason: 'read-failed' }
  }

  const lines: Array<Record<string, unknown>> = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      lines.push(JSON.parse(t))
    } catch {
      /* skip malformed lines */
    }
  }

  const anchorUuid = findForkAnchorUuid(lines, messageId)
  return anchorUuid ? { anchorUuid } : { anchorUuid: null, reason: 'message-not-found' }
}

/**
 * Load full conversation history from a JSONL session file.
 * Converts SDK messages to ChatMessage[] and extracts TaskNotification[].
 */
export async function loadSessionHistory(
  sessionId: string,
  projectKey: string
): Promise<SessionHistoryResult> {
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)

  return new Promise((resolve) => {
    const messages: ChatMessage[] = []
    const taskNotifications: TaskNotification[] = []
    const warnings: string[] = []
    let customTitle: string | null = null
    // Map agentId (from task-notification <task-id>) → toolUseId (from Task tool_use)
    const agentIdToToolUseId: Record<string, string> = {}

    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to open session history file', err)
      resolve({
        messages: [],
        taskNotifications: [],
        customTitle: null,
        agentIdToToolUseId: {},
        statusLine: null,
        warnings: []
      })
      return
    }

    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line)
        const type = obj.type as string

        if (type === 'custom-title') {
          if (typeof obj.customTitle === 'string') customTitle = obj.customTitle
          return
        }

        if (type === 'user') {
          const content = obj.message?.content
          if (!content) return

          // Meta messages (skill context injections, system reminders) are not human input.
          // Drop unless they carry tool_result blocks, which are real conversation data.
          const hasMetaToolResult =
            Array.isArray(content) &&
            content.some((b: Record<string, unknown>) => b.type === 'tool_result')
          if (obj.isMeta && !hasMetaToolResult) return

          // Compact summary — attach text to the preceding compact_separator
          if (obj.isCompactSummary) {
            const text = typeof content === 'string' ? content : ''
            // Find the last compact_separator message and attach the summary
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i]
              if (m.role === 'system' && m.content[0]?.type === 'compact_separator') {
                messages[i] = { ...m, content: [{ type: 'compact_separator', text }] }
                break
              }
            }
            return
          }

          const userType = obj.userType as string | undefined
          const isArray = Array.isArray(content)
          const isString = typeof content === 'string'

          // String content — can be user prompt, task-notification, or command
          if (isString) {
            const text = content as string
            // Task notification
            const notif = parseTaskNotificationXml(text)
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({ ...notif, toolUseId, outputFile: extractOutputFile(text) })
              return
            }
            // CLI commands — parse and emit as cli_command block
            if (text.startsWith('<command-name>') || text.startsWith('<local-command')) {
              const cmd = parseCliCommand(text)
              if (cmd) {
                messages.push({
                  id: obj.uuid || `cmd-${messages.length}`,
                  role: 'system',
                  content: [{ type: 'cli_command', ...cmd }],
                  timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
                })
              }
              return
            }
            // Regular user prompt
            if (userType === 'external' && text.trim()) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                ...(obj.planContent ? { planContent: obj.planContent as string } : {})
              })
            }
            return
          }

          if (!isArray) return

          // Array content — check block types
          const hasTextBlock = content.some((b: Record<string, unknown>) => b.type === 'text')
          const hasToolResult = content.some(
            (b: Record<string, unknown>) => b.type === 'tool_result'
          )

          // External user prompt with text blocks
          if (userType === 'external' && hasTextBlock) {
            const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
            const text = textBlock ? (textBlock.text as string) : ''

            // Check if text is actually a task notification
            const notif = text ? parseTaskNotificationXml(text) : null
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({ ...notif, toolUseId, outputFile: extractOutputFile(text) })
            } else if (
              text &&
              (text.startsWith('<command-name>') || text.startsWith('<local-command'))
            ) {
              const cmd = parseCliCommand(text)
              if (cmd) {
                messages.push({
                  id: obj.uuid || `cmd-${messages.length}`,
                  role: 'system',
                  content: [{ type: 'cli_command', ...cmd }],
                  timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
                })
              }
            } else if (text) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                ...(obj.planContent ? { planContent: obj.planContent as string } : {})
              })
            }
          }

          // Tool results — attach to preceding assistant message
          if (hasToolResult) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                let resultText = ''
                if (typeof block.content === 'string') {
                  resultText = block.content
                } else if (Array.isArray(block.content)) {
                  resultText = block.content
                    .map((c: Record<string, unknown>) => (c.text as string) || '')
                    .join('\n')
                }

                // Extract agentId from Task tool results for mapping
                const agentMatch = resultText.match(/(?:agentId|agent_id):\s*(\S+)/)
                if (agentMatch) {
                  agentIdToToolUseId[agentMatch[1]] = block.tool_use_id
                }

                // Find last assistant message with matching tool_use
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]
                  if (msg.role !== 'assistant') continue
                  const hasToolUse = msg.content.some(
                    (b) => b.type === 'tool_use' && b.toolUseId === block.tool_use_id
                  )
                  if (hasToolUse) {
                    messages[i] = {
                      ...msg,
                      content: [
                        ...msg.content,
                        {
                          type: 'tool_result',
                          toolUseId: block.tool_use_id,
                          toolResult: resultText,
                          isError: !!block.is_error
                        }
                      ]
                    }
                    break
                  }
                }
              }
            }
          }
        } else if (type === 'assistant') {
          // API error messages (rate_limit, invalid_request, etc.)
          if (obj.isApiErrorMessage || obj.error) {
            messages.push({
              id: obj.uuid || `error-${messages.length}`,
              role: 'system',
              content: [
                {
                  type: 'api_error',
                  errorType: (obj.error as string) || 'unknown',
                  errorMessage: obj.message
                    ? typeof obj.message === 'string'
                      ? obj.message
                      : JSON.stringify(obj.message)
                    : (obj.error as string) || 'API error'
                }
              ],
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            })
            return
          }

          const betaMessage = obj.message as Record<string, unknown> | undefined
          if (!betaMessage?.content || !Array.isArray(betaMessage.content)) return

          const blocks: ContentBlock[] = (
            betaMessage.content as Array<Record<string, unknown>>
          ).map((block) => {
            const blockType = block.type as string
            if (blockType === 'text') {
              return { type: 'text' as const, text: block.text as string }
            } else if (blockType === 'tool_use') {
              return {
                type: 'tool_use' as const,
                toolName: block.name as string,
                toolInput: block.input as Record<string, unknown>,
                toolUseId: block.id as string
              }
            } else if (blockType === 'tool_result') {
              const resultContent = block.content
              let text = ''
              if (typeof resultContent === 'string') {
                text = resultContent
              } else if (Array.isArray(resultContent)) {
                text = resultContent
                  .map((c: Record<string, unknown>) => (c.text as string) || '')
                  .join('\n')
              }
              return {
                type: 'tool_result' as const,
                toolUseId: block.tool_use_id as string,
                toolResult: text,
                isError: block.is_error as boolean
              }
            } else if (blockType === 'thinking') {
              return { type: 'thinking' as const, text: block.thinking as string }
            } else if (blockType === 'fallback') {
              return { type: 'text' as const, text: fallbackBlockText(block) }
            }
            return { type: 'text' as const, text: JSON.stringify(block) }
          })

          const messageId =
            (betaMessage.id as string) || (obj.uuid as string) || `assistant-${messages.length}`

          // Upsert by ID (partial messages share the same betaMessage.id)
          const existingIdx = messages.findIndex((m) => m.id === messageId)
          const chatMsg: ChatMessage = {
            id: messageId,
            role: 'assistant',
            content: blocks,
            timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
          }

          if (existingIdx >= 0) {
            // Merge: preserve old blocks not present in the new update
            const oldBlocks = messages[existingIdx].content
            const newToolUseIds = new Set(
              blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
                )
                .map((b) => b.toolUseId)
            )
            const newToolResultIds = new Set(
              blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
                    b.type === 'tool_result'
                )
                .map((b) => b.toolUseId)
            )
            const newHasText = blocks.some((b) => b.type === 'text')
            const newHasThinking = blocks.some((b) => b.type === 'thinking')
            const preserved = oldBlocks.filter((b) => {
              if (b.type === 'tool_use' && b.toolUseId && !newToolUseIds.has(b.toolUseId))
                return true
              if (b.type === 'tool_result' && b.toolUseId && !newToolResultIds.has(b.toolUseId))
                return true
              if (b.type === 'text' && !newHasText) return true
              if (b.type === 'thinking' && !newHasThinking) return true
              return false
            })
            messages[existingIdx] = { ...chatMsg, content: [...preserved, ...blocks] }
          } else {
            messages.push(chatMsg)
          }
        } else if (type === 'queue-operation') {
          // Task notifications can appear as queue-operation entries
          const content = obj.content as string | undefined
          if (content) {
            const notif = parseTaskNotificationXml(content)
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({
                ...notif,
                toolUseId,
                outputFile: extractOutputFile(content)
              })
            }
          }
        } else if (type === 'system') {
          const subtype = obj.subtype as string | undefined
          if (subtype === 'compact_boundary') {
            messages.push({
              id: obj.uuid || `compact-${messages.length}`,
              role: 'system',
              content: [{ type: 'compact_separator' }],
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            })
          } else if (subtype === 'model_refusal_fallback' || subtype === 'model_fallback') {
            // Transcript form uses camelCase (originalModel/fallbackModel) and
            // carries the CLI's human-readable content. Resurface as a warning
            // since the refusal swap is sticky for the session.
            const text =
              (obj.content as string) ||
              `Switched models${obj.originalModel ? ` from ${obj.originalModel}` : ''}${obj.fallbackModel ? ` to ${obj.fallbackModel}` : ''}.`
            warnings.push(text)
          }
        }
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to parse line in loadSessionHistory', err)
      }
    })

    rl.on('close', async () => {
      const statusLine = await computeTokenMetrics(filePath)
      // Slice C — merge durable dispatched-cost rows into the history-loaded
      // status line. A reopened session that hasn't spawned a ClaudeSession
      // yet has no seedDispatchedCosts() run for it, and computeTokenMetrics
      // only knows the transcript — without this merge the tooltip would show
      // dispatched spend only after the first prompt. Best-effort: a DB
      // failure must never break history loading.
      try {
        const dispatched = dispatchedCostsByRouting(sessionId)
        if (dispatched.length > 0) {
          statusLine.modelCosts = [
            ...(statusLine.modelCosts ?? []),
            ...dispatched.map((d) => ({
              engineId: d.targetEngine as EngineId,
              modelId: d.targetModel,
              costUsd: d.costUsd,
              dispatched: true as const
            }))
          ]
        }
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to merge dispatched costs into status line', err)
      }
      resolve({
        messages,
        taskNotifications,
        customTitle,
        agentIdToToolUseId,
        statusLine,
        warnings
      })
    })
    rl.on('error', () =>
      resolve({
        messages: [],
        taskNotifications: [],
        customTitle: null,
        agentIdToToolUseId: {},
        statusLine: null,
        warnings: []
      })
    )
  })
}

/**
 * Load subagent conversation history from disk.
 * Subagent JSONL files are at: ~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.jsonl
 */
export async function loadSubagentHistory(
  sessionId: string,
  projectKey: string,
  agentId: string
): Promise<ChatMessage[]> {
  const filePath = path.join(
    CLAUDE_PROJECTS_DIR,
    projectKey,
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`
  )

  if (!fs.existsSync(filePath)) return []
  return parseJsonlFile(filePath)
}

/**
 * Build a mapping from toolUseId → hex JSONL filename for subagents.
 * Scans all subagent files and matches them to toolUseIds by comparing the
 * first user message content against known task prompts.
 * Returns toolUseId → hexId for files that matched, preferring the most recent
 * file (highest hex ID) when multiple files match the same prompt.
 */
export function buildSubagentFileMap(
  sessionId: string,
  projectKey: string,
  taskPrompts: Record<string, string>
): Record<string, string> {
  const subagentDir = path.join(CLAUDE_PROJECTS_DIR, projectKey, sessionId, 'subagents')
  if (!fs.existsSync(subagentDir)) return {}

  const files = fs
    .readdirSync(subagentDir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .sort() // alphabetical = chronological for hex IDs

  const promptEntries = Object.entries(taskPrompts)
  if (promptEntries.length === 0) return {}

  // For each file, read the first user message and try to match against known prompts
  const result: Record<string, string> = {}
  for (const fname of files) {
    const hexId = fname.replace('agent-', '').replace('.jsonl', '')
    try {
      const filePath = path.join(subagentDir, fname)
      const content = fs.readFileSync(filePath, 'utf-8')
      const firstNewline = content.indexOf('\n')
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content
      const obj = JSON.parse(firstLine)
      const msg = obj.message as Record<string, unknown> | undefined
      if (!msg) continue
      const msgContent = msg.content
      let text = ''
      if (typeof msgContent === 'string') {
        text = msgContent
      } else if (Array.isArray(msgContent)) {
        for (const b of msgContent) {
          if (typeof b === 'object' && b && 'text' in b) text += (b as Record<string, unknown>).text
        }
      }
      if (!text) continue

      // Match against known prompts (use first 80 chars for matching to avoid false positives)
      for (const [toolUseId, prompt] of promptEntries) {
        const matchStr = prompt.slice(0, 80)
        if (text.includes(matchStr)) {
          // Later files (higher hex IDs) overwrite earlier ones — keeps the most recent
          result[toolUseId] = hexId
        }
      }
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to parse subagent file in buildSubagentFileMap', err)
    }
  }
  return result
}

/**
 * Load background bash task output from /tmp.
 */
/**
 * Load background bash task output.
 * Tries outputFile (from task-notification) first, falls back to path interpolation.
 */
export function loadBackgroundOutput(
  projectKey: string,
  taskId: string,
  outputFile?: string
): { content: string | null; purged: boolean } {
  // Try the explicit output file path first (from task-notification XML)
  if (outputFile && fs.existsSync(outputFile)) {
    try {
      const content = fs.readFileSync(outputFile, 'utf-8')
      return { content, purged: false }
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to read background output file', err)
    }
  }

  // Fallback: interpolate path
  const uid = process.getuid?.() ?? 0
  const outputPath = path.join(
    '/private/tmp',
    `claude-${uid}`,
    projectKey,
    'tasks',
    `${taskId}.output`
  )

  if (!fs.existsSync(outputPath)) {
    return { content: null, purged: true }
  }

  try {
    const content = fs.readFileSync(outputPath, 'utf-8')
    return { content, purged: false }
  } catch (err) {
    logger.warn('SessionHistory', 'Failed to read interpolated background output file', err)
    return { content: null, purged: true }
  }
}

/**
 * Parse a JSONL file into ChatMessage[] (shared logic for main session and subagents).
 */
async function parseJsonlFile(filePath: string): Promise<ChatMessage[]> {
  return new Promise((resolve) => {
    const messages: ChatMessage[] = []

    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    } catch (err) {
      logger.warn('SessionHistory', 'Failed to open JSONL file', err)
      resolve([])
      return
    }

    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line)
        const type = obj.type as string

        if (type === 'user') {
          const content = obj.message?.content
          if (!content) return
          const userType = obj.userType as string | undefined
          const isArray = Array.isArray(content)
          const hasTextBlock = isArray
            ? content.some((b: Record<string, unknown>) => b.type === 'text')
            : typeof content === 'string'
          const hasToolResult =
            isArray && content.some((b: Record<string, unknown>) => b.type === 'tool_result')

          if (userType === 'external' && hasTextBlock) {
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (isArray) {
              const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
              if (textBlock) text = textBlock.text as string
            }
            if (text && !parseTaskNotificationXml(text)) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
              })
            }
          }

          if (hasToolResult && isArray) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                let resultText = ''
                if (typeof block.content === 'string') {
                  resultText = block.content
                } else if (Array.isArray(block.content)) {
                  resultText = block.content
                    .map((c: Record<string, unknown>) => (c.text as string) || '')
                    .join('\n')
                }
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]
                  if (msg.role !== 'assistant') continue
                  if (
                    msg.content.some(
                      (b) => b.type === 'tool_use' && b.toolUseId === block.tool_use_id
                    )
                  ) {
                    messages[i] = {
                      ...msg,
                      content: [
                        ...msg.content,
                        {
                          type: 'tool_result',
                          toolUseId: block.tool_use_id,
                          toolResult: resultText,
                          isError: !!block.is_error
                        }
                      ]
                    }
                    break
                  }
                }
              }
            }
          }
        } else if (type === 'assistant') {
          const betaMessage = obj.message as Record<string, unknown> | undefined
          if (!betaMessage?.content || !Array.isArray(betaMessage.content)) return

          const blocks: ContentBlock[] = (
            betaMessage.content as Array<Record<string, unknown>>
          ).map((block) => {
            const blockType = block.type as string
            if (blockType === 'text') return { type: 'text' as const, text: block.text as string }
            if (blockType === 'tool_use')
              return {
                type: 'tool_use' as const,
                toolName: block.name as string,
                toolInput: block.input as Record<string, unknown>,
                toolUseId: block.id as string
              }
            if (blockType === 'tool_result') {
              const rc = block.content
              let text = ''
              if (typeof rc === 'string') text = rc
              else if (Array.isArray(rc))
                text = rc.map((c: Record<string, unknown>) => (c.text as string) || '').join('\n')
              return {
                type: 'tool_result' as const,
                toolUseId: block.tool_use_id as string,
                toolResult: text,
                isError: block.is_error as boolean
              }
            }
            if (blockType === 'thinking')
              return { type: 'thinking' as const, text: block.thinking as string }
            return { type: 'text' as const, text: JSON.stringify(block) }
          })

          const messageId =
            (betaMessage.id as string) || (obj.uuid as string) || `assistant-${messages.length}`
          const existingIdx = messages.findIndex((m) => m.id === messageId)
          const chatMsg: ChatMessage = {
            id: messageId,
            role: 'assistant',
            content: blocks,
            timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
          }
          if (existingIdx >= 0) {
            const oldBlocks = messages[existingIdx].content
            const newToolUseIds = new Set(
              blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
                )
                .map((b) => b.toolUseId)
            )
            const newToolResultIds = new Set(
              blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
                    b.type === 'tool_result'
                )
                .map((b) => b.toolUseId)
            )
            const newHasText = blocks.some((b) => b.type === 'text')
            const newHasThinking = blocks.some((b) => b.type === 'thinking')
            const preserved = oldBlocks.filter((b) => {
              if (b.type === 'tool_use' && b.toolUseId && !newToolUseIds.has(b.toolUseId))
                return true
              if (b.type === 'tool_result' && b.toolUseId && !newToolResultIds.has(b.toolUseId))
                return true
              if (b.type === 'text' && !newHasText) return true
              if (b.type === 'thinking' && !newHasThinking) return true
              return false
            })
            messages[existingIdx] = { ...chatMsg, content: [...preserved, ...blocks] }
          } else {
            messages.push(chatMsg)
          }
        }
      } catch (err) {
        logger.warn('SessionHistory', 'Failed to parse line in parseJsonlFile', err)
      }
    })

    rl.on('close', () => resolve(messages))
    rl.on('error', () => resolve([]))
  })
}
