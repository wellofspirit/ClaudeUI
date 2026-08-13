import * as fs from 'fs'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { scanSkills } from '../services/skill-scanner'
import { saveCleanupPeriodDays, saveClaudePermissions } from '../services/claude-settings'
import type { ClaudePermissions, PermissionScope } from '../../shared/types'
import {
  saveSessionConfig,
  saveSettings,
  loadEngineConfig,
  loadVendorConfig
} from '../services/ui-config'
import type { UISessionConfig, UISettings } from '../services/ui-config'
import { invalidateMockupSecuritySettings } from '../services/mockup-settings'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import { logger } from '../services/logger'
import { applyProxyEnv, applyEndpointEnv, applyModelEnv } from '../providers/claude-spawn-prep'
import type { ISession } from '../providers/ISession'
import { BaseSession } from '../providers/BaseSession'
import { PERMISSION_MODE_CYCLE } from '../../shared/permission-modes'

// ---------------------------------------------------------------------------
// Shared session-domain IPC handler bodies (desktop IPC + remote WebSocket)
// ---------------------------------------------------------------------------
//
// Session-domain operations registered by BOTH `session.ipc.ts` (via
// `handleIpc`) and `remote-handlers.ts` (via `handleRemote`) had
// byte-identical (or near-identical) bodies duplicated across the two files.
// This module holds the ONE copy each surface delegates to, mirroring the
// `create-session.ts` precedent for `session:create`. Every exported function
// is envelope-neutral — it returns the raw value or throws, exactly as the
// original handlers did — and takes its dependencies (`manager`, `win`, ...)
// as explicit parameters rather than closing over module state, so both
// surfaces can call the same function with their own `manager`/`win`.
//
// Deliberately NOT shared:
//  - `session:create` — already shared via `create-session.ts`.
//  - `session:get-models` — desktop uses the cached `fetchModels()` with
//    auth-source reporting side effects (updates `claudeAuthProvider`/
//    `authManager`); remote uses an uncached minimal `supportedModels()`
//    query. Converging would change behavior and drag `authManager`/
//    `claudeAuthProvider` imports into a module the remote-handlers test
//    does not mock.
//  - `mockup:*` — per-registration stateful fs watchers (a `Map` closed over
//    per `registerXxxHandlers` call) + differing broadcast targets (desktop
//    mockup:watch only notifies `win`; remote notifies `win` + extra
//    windows) — stateful registration-time closures don't factor into a
//    stateless shared function cleanly.
//  - `session:delete-session`/`session:delete-project` and the trivial
//    `load-*`/`usage:*` passthroughs — single-line delegations to an
//    already-single-sourced service fn; extracting adds indirection with no
//    dedup value.
//  - `session:set-reasoning-variant` — desktop-only, no remote counterpart,
//    nothing to dedup.

// ---------------------------------------------------------------------------
// Session control
// ---------------------------------------------------------------------------

/**
 * Run a prompt turn and relay the user message back to all renderers (local +
 * remote) as the single source of truth for chat history. `queued` reflects
 * whether the session was already active when this call landed, so renderers
 * can show the message as pending (not yet in chat) until it's consumed.
 */
export function sendPrompt(
  manager: SessionManager,
  win: BrowserWindow,
  routingId: string,
  prompt: string,
  attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
): void {
  const session = manager.get(routingId)
  if (!session) throw new Error(`No session for routingId: ${routingId}`)
  // Check before run() — if session already active, the message will be queued
  const queued = session.willQueue
  session.run(prompt, attachments)
  const payload = { prompt, attachments, queued }
  if (!win.isDestroyed()) {
    win.webContents.send('session:user-message', routingId, payload)
  }
  for (const w of BaseSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:user-message', routingId, payload)
  }
}

/**
 * Apply a permission-mode change, or — when no session exists yet
 * (pre-spawn) — echo it to every other window looking at this routingId.
 *
 * A live session owns its own broadcast (`session.setPermissionMode` sends
 * `session:permission-mode` itself, including the reverted mode if the SDK
 * rejects the change), so this just delegates. Pre-spawn there is no session
 * object to broadcast from, but multiple clients (desktop + remote) can be
 * looking at the same pre-spawn session simultaneously — without this echo, a
 * pre-spawn mode pick on one client would never reach the others. The
 * originator's own optimistic store update (see `changePermissionMode` in
 * session-store.ts) makes the echo idempotent there; it only does real work
 * for every OTHER window. `mode` arrives as an untyped string over the
 * remote-reachable channel, so validate against PERMISSION_MODE_CYCLE before
 * echoing arbitrary values.
 */
export async function setPermissionMode(
  manager: SessionManager,
  win: BrowserWindow,
  routingId: string,
  mode: string
): Promise<void> {
  if (!PERMISSION_MODE_CYCLE.includes(mode as (typeof PERMISSION_MODE_CYCLE)[number])) {
    logger.warn('IPC', `session:set-permission-mode: rejecting unknown mode "${mode}"`)
    return
  }
  const session = manager.get(routingId)
  if (session) {
    await session.setPermissionMode(mode)
    return
  }
  if (!win.isDestroyed()) {
    win.webContents.send('session:permission-mode', routingId, mode)
  }
  for (const w of BaseSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:permission-mode', routingId, mode)
  }
}

export function watchBackground(
  manager: SessionManager,
  routingId: string,
  toolUseId: string
): void {
  const s = manager.get(routingId)
  if (s?.capabilities.backgroundTasks) s.watchBackground?.(toolUseId)
}

export function unwatchBackground(
  manager: SessionManager,
  routingId: string,
  toolUseId: string
): void {
  const s = manager.get(routingId)
  if (s?.capabilities.backgroundTasks) s.unwatchBackground?.(toolUseId)
}

export function readBackgroundRange(
  manager: SessionManager,
  routingId: string,
  toolUseId: string,
  offset: number,
  length: number
): string {
  const s = manager.get(routingId)
  if (s?.capabilities.backgroundTasks)
    return s.readBackgroundRange?.(toolUseId, offset, length) ?? ''
  return ''
}

export async function stopTask(
  manager: SessionManager,
  routingId: string,
  toolUseId: string
): Promise<{ success: boolean; error?: string }> {
  const session = manager.get(routingId)
  if (!session) return { success: false, error: 'No active session' }
  if (!session.capabilities.backgroundTasks)
    return { success: false, error: 'Provider does not support background tasks' }
  return (
    (await session.stopTask?.(toolUseId)) ?? {
      success: false,
      error: 'Provider does not support background tasks'
    }
  )
}

export async function backgroundTask(
  manager: SessionManager,
  routingId: string,
  toolUseId: string
): Promise<{ success: boolean; error?: string }> {
  const session = manager.get(routingId)
  if (!session) return { success: false, error: 'No active session' }
  if (!session.capabilities.backgroundTasks)
    return { success: false, error: 'Provider does not support background tasks' }
  return (
    (await session.backgroundTask?.(toolUseId)) ?? {
      success: false,
      error: 'Provider does not support background tasks'
    }
  )
}

export async function dequeueMessage(
  manager: SessionManager,
  routingId: string,
  value: string
): Promise<{ removed: number }> {
  const session = manager.get(routingId)
  return (await session?.dequeueMessage?.(value)) ?? { removed: 0 }
}

export async function askSideQuestion(
  manager: SessionManager,
  routingId: string,
  question: string
): Promise<string | null> {
  const session = manager.get(routingId)
  if (!session) return null
  if (!session.capabilities.sideQuestion) return null
  return await session.askSideQuestion(question)
}

export function setEffort(manager: SessionManager, routingId: string, effort: string): void {
  const s = manager.get(routingId)
  if (s?.capabilities.reasoning.effort != null) s.setEffort?.(effort)
}

export function setThinkingMode(manager: SessionManager, routingId: string, mode: string): void {
  const s = manager.get(routingId)
  if (s?.capabilities.reasoning.thinking != null) s.setThinkingMode?.(mode)
}

export function getPlanContent(manager: SessionManager, routingId: string): string | null {
  const s = manager.get(routingId)
  if (s?.capabilities.plan) return s.getPlanContent?.() ?? null
  return null
}

export function getSessionLogPath(manager: SessionManager, routingId: string): string | null {
  return manager.get(routingId)?.getSessionLogPath?.() ?? null
}

export async function mcpStatus(manager: SessionManager, routingId: string): Promise<unknown[]> {
  const session = manager.get(routingId)
  if (!session || !session.capabilities.hostedMcp || !session.mcpServerStatus) return []
  return await session.mcpServerStatus()
}

// ---------------------------------------------------------------------------
// Manager / cross-cutting
// ---------------------------------------------------------------------------

/**
 * Persist permission rules to the scope's settings.json and hot-reload every
 * session they can affect.
 *
 * Fan-out rule: a `user`-scope write reaches every session; a project/local
 * write only reaches sessions on that cwd. A missing `cwd` means the caller
 * could not scope it, so notify everyone rather than silently notifying no one.
 *
 * `notifySettingsChanged` is best-effort per session (a dead child, a session
 * whose engine has no hot-reload seam): the write already landed on disk, so a
 * failed refresh only costs immediacy — the next spawn reads the new rules.
 */
export function savePermissionsAndNotify(
  manager: SessionManager,
  scope: PermissionScope,
  permissions: ClaudePermissions,
  cwd?: string
): void {
  saveClaudePermissions(scope, permissions, cwd)
  manager.forEach((session) => {
    if (!cwd || session.cwd === cwd || scope === 'user') {
      session.notifySettingsChanged?.().catch(() => {})
    }
  })
}

// Transcript retention window (~/.claude/settings.json#cleanupPeriodDays)
export function setCleanupPeriod(manager: SessionManager, days: number): void {
  saveCleanupPeriodDays(days)
  // Hot-reload running CLI sessions so the new retention applies immediately.
  manager.forEach((session) => {
    session.notifySettingsChanged?.().catch(() => {})
  })
}

export function loadSkillDetails(manager: SessionManager, cwd: string) {
  // Delegate skill discovery to an active session for this cwd via the neutral
  // ISession.discoverSkills seam. Preserve historical precedence: an opencode
  // session on this cwd wins over Claude. With no active session (or only a
  // Claude one) fall back to the Claude scanner — identical to
  // ClaudeSession.discoverSkills, so behavior is unchanged.
  let delegate: ISession | undefined
  manager.forEach((session) => {
    if (session.cwd !== cwd) return
    if (!delegate || session.engineId === 'opencode') delegate = session
  })
  return delegate?.discoverSkills?.(cwd) ?? scanSkills(cwd)
}

/**
 * Persist session config and broadcast the change. `notifyMainWindow` mirrors
 * the `create-session.ts` rationale: the desktop IPC caller's own renderer
 * already knows the change locally (it originated the write), so only extra
 * windows need notifying; the remote WebSocket caller's change arrived
 * off-window, so the main window needs the broadcast too.
 */
export function saveSessions(
  win: BrowserWindow,
  config: UISessionConfig,
  opts: { notifyMainWindow: boolean }
): void {
  saveSessionConfig(config)
  if (opts.notifyMainWindow && !win.isDestroyed()) {
    win.webContents.send('config:sessions-changed', config)
  }
  for (const w of BaseSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('config:sessions-changed', config)
  }
}

/**
 * Persist UI settings and replicate every desktop side effect, regardless of
 * which surface (desktop IPC or remote WebSocket) originated the save.
 * `settings.json` is a single shared store — the main process must honor
 * persisted settings the same way no matter who wrote them, so ALL of the
 * following run unconditionally: stripping the engine/vendor-owned fields
 * (sandbox/proxy/anthropicEndpoint/modelOverride — they live in
 * engines/claude.json / vendors/anthropic.json now), persisting, mockup CSP
 * cache invalidation, usage/analytics interval propagation, log filter
 * application, re-applying proxy/endpoint/model env from the engine/vendor
 * stores, and session idle timeout propagation. The only per-surface
 * difference is broadcast targeting via `notifyMainWindow`, same rationale as
 * `saveSessions` above.
 */
export function saveUiSettings(
  manager: SessionManager,
  win: BrowserWindow,
  incomingSettings: UISettings,
  opts: { notifyMainWindow: boolean }
): void {
  // Strip engine/vendor-owned fields (sandbox, proxy, anthropicEndpoint, modelOverride)
  // that have moved to engines/claude.json and vendors/anthropic.json
  const raw = incomingSettings as Record<string, unknown>
  const settings: UISettings = Object.fromEntries(
    Object.entries(raw).filter(
      ([k]) => !['sandbox', 'proxy', 'anthropicEndpoint', 'modelOverride'].includes(k)
    )
  )
  saveSettings(settings)
  // Next mockup request re-reads settings to pick up CSP changes.
  invalidateMockupSecuritySettings()
  // Propagate usage refresh interval change
  if (typeof (settings as Record<string, unknown>).usageRefreshSecs === 'number') {
    usageFetcher.setIntervalSecs((settings as Record<string, unknown>).usageRefreshSecs as number)
  }
  // Propagate analytics refresh interval change
  if (typeof (settings as Record<string, unknown>).analyticsRefreshSecs === 'number') {
    blockUsageService.setDebounceSecs(
      (settings as Record<string, unknown>).analyticsRefreshSecs as number
    )
  }
  // Apply log level + filter changes immediately
  {
    const raw2 = settings as Record<string, unknown>
    const level = typeof raw2.logLevel === 'string' ? raw2.logLevel : undefined
    const filter = typeof raw2.logFilter === 'string' ? raw2.logFilter : undefined
    if (level !== undefined || filter !== undefined) {
      logger.applyFilter(filter ?? '', level as 'debug' | 'info' | 'warn' | 'error' | undefined)
    }
  }
  // Apply proxy/endpoint/model from engine/vendor stores (source of truth is now there)
  {
    const engCfg = loadEngineConfig('claude')
    const venCfg = loadVendorConfig('anthropic')
    applyProxyEnv(engCfg.proxy).catch(
      (err) => logger.error('Proxy', `Failed to apply proxy settings: ${err}`)
    )
    applyEndpointEnv(venCfg.endpoint)
    applyModelEnv(venCfg.modelOverride)
  }
  // Propagate session idle timeout change
  const timeoutMins = (settings as Record<string, unknown>).sessionTimeoutMins
  if (typeof timeoutMins === 'number') {
    manager.setSessionTimeout(timeoutMins * 60 * 1000)
  }
  if (opts.notifyMainWindow && !win.isDestroyed()) {
    win.webContents.send('config:settings-changed', settings)
  }
  for (const w of BaseSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('config:settings-changed', settings)
  }
}

// ---------------------------------------------------------------------------
// Stateless
// ---------------------------------------------------------------------------

export async function listDirEntries(dirPath: string): Promise<{
  entries: Array<{ name: string; isDirectory: boolean }>
  isRoot: boolean
  resolvedPath: string
}> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const HIDDEN_NAMES = new Set([
      'node_modules',
      '.git',
      '.DS_Store',
      '__pycache__',
      '.next',
      '.cache'
    ])
    const result: Array<{ name: string; isDirectory: boolean }> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || HIDDEN_NAMES.has(entry.name)) continue
      result.push({
        name: entry.name,
        isDirectory: entry.isDirectory() || entry.isSymbolicLink()
      })
    }
    // Sort: directories first, then alphabetical within each group
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    // Check if this directory is a filesystem root (parent resolves to itself)
    // Return resolved path in POSIX format so renderer can rewrite relative dirs
    const resolved = path.resolve(dirPath)
    const isRoot = path.dirname(resolved) === resolved
    const resolvedPosix = resolved.replace(/\\/g, '/').replace(/\/$/, '')
    return { entries: result, isRoot, resolvedPath: resolvedPosix }
  } catch {
    return { entries: [], isRoot: false, resolvedPath: '' }
  }
}
