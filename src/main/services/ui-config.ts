import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { BrowserWindow } from 'electron'
import { logger } from './logger'

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'ui')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json')
const SLASH_COMMANDS_FILE = path.join(CONFIG_DIR, 'slash-commands.json')
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export interface UISettings {
  [key: string]: unknown
}

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
  worktreeInfoMap?: Record<string, import('../../shared/types').WorktreeInfo>
}

// Legacy combined config — kept for migration only
interface LegacyUIConfig {
  settings?: Record<string, unknown>
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
}

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch (err) {
    logger.warn('UIConfig', `Failed to read ${path.basename(filePath)}`, err)
    return null
  }
}

/**
 * Tracks the last content we wrote to each config file. Used by the watcher
 * to skip our own writes — purely content-based, no timing assumptions.
 */
const lastWrittenContent = new Map<string, string>()

function writeJson(filePath: string, data: unknown): void {
  ensureDir()
  const json = JSON.stringify(data, null, 2)
  lastWrittenContent.set(filePath, json)
  fs.writeFileSync(filePath, json, { mode: 0o600 })
}

/**
 * Migrate from legacy config.json → split files on first access.
 * Runs once, then deletes the legacy file.
 */
function migrateLegacyConfig(): void {
  const legacy = readJson<LegacyUIConfig>(LEGACY_CONFIG_FILE)
  if (!legacy) return

  // Only write split files if they don't already exist
  if (!fs.existsSync(SETTINGS_FILE) && legacy.settings) {
    writeJson(SETTINGS_FILE, legacy.settings)
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    const sessions: UISessionConfig = {}
    if (legacy.recentSessions) sessions.recentSessions = legacy.recentSessions
    if (legacy.pinnedSessions) sessions.pinnedSessions = legacy.pinnedSessions
    if (legacy.customTitles) sessions.customTitles = legacy.customTitles
    if (Object.keys(sessions).length > 0) writeJson(SESSIONS_FILE, sessions)
  }

  // Remove legacy file
  try {
    fs.unlinkSync(LEGACY_CONFIG_FILE)
  } catch (err) {
    logger.warn('UIConfig', 'Failed to remove legacy config file', err)
  }
}

let migrated = false
function ensureMigrated(): void {
  if (migrated) return
  migrated = true
  migrateLegacyConfig()
}

export function loadSettings(): UISettings {
  ensureMigrated()
  return readJson<UISettings>(SETTINGS_FILE) ?? {}
}

export function saveSettings(settings: UISettings): void {
  writeJson(SETTINGS_FILE, settings)
}

export function loadSessionConfig(): UISessionConfig {
  ensureMigrated()
  return readJson<UISessionConfig>(SESSIONS_FILE) ?? {}
}

export function saveSessionConfig(config: UISessionConfig): void {
  writeJson(SESSIONS_FILE, config)
}

export interface SlashCommandCache {
  name: string
  description?: string
}

export function loadSlashCommands(): SlashCommandCache[] {
  return readJson<SlashCommandCache[]>(SLASH_COMMANDS_FILE) ?? []
}

export function saveSlashCommands(commands: SlashCommandCache[]): void {
  writeJson(SLASH_COMMANDS_FILE, commands)
}

/**
 * Watch settings.json and sessions.json for external changes (e.g. another app instance).
 * Sends IPC events to the renderer when a file is modified by someone else.
 *
 * Uses fs.watchFile (stat polling) instead of fs.watch because:
 * - fs.watch on macOS fires events before file content is flushed, causing stale reads
 * - fs.watch on file directly breaks on inode changes (atomic writes)
 * - fs.watchFile compares mtime between polls and always reads current content
 *
 * Polling interval is 500ms — a good balance between responsiveness and CPU.
 * For just 2 small config files, the stat overhead is negligible.
 */
export function startConfigWatcher(win: BrowserWindow, getExtraWindows?: () => Set<BrowserWindow>): () => void {
  ensureDir()

  const watched = [
    { filePath: SETTINGS_FILE, channel: 'config:settings-changed' },
    { filePath: SESSIONS_FILE, channel: 'config:sessions-changed' }
  ]

  for (const entry of watched) {
    // Ensure file exists so watchFile has something to stat
    if (!fs.existsSync(entry.filePath)) {
      writeJson(entry.filePath, {})
    }

    fs.watchFile(entry.filePath, { interval: 500 }, () => {
      let content: string
      try {
        content = fs.readFileSync(entry.filePath, 'utf-8')
      } catch (err) {
        logger.warn('UIConfig', `Watcher failed to read ${path.basename(entry.filePath)}`, err)
        return
      }

      // Skip if the content matches what we last wrote (our own save)
      if (content === lastWrittenContent.get(entry.filePath)) return

      try {
        const data = JSON.parse(content)
        if (!win.isDestroyed()) {
          win.webContents.send(entry.channel, data)
        }
        // Also forward to extra windows (remote bridge, teams-view, etc.)
        if (getExtraWindows) {
          for (const w of getExtraWindows()) {
            if (!w.isDestroyed()) w.webContents.send(entry.channel, data)
          }
        }
      } catch (err) {
        logger.warn('UIConfig', `Malformed JSON in ${path.basename(entry.filePath)}`, err)
      }
    })
  }

  return () => {
    for (const entry of watched) {
      fs.unwatchFile(entry.filePath)
    }
  }
}
