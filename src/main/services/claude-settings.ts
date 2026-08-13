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
    disableAutoMode: typeof p.disableAutoMode === 'string' ? p.disableAutoMode : topLevel
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

// ---------------------------------------------------------------------------
// Workspace trust (~/.claude.json#projects[cwd].hasTrustDialogAccepted)
// ---------------------------------------------------------------------------
//
// cli.js silently DROPS every `allow` rule sourced from projectSettings or
// localSettings while the workspace is untrusted; deny/ask and user-scope
// allows survive. The warning it would normally print is suppressed in
// non-interactive mode, so under ClaudeUI the drop is invisible — hence this
// read-only probe, used to surface it in the permissions UI. Trust itself is
// granted by cli.js's own dialog; nothing here writes.

/**
 * cli.js keys `projects` by the cwd string as IT saw it, which on Windows is
 * inconsistent: forward slashes from a POSIX-style shell, backslashes from
 * cmd/PowerShell, and either drive-letter case. Probe the plausible spellings
 * in a fixed order and take the first entry that exists — matching an entry
 * with `hasTrustDialogAccepted: false` must NOT fall through to a different
 * spelling that says true.
 */
function trustKeyCandidates(cwd: string): string[] {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (!trimmed) return []
  const drives = /^[a-zA-Z]:/.test(trimmed)
    ? [
        trimmed,
        trimmed[0].toUpperCase() + trimmed.slice(1),
        trimmed[0].toLowerCase() + trimmed.slice(1)
      ]
    : [trimmed]
  const out: string[] = []
  for (const base of drives) {
    for (const variant of [base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')]) {
      if (!out.includes(variant)) out.push(variant)
    }
  }
  return out
}

/** Whether cli.js will honor this workspace's project/local allow rules. */
export function isWorkspaceTrusted(cwd: string): boolean {
  if (!cwd) return false
  const data = readJsonSafe(path.join(os.homedir(), '.claude.json'))
  const projects = data?.projects
  if (!projects || typeof projects !== 'object') return false
  const byKey = projects as Record<string, unknown>
  for (const key of trustKeyCandidates(cwd)) {
    const entry = byKey[key]
    if (entry && typeof entry === 'object') {
      return (entry as Record<string, unknown>).hasTrustDialogAccepted === true
    }
  }
  return false
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
  // would copy an admin's top-level key down into `permissions`. The UI never
  // edits this setting, so round-tripping the on-disk nested value verbatim is
  // both sufficient and the least surprising thing to do to someone's file.
  const existingPerms =
    data.permissions && typeof data.permissions === 'object'
      ? (data.permissions as Record<string, unknown>)
      : {}
  if (typeof existingPerms.disableAutoMode === 'string') {
    permsObj.disableAutoMode = existingPerms.disableAutoMode
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
