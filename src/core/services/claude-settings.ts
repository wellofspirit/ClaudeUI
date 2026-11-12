/**
 * Read/write Claude Code permission settings from the standard settings.json files.
 *
 * Three scopes:
 *   user    → ~/.claude/settings.json
 *   project → <cwd>/.claude/settings.json
 *   local   → <cwd>/.claude/settings.local.json
 *
 * Each file may contain other keys (env, hooks, mcpServers, etc.) — we only
 * touch the `permissions` subtree and preserve everything else.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function settingsFilePath(scope: PermissionScope, cwd?: string): string {
  switch (scope) {
    case 'user':
      return path.join(os.homedir(), '.claude', 'settings.json')
    case 'project':
      if (!cwd) throw new Error('cwd required for project scope')
      return path.join(cwd, '.claude', 'settings.json')
    case 'local':
      if (!cwd) throw new Error('cwd required for local scope')
      return path.join(cwd, '.claude', 'settings.local.json')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    logger.warn('ClaudeSettings', `Failed to read ${filePath}`, err)
    return null
  }
}

const EMPTY_PERMISSIONS: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined,
  disableAutoMode: undefined
}

/**
 * @param raw the `permissions` object from a settings file
 * @param topLevelDisableAutoMode the file's TOP-LEVEL `disableAutoMode`, which
 *   cli.js honours equivalently to the nested one. The nested value wins when
 *   both are present; this only fills in.
 */
function normalizePermissions(raw: unknown, topLevelDisableAutoMode?: unknown): ClaudePermissions {
  const topLevel = typeof topLevelDisableAutoMode === 'string' ? topLevelDisableAutoMode : undefined
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_PERMISSIONS, disableAutoMode: topLevel }
  }
  const p = raw as Record<string, unknown>
  return {
    allow: Array.isArray(p.allow) ? (p.allow as string[]) : [],
    deny: Array.isArray(p.deny) ? (p.deny as string[]) : [],
    ask: Array.isArray(p.ask) ? (p.ask as string[]) : [],
    additionalDirectories: Array.isArray(p.additionalDirectories)
      ? (p.additionalDirectories as string[])
      : [],
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : undefined,
    disableAutoMode: typeof p.disableAutoMode === 'string' ? p.disableAutoMode : topLevel,
    ...(p.blockReadsOutsideWorkingDirectories === true
      ? { blockReadsOutsideWorkingDirectories: true }
      : {})
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadClaudePermissions(scope: PermissionScope, cwd?: string): ClaudePermissions {
  const filePath = settingsFilePath(scope, cwd)
  const data = readJsonSafe(filePath)
  if (!data) return { ...EMPTY_PERMISSIONS }
  return normalizePermissions(data.permissions, data.disableAutoMode)
}

/**
 * The auto-mode flags ClaudeUI's own judge skip honours (ADR-085 §4):
 * `autoMode.classifyAllShell === true` — exactly `true`, nothing truthy — in
 * the USER settings file only. cli.js reads this flag from user, flag and
 * policy settings and ignores project/local (`Lvr`,
 * `docs/protocol-cc/14-auto-mode-classifier.md` §3.0): a repository must not
 * be able to switch its own review off or on. ClaudeUI has no flag or policy
 * layer, so the user file is the whole source. Read fresh per call (callers
 * read it per gate call, like the permissions). Never throws.
 */
export function loadClaudeAutoModeFlags(): { classifyAllShell: boolean } {
  const data = readJsonSafe(settingsFilePath('user'))
  const autoMode = data?.autoMode
  const classifyAllShell =
    !!autoMode &&
    typeof autoMode === 'object' &&
    (autoMode as Record<string, unknown>).classifyAllShell === true
  return { classifyAllShell }
}

// ---------------------------------------------------------------------------
// cleanupPeriodDays — transcript retention window
// ---------------------------------------------------------------------------
//
// Claude Code's startup sweep deletes chat transcripts under ~/.claude/projects
// whose mtime is older than `cleanupPeriodDays` (default 30). This lives as a
// top-level key in the user-scope settings.json — the same file the bundled
// cli.js reads via settingSources:['user',...] — so it's the single source of
// truth honored by both ClaudeUI and the native CLI.
//
// Stored as an integer >= 1 (upstream schema minimum). The UI writes a large
// window (3650 ≈ 10 years) to mean "never clean up" rather than 0, which
// upstream marks invalid and which trips a startup validation warning. See
// ADR-009.

export function loadCleanupPeriodDays(): number | undefined {
  const data = readJsonSafe(settingsFilePath('user'))
  const v = data?.cleanupPeriodDays
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function saveCleanupPeriodDays(days: number): void {
  const filePath = settingsFilePath('user')
  const data = readJsonSafe(filePath) ?? {}

  // Clamp to the upstream-valid range: integer >= 1.
  data.cleanupPeriodDays = Math.max(1, Math.round(days))

  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  logger.debug('ClaudeSettings', `Saved cleanupPeriodDays=${data.cleanupPeriodDays} to ${filePath}`)
}

// ---------------------------------------------------------------------------
// disableAutoMode — Claude Code's own opt-out from auto mode
// ---------------------------------------------------------------------------
//
// The Settings control on the Claude page edits this key in the user-scope
// file (ADR-009, ADR-050). cli.js honours it nested under `permissions` and at
// the top level, so turning it off clears both. Unlike the older writers this
// one reads strictly: a file it cannot parse is refused, never replaced.

function readJsonStrict(filePath: string): Record<string, unknown> {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${filePath} is not valid JSON; fix or remove it, then try again`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object; fix or remove it, then try again`)
  }
  return parsed as Record<string, unknown>
}

export function saveClaudeDisableAutoMode(disabled: boolean): void {
  const filePath = settingsFilePath('user')
  const data = readJsonStrict(filePath)
  const perms =
    data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
      ? (data.permissions as Record<string, unknown>)
      : undefined

  if (disabled) {
    data.permissions = { ...(perms ?? {}), disableAutoMode: 'disable' }
  } else {
    if (data.disableAutoMode === 'disable') delete data.disableAutoMode
    if (perms) {
      if (perms.disableAutoMode === 'disable') delete perms.disableAutoMode
      if (Object.keys(perms).length === 0) delete data.permissions
    }
  }

  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  logger.debug('ClaudeSettings', `Saved disableAutoMode=${disabled} to ${filePath}`)
}

export function saveClaudePermissions(
  scope: PermissionScope,
  permissions: ClaudePermissions,
  cwd?: string
): void {
  const filePath = settingsFilePath(scope, cwd)

  // Read existing file to preserve non-permission keys
  const data = readJsonSafe(filePath) ?? {}

  // Build the permissions object, omitting empty arrays to keep file tidy
  const permsObj: Record<string, unknown> = {}
  if (permissions.allow.length > 0) permsObj.allow = permissions.allow
  if (permissions.deny.length > 0) permsObj.deny = permissions.deny
  if (permissions.ask.length > 0) permsObj.ask = permissions.ask
  if (permissions.additionalDirectories.length > 0)
    permsObj.additionalDirectories = permissions.additionalDirectories
  if (permissions.defaultMode) permsObj.defaultMode = permissions.defaultMode
  // Write-back matters: this function rebuilds `permissions` from scratch, so a
  // key it does not know about is silently dropped on the next permission edit.
  // `disableAutoMode` is typically admin-authored — losing it would quietly
  // re-enable auto mode on a machine configured to forbid it.
  //
  // Preserved from DISK, not from the argument: the loader normalizes a
  // top-level `disableAutoMode` into the same field, and echoing that back here
  // would copy an admin's top-level key down into `permissions`. Only
  // `saveClaudeDisableAutoMode` edits this setting, so round-tripping the
  // on-disk nested value verbatim is both sufficient and the least surprising
  // thing to do to someone's file.
  const existingPerms =
    data.permissions && typeof data.permissions === 'object'
      ? (data.permissions as Record<string, unknown>)
      : {}
  if (typeof existingPerms.disableAutoMode === 'string') {
    permsObj.disableAutoMode = existingPerms.disableAutoMode
  }
  // Same for the read block (pi enforces it now): a permission edit must not silently lift it.
  if (existingPerms.blockReadsOutsideWorkingDirectories === true) {
    permsObj.blockReadsOutsideWorkingDirectories = true
  }

  if (Object.keys(permsObj).length === 0) {
    // No permissions at all — remove the key entirely
    delete data.permissions
  } else {
    data.permissions = permsObj
  }

  // Ensure the parent directory exists
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  logger.debug('ClaudeSettings', `Saved ${scope} permissions to ${filePath}`)
}
