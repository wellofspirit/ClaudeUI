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
  defaultMode: undefined
}

function normalizePermissions(raw: unknown): ClaudePermissions {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PERMISSIONS }
  const p = raw as Record<string, unknown>
  return {
    allow: Array.isArray(p.allow) ? (p.allow as string[]) : [],
    deny: Array.isArray(p.deny) ? (p.deny as string[]) : [],
    ask: Array.isArray(p.ask) ? (p.ask as string[]) : [],
    additionalDirectories: Array.isArray(p.additionalDirectories)
      ? (p.additionalDirectories as string[])
      : [],
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : undefined
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadClaudePermissions(scope: PermissionScope, cwd?: string): ClaudePermissions {
  const filePath = settingsFilePath(scope, cwd)
  const data = readJsonSafe(filePath)
  if (!data) return { ...EMPTY_PERMISSIONS }
  return normalizePermissions(data.permissions)
}

export function saveClaudePermissions(
  scope: PermissionScope,
  permissions: ClaudePermissions,
  cwd?: string
): void {
  const filePath = settingsFilePath(scope, cwd)

  // Read existing file to preserve non-permission keys
  let data = readJsonSafe(filePath) ?? {}

  // Build the permissions object, omitting empty arrays to keep file tidy
  const permsObj: Record<string, unknown> = {}
  if (permissions.allow.length > 0) permsObj.allow = permissions.allow
  if (permissions.deny.length > 0) permsObj.deny = permissions.deny
  if (permissions.ask.length > 0) permsObj.ask = permissions.ask
  if (permissions.additionalDirectories.length > 0)
    permsObj.additionalDirectories = permissions.additionalDirectories
  if (permissions.defaultMode) permsObj.defaultMode = permissions.defaultMode

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
  logger.info('ClaudeSettings', `Saved ${scope} permissions to ${filePath}`)
}
