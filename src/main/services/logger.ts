import { mkdirSync, appendFileSync, statSync } from 'fs'
import { readdir, unlink, appendFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const LOG_DIR = join(homedir(), '.claude', 'ui', 'logs')

// ---------------------------------------------------------------------------
// File-write policy (M-LG1)
//
// Every logger call used to hit `appendFileSync`, blocking the main process's
// event loop once per line. Lines are now queued in memory and flushed with
// `fs.promises.appendFile`, with a single in-flight flush so appends stay
// ordered. `flushSync()` (wired to `process.on('exit')`) drains the tail.
//
// This module is imported at module-load time, long before app.whenReady —
// it must never touch an Electron API. Keep it to `fs`/`path`/`os`.
// ---------------------------------------------------------------------------

/** Flush as soon as this many lines are queued. */
export const LOG_FLUSH_LINES = 64
/** …or this long after the first line was queued, whichever comes first. */
export const LOG_FLUSH_INTERVAL_MS = 500
/** Daily log files older than this are pruned once per process. */
export const LOG_RETENTION_DAYS = 14
/** Hard per-day ceiling; past this the day's file stops growing. */
export const LOG_MAX_BYTES_PER_DAY = 50 * 1024 * 1024

let dirEnsured = false

function ensureDir(): void {
  if (dirEnsured) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    dirEnsured = true
  } catch {
    // If we can't create the log dir, we'll still log to console
  }
}

/** Local-date key of the current daily log file, e.g. `20260727`. */
function currentDayKey(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ---------------------------------------------------------------------------
// Buffered writer
// ---------------------------------------------------------------------------

/** Lines queued for `bufferPath`, not yet handed to the filesystem. */
let buffer: string[] = []
/** The file every line currently in `buffer` belongs to. */
let bufferPath = ''
/** A flush is awaiting its `appendFile` promise — hold the next one back so appends stay ordered. */
let flushing = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Day key whose byte budget `bytesToday` tracks. */
let budgetDay = ''
let bytesToday = 0
let capReached = false
let prunedThisProcess = false

function clearFlushTimer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

/** Hand the queued lines to the filesystem. No-op while another flush is in flight. */
function flush(): void {
  clearFlushTimer()
  if (flushing || buffer.length === 0) return
  const chunk = buffer.join('')
  const target = bufferPath
  buffer = []
  flushing = true
  appendFile(target, chunk, 'utf-8')
    .catch(() => {
      // Can't write to log file — nothing we can do
    })
    .finally(() => {
      flushing = false
      // Lines queued while we were writing go out now.
      if (buffer.length > 0) flush()
    })
}

/**
 * Drain the queue synchronously. Wired to `process.on('exit')` (async work
 * cannot run there) and exported so tests can force the file to materialise.
 *
 * If an async flush happens to be in flight, its chunk may land after this
 * one — an at-exit-only ordering wrinkle, since the process is about to die
 * before that promise can settle anyway.
 */
export function flushSync(): void {
  clearFlushTimer()
  if (buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  try {
    appendFileSync(bufferPath, chunk, 'utf-8')
  } catch {
    // Can't write to log file — nothing we can do
  }
}

process.on('exit', flushSync)

/**
 * Delete daily log files older than `LOG_RETENTION_DAYS`. Runs at most once
 * per process (fired, not awaited, from the first file write) and swallows
 * every error — losing a prune is strictly better than losing a log line.
 * Exported so tests can await it.
 */
export async function pruneOldLogs(): Promise<void> {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = await readdir(LOG_DIR)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^\d{8}\.log$/.test(name)) continue
    const y = Number(name.slice(0, 4))
    const m = Number(name.slice(4, 6))
    const d = Number(name.slice(6, 8))
    const day = new Date(y, m - 1, d).getTime()
    if (!Number.isFinite(day) || day >= cutoff) continue
    try {
      await unlink(join(LOG_DIR, name))
    } catch {
      // File vanished or is locked — skip it
    }
  }
}

/**
 * Re-point the buffer at `path`, draining anything still queued for the
 * previous day's file first. Happens at most once a day (at midnight), so the
 * synchronous drain here is not a hot path.
 */
function retargetBuffer(path: string): void {
  if (bufferPath === path) return
  if (bufferPath && buffer.length > 0) flushSync()
  bufferPath = path
}

/** Reset the per-day byte budget when the date rolls, seeding it from the file already on disk. */
function ensureDayBudget(path: string, day: string): void {
  if (budgetDay === day) return
  budgetDay = day
  capReached = false
  try {
    bytesToday = statSync(path).size
  } catch {
    bytesToday = 0
  }
}

function queueLine(line: string): void {
  buffer.push(line)
  if (buffer.length >= LOG_FLUSH_LINES) {
    flush()
    return
  }
  if (!flushTimer) flushTimer = setTimeout(flush, LOG_FLUSH_INTERVAL_MS)
}

function writeToFile(level: string, source: string, message: string, err?: unknown): void {
  ensureDir()
  let line = `[${timestamp()}] [${level}] [${source}] ${message}`
  if (err !== undefined) {
    line += `\n  ${formatError(err).replace(/\n/g, '\n  ')}`
  }
  line += '\n'

  const day = currentDayKey()
  const path = join(LOG_DIR, `${day}.log`)
  retargetBuffer(path)
  ensureDayBudget(path, day)

  if (!prunedThisProcess) {
    prunedThisProcess = true
    void pruneOldLogs()
  }

  // Past the daily ceiling the file stops growing; console output continues.
  if (capReached) return
  bytesToday += Buffer.byteLength(line, 'utf-8')
  queueLine(line)
  if (bytesToday >= LOG_MAX_BYTES_PER_DAY) {
    capReached = true
    queueLine(
      `[${timestamp()}] [WARN] [logger] size cap reached (${LOG_MAX_BYTES_PER_DAY} bytes) — no further file output for ${day}\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Log levels (lower = more verbose)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  source: string
  message: string
  error?: string
}

export type LogSubscriber = (entry: LogEntry) => void

const subscribers = new Set<LogSubscriber>()

// ---------------------------------------------------------------------------
// Ring buffer — captures ALL log entries from the moment the logger module
// loads, so the log viewer can display entries that occurred before it opened.
// ---------------------------------------------------------------------------

const LOG_RING_SIZE = 5000

class LogRingBuffer {
  private buf: LogEntry[] = new Array(LOG_RING_SIZE)
  private head = 0
  private full = false

  push(item: LogEntry): void {
    this.buf[this.head] = item
    this.head = (this.head + 1) % LOG_RING_SIZE
    if (!this.full && this.head === 0) this.full = true
  }

  toArray(): LogEntry[] {
    if (!this.full) return this.buf.slice(0, this.head)
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)]
  }
}

/** Global ring buffer — starts capturing at module load time (before app.whenReady). */
export const logRing = new LogRingBuffer()

function notify(level: LogLevel, source: string, message: string, err?: unknown): void {
  const entry: LogEntry = {
    timestamp: timestamp(),
    level,
    source,
    message,
    ...(err !== undefined ? { error: formatError(err) } : {})
  }
  logRing.push(entry)
  for (const fn of subscribers) {
    try {
      fn(entry)
    } catch {
      /* don't let subscriber errors break logging */
    }
  }
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
}

/**
 * Check whether a message at `msgLevel` should be emitted given the
 * effective minimum level for this source.
 */
function shouldLog(source: string, msgLevel: LogLevel): boolean {
  // Per-source override takes priority over the global default
  const effective = logger.sourceLevels.get(source) ?? logger.globalLevel
  return LEVEL_ORDER[msgLevel] >= LEVEL_ORDER[effective]
}

// ---------------------------------------------------------------------------
// Initialise from environment
//
//   CLAUDE_UI_LOG=debug                 — set global level
//   CLAUDE_UI_LOG=debug,UsageFetcher    — set global + one source
//   CLAUDE_UI_LOG=info,BlockUsage:debug,UsageFetcher:debug
//
// Format: [globalLevel,] source:level [, source:level …]
//
// When only a bare word is given it's treated as a source at debug level
// (e.g. "BlockUsage" → BlockUsage:debug) for quick toggling.
// ---------------------------------------------------------------------------

function parseFilter(raw: string): { global: LogLevel; sources: Map<string, LogLevel> } {
  const defaultLevel: LogLevel = 'warn' // default: only warn and above
  const sources = new Map<string, LogLevel>()

  if (!raw) return { global: defaultLevel, sources }

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let resolvedGlobal: LogLevel = defaultLevel

  for (const part of parts) {
    if (part.includes(':')) {
      const [src, lvl] = part.split(':', 2)
      if (lvl in LEVEL_ORDER) sources.set(src, lvl as LogLevel)
    } else if (part in LEVEL_ORDER) {
      resolvedGlobal = part as LogLevel
    } else {
      // Bare word → treat as source:debug
      sources.set(part, 'debug')
    }
  }

  return { global: resolvedGlobal, sources }
}

// Merge env var and settings — env var takes precedence (always applied first,
// settings are additive on top).
const envConfig = parseFilter(process.env.CLAUDE_UI_LOG ?? '')

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export const logger: {
  globalLevel: LogLevel
  sourceLevels: Map<string, LogLevel>
  error(source: string, message: string, err?: unknown): void
  warn(source: string, message: string, err?: unknown): void
  info(source: string, message: string): void
  debug(source: string, message: string): void
  subscribe(fn: LogSubscriber): () => void
  applyFilter(filter: string, globalLevel?: LogLevel): void
} = {
  /**
   * Global minimum log level.  Messages below this level are suppressed
   * unless the source has a per-source override in `sourceLevels`.
   * Default: 'warn' (only warn + error shown).
   */
  globalLevel: envConfig.global,

  /**
   * Per-source level overrides.  A source listed here is logged at (at least)
   * the specified level, regardless of globalLevel.
   *
   * Example: `logger.sourceLevels.set('UsageFetcher', 'debug')`
   */
  sourceLevels: envConfig.sources,

  error(source: string, message: string, err?: unknown): void {
    notify('error', source, message, err)
    if (!shouldLog(source, 'error')) return
    const line = `[${timestamp()}] [ERROR] [${source}] ${message}`
    if (err !== undefined) {
      console.error(line, err)
    } else {
      console.error(line)
    }
    writeToFile('ERROR', source, message, err)
  },

  warn(source: string, message: string, err?: unknown): void {
    notify('warn', source, message, err)
    if (!shouldLog(source, 'warn')) return
    const line = `[${timestamp()}] [WARN] [${source}] ${message}`
    if (err !== undefined) {
      console.warn(line, err)
    } else {
      console.warn(line)
    }
    writeToFile('WARN', source, message, err)
  },

  info(source: string, message: string): void {
    notify('info', source, message)
    if (!shouldLog(source, 'info')) return
    console.log(`[${timestamp()}] [INFO] [${source}] ${message}`)
    writeToFile('INFO', source, message)
  },

  debug(source: string, message: string): void {
    notify('debug', source, message)
    if (!shouldLog(source, 'debug')) return
    const line = `[${timestamp()}] [DEBUG] [${source}] ${message}`
    console.log(line)
    writeToFile('DEBUG', source, message)
  },

  /**
   * Subscribe to all log entries (regardless of log level filtering).
   * Returns an unsubscribe function.
   */
  subscribe(fn: LogSubscriber): () => void {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  },

  /**
   * Apply a global level and per-source filter from the UI settings.
   * Settings are merged on top of the env var config —
   * env var entries are never removed, only supplemented.
   *
   * @param filter - Per-source overrides: "UsageFetcher,BlockUsage:debug"
   * @param globalLevel - Explicit global level from the UI dropdown
   */
  applyFilter(filter: string, globalLevel?: LogLevel): void {
    const settings = parseFilter(filter)

    // Start from env config as the base
    logger.globalLevel = envConfig.global
    logger.sourceLevels = new Map(envConfig.sources)

    // Apply explicit global level from the UI dropdown — use the most
    // verbose of env var and UI setting
    if (globalLevel && LEVEL_ORDER[globalLevel] < LEVEL_ORDER[logger.globalLevel]) {
      logger.globalLevel = globalLevel
    }

    // Apply per-source overrides from the filter string
    if (filter) {
      // If the filter string also contains a bare level word, apply it too
      if (LEVEL_ORDER[settings.global] < LEVEL_ORDER[logger.globalLevel]) {
        logger.globalLevel = settings.global
      }
      // Merge per-source levels — most verbose wins
      for (const [src, lvl] of settings.sources) {
        const existing = logger.sourceLevels.get(src)
        if (!existing || LEVEL_ORDER[lvl] < LEVEL_ORDER[existing]) {
          logger.sourceLevels.set(src, lvl)
        }
      }
    }
  }
}
