/**
 * Codex session scanner.
 *
 * Walks CODEX_HOME/sessions/**\/rollout-*.jsonl, parses the first-line
 * session_meta record, and returns SessionInfo[] (with provider:'codex').
 *
 * Mirrors the disk-cache pattern from session-history.ts: entries are keyed
 * by filePath+mtime so unchanged rollout files are never re-read.
 *
 * Pure FS reads — does NOT spawn codex app-server.
 *
 * Rollout file shape (verified against real ~/.codex data):
 *   - Line 0: {"type":"session_meta","payload":{"id","timestamp","cwd",...}}
 *     The first line is LARGE (8KB–27KB) because payload.base_instructions
 *     embeds the full Codex system prompt. We MUST read it via a line stream,
 *     not a fixed-size buffer.
 *   - The human prompt is an event_msg record:
 *     {"type":"event_msg","payload":{"type":"user_message","message":"<text>"}}
 *     The first such record can sit deep in the file (13KB–71KB in), so title
 *     extraction streams up to MAX_TITLE_LINES lines.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as readline from 'node:readline'
import type { SessionInfo } from '../../shared/types'
import { logger } from '../services/logger'

// ─── CODEX_HOME resolution ───────────────────────────────────────────────────

/** Resolve CODEX_HOME: env var wins, else ~/.codex */
function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

// ─── session_meta parse ──────────────────────────────────────────────────────

interface SessionMetaPayload {
  id: string
  timestamp: string
  cwd: string
  model_provider?: string
}

interface SessionMetaLine {
  type: 'session_meta'
  payload: SessionMetaPayload
}

/**
 * Parse the session_meta record from the first line of a rollout JSONL file
 * using a readline stream. The first line embeds the full system prompt and
 * can be 8KB–27KB+, so a fixed-size buffer read would truncate it and the
 * subsequent JSON.parse would throw. readline handles arbitrarily long lines.
 * Returns null on any failure (missing file, empty, non-session_meta, no cwd).
 */
export async function parseRolloutMetaAsync(filePath: string): Promise<{
  sessionId: string
  cwd: string
  timestamp: number
} | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (
      value: { sessionId: string; cwd: string; timestamp: number } | null
    ): void => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: stream })
      rl.on('line', (line) => {
        if (done) return
        // Only the first line matters. Parse and resolve FIRST, then tear down.
        // rl.close() synchronously emits 'close', and the close handler would
        // otherwise win the race and resolve(null) before this body finishes.
        const trimmed = line.trim()
        let result: { sessionId: string; cwd: string; timestamp: number } | null = null
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed) as SessionMetaLine
            if (parsed.type === 'session_meta') {
              const p = parsed.payload
              if (p && typeof p.id === 'string' && p.cwd) {
                const ts = p.timestamp ? new Date(p.timestamp).getTime() : 0
                result = { sessionId: p.id, cwd: p.cwd, timestamp: isNaN(ts) ? 0 : ts }
              }
            }
          } catch {
            result = null
          }
        }
        finish(result) // sets done=true; the subsequent 'close' is a no-op
        rl.close()
        stream.destroy()
      })
      rl.on('close', () => finish(null))
      rl.on('error', () => finish(null))
      stream.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

/** Max lines to scan when hunting for the first user_message event. The first
 *  human prompt can sit 13KB–71KB into the file (after the system prompt, env
 *  context, AGENTS.md injection, and the model's first reasoning/tool turns),
 *  so we need a generous line budget rather than a byte window. */
const MAX_TITLE_LINES = 400

/**
 * Stream a rollout file and extract a human-readable title from the first
 * `event_msg` record whose payload type is `user_message` (the clean human
 * prompt — distinct from the injected developer/environment context that
 * appears as `response_item` user messages). Returns the first 80 chars, or
 * null if none found within MAX_TITLE_LINES. Never throws.
 */
export async function extractFirstUserText(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    let lineCount = 0
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: stream })
      rl.on('line', (line) => {
        if (done) return
        lineCount++
        if (lineCount > MAX_TITLE_LINES) {
          // finish FIRST — rl.close() synchronously emits 'close', whose handler
          // would otherwise resolve(null) and lose this (also null, but the
          // ordering matters for the found-message path below).
          finish(null)
          rl.close()
          stream.destroy()
          return
        }
        // Fast pre-check: skip the heavy JSON.parse unless this line carries a
        // user message. Both markers must be present in a real user_message line.
        if (!line.includes('"event_msg"') || !line.includes('"user_message"')) return
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }
        if (obj.type !== 'event_msg') return
        const payload = obj.payload as Record<string, unknown> | undefined
        if (!payload || payload.type !== 'user_message') return
        const message = payload.message
        if (typeof message === 'string' && message.trim()) {
          // Resolve with the title BEFORE teardown (see race note above).
          finish(message.slice(0, 80).replace(/\s+/g, ' ').trim())
          rl.close()
          stream.destroy()
        }
      })
      rl.on('close', () => finish(null))
      rl.on('error', () => finish(null))
      stream.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

// ─── disk cache (mirrors session-history.ts pattern) ─────────────────────────

const CODEX_CACHE_SCHEMA_VERSION = 1

/**
 * Cache-file path override, set by `setCodexCacheFileForTesting`. When non-null
 * it fully replaces the default `~/.claude/ui/codex-sessions-cache.json`,
 * keeping tests (and any sandboxed/integration context) off real home state.
 * Production never sets this — the getter below falls through to the real path.
 */
let codexCacheFileOverride: string | null = null

/**
 * Resolve the codex sessions cache file path. Precedence:
 *   1. explicit test override (setCodexCacheFileForTesting)
 *   2. CLAUDEUI_CODEX_CACHE_FILE env var (subprocess/integration contexts)
 *   3. default ~/.claude/ui/codex-sessions-cache.json
 *
 * Resolved per-call (not at module load) so an override applied after import
 * still takes effect — matching how vitest can set env vars before a test.
 */
function getCodexCacheFile(): string {
  if (codexCacheFileOverride) return codexCacheFileOverride
  const envOverride = process.env.CLAUDEUI_CODEX_CACHE_FILE
  if (envOverride) return envOverride
  return path.join(os.homedir(), '.claude', 'ui', 'codex-sessions-cache.json')
}

/**
 * Redirect the codex sessions cache file to `filePath` (tests only). Pass null
 * to restore the default. Tests MUST call this in beforeEach/afterEach so they
 * never read or write the real `~/.claude/ui/codex-sessions-cache.json`.
 */
export function setCodexCacheFileForTesting(filePath: string | null): void {
  codexCacheFileOverride = filePath
}

interface CodexCachedEntry {
  mtime: number
  sessionId: string
  cwd: string
  timestamp: number
  title: string
}

interface CodexCacheFile {
  version: number
  entries: Record<string, CodexCachedEntry>
}

type CodexDiskCache = Record<string, CodexCachedEntry>

function loadCodexDiskCache(): CodexDiskCache {
  const cacheFile = getCodexCacheFile()
  try {
    if (!fs.existsSync(cacheFile)) return {}
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as CodexCacheFile
    if (raw.version === CODEX_CACHE_SCHEMA_VERSION) return raw.entries
    return {}
  } catch (err) {
    logger.warn('CodexSessions', 'Failed to load codex disk cache', err)
    return {}
  }
}

function saveCodexDiskCache(cache: CodexDiskCache): void {
  const cacheFile = getCodexCacheFile()
  try {
    const cacheDir = path.dirname(cacheFile)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    }
    const file: CodexCacheFile = { version: CODEX_CACHE_SCHEMA_VERSION, entries: cache }
    fs.writeFileSync(cacheFile, JSON.stringify(file), { mode: 0o600 })
  } catch (err) {
    logger.warn('CodexSessions', 'Failed to save codex disk cache', err)
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Build a time/cwd fallback label when no user message can be extracted. */
function fallbackTitle(timestamp: number, mtime: number): string {
  const when = new Date(timestamp || mtime)
  const stamp = when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `Codex ${stamp}`
}

/**
 * Scan CODEX_HOME/sessions for all rollout-*.jsonl files and return a
 * SessionInfo[] with provider:'codex'. Returns [] when CODEX_HOME/sessions
 * does not exist (Codex not installed / never used).
 *
 * Results are suitable for merging into DirectoryGroup[] by cwd.
 */
export async function listCodexSessions(): Promise<SessionInfo[]> {
  const sessionsDir = path.join(getCodexHome(), 'sessions')
  if (!fs.existsSync(sessionsDir)) return []

  // Collect all rollout-*.jsonl files under sessions/ (up to 4 levels: YYYY/MM/DD)
  const rolloutFiles: string[] = []
  try {
    walkDir(sessionsDir, rolloutFiles)
  } catch (err) {
    logger.warn('CodexSessions', 'Failed to walk codex sessions dir', err)
    return []
  }

  if (rolloutFiles.length === 0) return []

  const cache = loadCodexDiskCache()
  let cacheChanged = false

  const results: SessionInfo[] = []

  // Files needing a (re)parse — collected first, then parsed in parallel so
  // large session sets don't serialize on readline streams.
  const stale: Array<{ filePath: string; mtime: number }> = []

  for (const filePath of rolloutFiles) {
    let mtime: number
    try {
      mtime = fs.statSync(filePath).mtimeMs
    } catch {
      continue
    }

    const cached = cache[filePath]
    if (cached && cached.mtime === mtime) {
      // Cache hit — use cached entry (skip entries we previously found unparseable)
      if (cached.cwd && cached.sessionId) {
        results.push(cachedToSessionInfo(cached, mtime))
      }
      continue
    }

    stale.push({ filePath, mtime })
  }

  if (stale.length > 0) {
    const parsed = await Promise.all(
      stale.map(async ({ filePath, mtime }) => {
        const meta = await parseRolloutMetaAsync(filePath)
        if (!meta || !meta.cwd) {
          // Cache a minimal "unparseable" entry so we don't re-stream next scan.
          return {
            filePath,
            entry: { mtime, sessionId: '', cwd: '', timestamp: mtime, title: '' }
          }
        }
        const userText = await extractFirstUserText(filePath)
        const title = userText || fallbackTitle(meta.timestamp, mtime)
        return {
          filePath,
          entry: {
            mtime,
            sessionId: meta.sessionId,
            cwd: meta.cwd,
            timestamp: meta.timestamp || mtime,
            title
          }
        }
      })
    )

    for (const { filePath, entry } of parsed) {
      cache[filePath] = entry
      cacheChanged = true
      if (entry.cwd && entry.sessionId) {
        results.push(cachedToSessionInfo(entry, entry.mtime))
      }
    }
  }

  if (cacheChanged) {
    saveCodexDiskCache(cache)
  }

  return results
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function cachedToSessionInfo(entry: CodexCachedEntry, mtime: number): SessionInfo {
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    projectKey: cwdToProjectKey(entry.cwd),
    title: entry.title || fallbackTitle(entry.timestamp, mtime),
    timestamp: entry.timestamp || mtime,
    lastActivityAt: mtime,
    aiTitle: null,
    provider: 'codex'
  }
}

/** Recursively collect rollout-*.jsonl files up to maxDepth levels deep. */
function walkDir(dir: string, out: string[], depth = 0, maxDepth = 4): void {
  if (depth > maxDepth) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(full, out, depth + 1, maxDepth)
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    ) {
      out.push(full)
    }
  }
}

/** Derive a projectKey from a cwd, mirroring the Claude convention:
 *  replace path separators and dots with '-'. */
export function cwdToProjectKey(cwd: string): string {
  return cwd.replace(/[/\\\.]/g, '-')
}

// ─── resolve + delete helpers ─────────────────────────────────────────────────

/**
 * Find the rollout file whose session_meta.id === sessionId.
 *
 * Strategy:
 *   1. Reverse-lookup the disk cache (O(n) over cached entries, no extra I/O).
 *   2. If not found in cache, walk CODEX_HOME/sessions and parse until a match.
 *
 * Returns the absolute file path or null if not found / CODEX_HOME/sessions
 * does not exist.
 */
export async function resolveCodexRolloutPath(sessionId: string): Promise<string | null> {
  if (!sessionId) return null

  // Fast path: check the disk cache for a reverse-lookup hit.
  const cache = loadCodexDiskCache()
  for (const [filePath, entry] of Object.entries(cache)) {
    if (entry.sessionId === sessionId) {
      // Confirm the file still exists (it may have been deleted externally).
      try {
        await fs.promises.access(filePath, fs.constants.F_OK)
        return filePath
      } catch {
        // File gone — fall through to a fresh scan.
        break
      }
    }
  }

  // Slow path: walk the sessions directory.
  const sessionsDir = path.join(getCodexHome(), 'sessions')
  if (!fs.existsSync(sessionsDir)) return null

  const rolloutFiles: string[] = []
  try {
    walkDir(sessionsDir, rolloutFiles)
  } catch {
    return null
  }

  for (const filePath of rolloutFiles) {
    const meta = await parseRolloutMetaAsync(filePath)
    if (meta?.sessionId === sessionId) return filePath
  }

  return null
}

/**
 * Permanently delete the rollout file for the given sessionId.
 *
 * - Resolves the rollout path via `resolveCodexRolloutPath`.
 * - Validates the resolved path is inside `${getCodexHome()}/sessions/` to
 *   block any path-traversal attempt.
 * - Removes the file (force: true — no error if already gone).
 * - Invalidates the cache entry for the deleted path.
 * - No-ops gracefully if the rollout file cannot be found.
 */
export async function deleteCodexSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('sessionId is required')

  const rolloutPath = await resolveCodexRolloutPath(sessionId)
  if (!rolloutPath) return // Session not found — no-op

  // Path-traversal guard: the resolved path must sit inside CODEX_HOME/sessions/.
  const sessionsDir = path.join(getCodexHome(), 'sessions')
  const resolved = path.resolve(rolloutPath)
  if (!resolved.startsWith(sessionsDir + path.sep)) {
    throw new Error(`Path traversal blocked: ${resolved} is outside ${sessionsDir}`)
  }

  await fs.promises.rm(resolved, { force: true })

  // Invalidate the cache entry so the next listCodexSessions scan is clean.
  const cache = loadCodexDiskCache()
  if (rolloutPath in cache) {
    delete cache[rolloutPath]
    saveCodexDiskCache(cache)
  }
}
