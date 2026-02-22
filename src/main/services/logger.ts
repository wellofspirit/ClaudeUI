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

export const logger = {
  error(source: string, message: string, err?: unknown): void {
    if (err !== undefined) {
      console.error(`[${source}]`, message, err)
    } else {
      console.error(`[${source}]`, message)
    }
    writeToFile('ERROR', source, message, err)
  },

  warn(source: string, message: string, err?: unknown): void {
    if (err !== undefined) {
      console.warn(`[${source}]`, message, err)
    } else {
      console.warn(`[${source}]`, message)
    }
    writeToFile('WARN', source, message, err)
  },

  info(source: string, message: string): void {
    console.log(`[${source}]`, message)
    // Info is console-only by default; uncomment to persist:
    // writeToFile('INFO', source, message)
  }
}
