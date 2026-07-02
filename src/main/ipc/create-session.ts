import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { ClaudeSession } from '../services/claude-session'
import { loadEngineConfig } from '../services/ui-config'
import { spawnPrepRegistry } from '../providers/SpawnPrepRegistry'
// Side-effect: guarantees the spawn-prep + session-factory registries are
// populated wherever session:create runs (mirrors session-manager.ts's own
// register-engines import).
import '../providers/register-engines'
import type { EngineId } from '../../shared/types'

// ---------------------------------------------------------------------------
// Shared session:create implementation (desktop IPC + remote WebSocket)
// ---------------------------------------------------------------------------

export interface CreateSessionArgs {
  routingId: string
  cwd: string
  effort?: string
  resumeSessionId?: string
  permissionMode?: string
  model?: string
  thinkingMode?: string
  resumeSessionAt?: string
  forkSession?: boolean
  engineId?: EngineId
}

/**
 * Resolves engine/vendor config, applies proxy/endpoint/model env for Claude
 * (or resolves the spawn model for opencode), and creates the session —
 * shared by the desktop IPC handler and the remote WebSocket handler so both
 * surfaces spawn sessions identically.
 */
export async function prepareAndCreateSession(
  manager: SessionManager,
  win: BrowserWindow,
  args: CreateSessionArgs,
  opts: { notifyMainWindow: boolean }
): Promise<void> {
  const {
    routingId,
    cwd,
    effort,
    resumeSessionId,
    permissionMode,
    model,
    thinkingMode,
    resumeSessionAt,
    forkSession,
    engineId
  } = args

  // engineId ?? 'claude' is the legacy default at the IPC/WS boundary (old callers
  // omit engineId). Any OTHER unrecognised id must throw — no silent Claude default.
  const resolvedEngineId = engineId ?? 'claude'
  const engineCfg = loadEngineConfig(resolvedEngineId)
  const prep = spawnPrepRegistry.require(resolvedEngineId)
  const { resolvedModel } = await prep(model, engineCfg)
  manager.create(
    routingId,
    win,
    cwd,
    effort,
    resumeSessionId,
    permissionMode,
    resolvedModel,
    engineCfg.sandbox,
    thinkingMode,
    resumeSessionAt,
    forkSession,
    engineId
  )
  // Desktop (notifyMainWindow=false) notifies only extra windows: the initiating
  // renderer already knows locally. Remote (notifyMainWindow=true) also notifies
  // the main window because the request arrived over WebSocket, not IPC.
  if (opts.notifyMainWindow && !win.isDestroyed()) {
    win.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
  for (const w of ClaudeSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
}
