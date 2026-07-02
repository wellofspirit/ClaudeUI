import * as fs from 'fs'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { ClaudeSession } from '../services/claude-session'
import { scanSkills } from '../services/skill-scanner'
import { saveCleanupPeriodDays } from '../services/claude-settings'
import { saveSessionConfig } from '../services/ui-config'
import type { UISessionConfig } from '../services/ui-config'
import type { ISession } from '../providers/ISession'

// ---------------------------------------------------------------------------
// Shared session-domain IPC handler bodies (desktop IPC + remote WebSocket)
// ---------------------------------------------------------------------------
//
// Session-domain operations registered by BOTH `session.ipc.ts` (via
// `ipcMain.handle`) and `remote-handlers.ts` (via `dispatcher.register`) had
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
//  - `config:save-settings` — remote is a stale simplified copy missing
//    field-stripping (sandbox/proxy/anthropicEndpoint/modelOverride) + env
//    application (proxy/endpoint/model) + interval/timeout propagation — a
//    latent divergence needing its own behavior-changing fix, out of scope
//    here.
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
  for (const w of ClaudeSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:user-message', routingId, payload)
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
  for (const w of ClaudeSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('config:sessions-changed', config)
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
