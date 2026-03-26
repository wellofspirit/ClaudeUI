import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOG_DIR = join(homedir(), '.claude', 'ui', 'logs')

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

function getLogFilePath(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return join(LOG_DIR, `${y}${m}${d}.log`)
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

function writeToFile(level: string, source: string, message: string, err?: unknown): void {
  ensureDir()
  let line = `[${timestamp()}] [${level}] [${source}] ${message}`
  if (err !== undefined) {
    line += `\n  ${formatError(err).replace(/\n/g, '\n  ')}`
  }
  line += '\n'
  try {
    appendFileSync(getLogFilePath(), line, 'utf-8')
  } catch {
    // Can't write to log file — nothing we can do
  }
}

// ---------------------------------------------------------------------------
// Log levels (lower = more verbose)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

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

  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
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
    if (!shouldLog(source, 'error')) return
    if (err !== undefined) {
      console.error(`[${source}]`, message, err)
    } else {
      console.error(`[${source}]`, message)
    }
    writeToFile('ERROR', source, message, err)
  },

  warn(source: string, message: string, err?: unknown): void {
    if (!shouldLog(source, 'warn')) return
    if (err !== undefined) {
      console.warn(`[${source}]`, message, err)
    } else {
      console.warn(`[${source}]`, message)
    }
    writeToFile('WARN', source, message, err)
  },

  info(source: string, message: string): void {
    if (!shouldLog(source, 'info')) return
    console.log(`[${source}]`, message)
    // Info is console-only by default; uncomment to persist:
    // writeToFile('INFO', source, message)
  },

  debug(source: string, message: string): void {
    if (!shouldLog(source, 'debug')) return
    const line = `[${timestamp()}] [DEBUG] [${source}] ${message}`
    console.log(line)
    writeToFile('DEBUG', source, message)
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
