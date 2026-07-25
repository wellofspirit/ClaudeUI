import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { BaseSession } from '../providers/BaseSession'
import { loadEngineConfig } from '../services/ui-config'
import { spawnPrepRegistry } from '../providers/SpawnPrepRegistry'
// Side-effect: guarantees the spawn-prep + session-factory registries are
// populated wherever session:create runs (mirrors session-manager.ts's own
// register-engines import).
import '../providers/register-engines'
import type { EngineId } from '../../shared/types'
import type { EngineSpawnOptions } from '../providers/ISession'

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
  const spawnOpts: EngineSpawnOptions = {
    effort,
    resumeSessionId,
    permissionMode,
    model: resolvedModel,
    sandboxConfig: engineCfg.sandbox,
    thinkingMode,
    resumeSessionAt,
    forkSession
  }
  // engineId (not resolvedEngineId) — SessionManager.create()'s own `= 'claude'`
  // default preserves the legacy claude-default boundary at that layer.
  manager.create(routingId, win, cwd, spawnOpts, engineId)
  // Desktop (notifyMainWindow=false) notifies only extra windows: the initiating
  // renderer already knows locally. Remote (notifyMainWindow=true) also notifies
  // the main window because the request arrived over WebSocket, not IPC.
  if (opts.notifyMainWindow && !win.isDestroyed()) {
    win.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
  for (const w of BaseSession.getExtraWindows()) {
    if (!w.isDestroyed()) w.webContents.send('session:created', routingId, { cwd, resumeSessionId })
  }
}
