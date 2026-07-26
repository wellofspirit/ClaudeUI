import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { BrowserWindow } from 'electron'
import { logger } from './logger'
import { writeFileAtomicSync } from './write-json-atomic'
import {
  allSessionMeta,
  setSessionMeta,
  deleteSessionMeta,
  importSessionEnginesOnce
} from './db'

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'ui')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json')
const SLASH_COMMANDS_FILE = path.join(CONFIG_DIR, 'slash-commands.json')
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const ENGINES_DIR = path.join(CONFIG_DIR, 'engines')
const VENDORS_DIR = path.join(CONFIG_DIR, 'vendors')

export interface UISettings {
  [key: string]: unknown
}

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
  worktreeInfoMap?: Record<string, import('../../shared/types').WorktreeInfo>
  /**
   * Engine + model per session. Maps sessionId → { engineId, model? }.
   * Absent keys are treated as claude. Written at session-creation time, updated
   * on model switch, and carried over on rekey. The `model` field seeds
   * `selectedModel` when the session is reopened (see session-store).
   */
  sessionEngines?: Record<
    string,
    { engineId: import('../../shared/types').EngineId; model?: import('../../shared/types').ModelRef }
  >
  hiddenSessions?: string[]
  hiddenProjects?: string[]
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
  // lastWrittenContent must equal the exact bytes on disk (the watcher skips
  // our own writes by content), so serialize once and hand the SAME string to
  // the atomic writer — a byte-for-byte drop-in for the old writeFileSync,
  // now temp-file + rename so a concurrent reader never sees a torn file (P1).
  lastWrittenContent.set(filePath, json)
  writeFileAtomicSync(filePath, json, { mode: 0o600 })
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

let configPlaneMigrated = false

function migrateConfigPlane(): void {
  if (configPlaneMigrated) return
  configPlaneMigrated = true

  const raw = readJson<Record<string, unknown>>(SETTINGS_FILE)
  if (!raw) return

  let settingsChanged = false

  // Migrate sandbox/proxy → engines/claude.json
  if (raw.sandbox !== undefined || raw.proxy !== undefined) {
    const engineFilePath = path.join(ENGINES_DIR, 'claude.json')
    if (!fs.existsSync(ENGINES_DIR)) fs.mkdirSync(ENGINES_DIR, { recursive: true, mode: 0o700 })
    const existing = readJson<Record<string, unknown>>(engineFilePath) ?? {}
    if (raw.sandbox !== undefined && existing.sandbox === undefined) {
      existing.sandbox = raw.sandbox
    }
    if (raw.proxy !== undefined && existing.proxy === undefined) {
      existing.proxy = raw.proxy
    }
    writeJson(engineFilePath, existing)
    delete raw.sandbox
    delete raw.proxy
    settingsChanged = true
  }

  // Migrate anthropicEndpoint/modelOverride → vendors/anthropic.json
  if (raw.anthropicEndpoint !== undefined || raw.modelOverride !== undefined) {
    const vendorFilePath = path.join(VENDORS_DIR, 'anthropic.json')
    if (!fs.existsSync(VENDORS_DIR)) fs.mkdirSync(VENDORS_DIR, { recursive: true, mode: 0o700 })
    const existing = readJson<Record<string, unknown>>(vendorFilePath) ?? {}
    if (raw.anthropicEndpoint !== undefined && existing.endpoint === undefined) {
      existing.endpoint = raw.anthropicEndpoint
    }
    if (raw.modelOverride !== undefined && existing.modelOverride === undefined) {
      existing.modelOverride = raw.modelOverride
    }
    writeJson(vendorFilePath, existing)
    delete raw.anthropicEndpoint
    delete raw.modelOverride
    settingsChanged = true
  }

  if (settingsChanged) {
    writeJson(SETTINGS_FILE, raw)
  }
}

export function loadSettings(): UISettings {
  ensureMigrated()
  migrateConfigPlane()
  return readJson<UISettings>(SETTINGS_FILE) ?? {}
}

export function saveSettings(settings: UISettings): void {
  writeJson(SETTINGS_FILE, settings)
}

export function loadSessionConfig(): UISessionConfig {
  ensureMigrated()
  // Read raw so we can inspect legacy keys before full parse
  const raw = readJson<Record<string, unknown>>(SESSIONS_FILE) ?? {}

  // --- One-time import: sessionEngines from sessions.json → DB ---
  // Handle legacy sessionProviders → sessionEngines normalisation first so the
  // import sees a consistent shape.
  let fileSessionEngines: Record<string, { engineId: string; model?: import('../../shared/types').ModelRef }> | undefined

  if (raw.sessionProviders && !raw.sessionEngines) {
    const legacy = raw.sessionProviders as Record<string, unknown>
    const normalised: Record<string, { engineId: 'claude' }> = {}
    for (const id of Object.keys(legacy)) {
      normalised[id] = { engineId: 'claude' }
    }
    fileSessionEngines = normalised
  } else if (raw.sessionEngines) {
    fileSessionEngines = raw.sessionEngines as typeof fileSessionEngines
  }

  if (fileSessionEngines && Object.keys(fileSessionEngines).length > 0) {
    importSessionEnginesOnce(fileSessionEngines)
  }

  // Strip sessionEngines + sessionProviders from the JSON-sourced config;
  // authoritative copy now lives in the DB.
  delete raw.sessionEngines
  delete raw.sessionProviders

  const config = raw as UISessionConfig

  // Source sessionEngines from DB, reconstructing ModelRef on read
  config.sessionEngines = allSessionMeta()

  return config
}

export function saveSessionConfig(config: UISessionConfig): void {
  // Persist sessionEngines to the DB, not the JSON file.
  // The renderer sends the full UISessionConfig (including sessionEngines) so we
  // extract it here, write it to the DB, and strip it before writing the JSON.
  if (config.sessionEngines) {
    const incoming = config.sessionEngines
    const incomingIds = Object.keys(incoming)

    // Add/update entries present in the incoming map
    for (const [sessionId, meta] of Object.entries(incoming)) {
      setSessionMeta(sessionId, meta)
    }

    // Remove entries absent from the incoming map — but ONLY when the payload
    // actually carries the full session set. An EMPTY map is the fingerprint of
    // an impoverished save: a remote/web client (or an older bundle) whose
    // snapshot never populated sessionEngines round-trips `{}` here, and the old
    // unconditional delete-loop then wiped every session's engine/model mapping,
    // reopening all opencode/pi sessions as Claude (H15). A genuinely-empty save
    // has nothing legitimate to delete toward — any leftover DB rows are just
    // harmless orphans, far better than a full wipe. The real cleanup this loop
    // exists for (rekey: client-id → real-session-id) always sends a non-empty
    // map, so it keeps working.
    if (incomingIds.length > 0) {
      const currentMeta = allSessionMeta()
      for (const sessionId of Object.keys(currentMeta)) {
        if (!(sessionId in incoming)) {
          deleteSessionMeta(sessionId)
        }
      }
    }
  }

  // Write the rest (recentSessions, pinnedSessions, customTitles, etc.) to JSON
  // without sessionEngines — the DB is now the authoritative source.
  const { sessionEngines: _dropped, ...rest } = config
  writeJson(SESSIONS_FILE, rest)
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

export function loadEngineConfig(engineId: string): import('../../shared/types').EngineConfig {
  const filePath = path.join(ENGINES_DIR, `${engineId}.json`)
  return readJson<import('../../shared/types').EngineConfig>(filePath) ?? {}
}

export function saveEngineConfig(
  engineId: string,
  config: import('../../shared/types').EngineConfig
): void {
  if (!fs.existsSync(ENGINES_DIR)) fs.mkdirSync(ENGINES_DIR, { recursive: true, mode: 0o700 })
  writeJson(path.join(ENGINES_DIR, `${engineId}.json`), config)
}

export function loadVendorConfig(vendorId: string): import('../../shared/types').VendorConfig {
  const filePath = path.join(VENDORS_DIR, `${vendorId}.json`)
  return readJson<import('../../shared/types').VendorConfig>(filePath) ?? {}
}

export function saveVendorConfig(
  vendorId: string,
  config: import('../../shared/types').VendorConfig
): void {
  if (!fs.existsSync(VENDORS_DIR)) fs.mkdirSync(VENDORS_DIR, { recursive: true, mode: 0o700 })
  writeJson(path.join(VENDORS_DIR, `${vendorId}.json`), config)
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
export function startConfigWatcher(
  win: BrowserWindow,
  getExtraWindows?: () => Set<BrowserWindow>
): () => void {
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
        // Also forward to extra windows (remote bridge, etc.)
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
