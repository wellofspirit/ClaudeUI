import type { BrowserWindow } from 'electron'
import type { SessionManager } from '../services/session-manager'
import { emitEvent } from '../services/sync-host'
import { syncCore } from '../services/sync-host'
import { loadSessionHistory } from '../services/session-history'
import { cwdToProjectKey } from '../../shared/project-key'
import { buildTodosFromMessages, buildSentFilesFromMessages } from '../../shared/derive-session'
import { logger } from '../services/logger'
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
 * Read a resumed session's on-disk transcript into canonical state.
 *
 * Uses `loadSessionHistory` — the SAME source the renderer's own resume path
 * uses (`useClaudeEvents`'s `session:created` handler) — so canonical and the
 * renderer replica start from identical content and the shadow comparator is
 * comparing interpretations, not inputs.
 */
async function seedCanonicalTranscript(
  routingId: string,
  resumeSessionId: string,
  cwd: string
): Promise<void> {
  try {
    const { messages, taskNotifications, statusLine } = await loadSessionHistory(
      resumeSessionId,
      cwdToProjectKey(cwd)
    )
    syncCore.seedSession(routingId, {
      cwd,
      messages,
      taskNotifications,
      ...(statusLine ? { statusLine } : {}),
      // Derived fields follow from the transcript, so derive them here rather
      // than leaving canonical to wait for the next live message.
      todos: buildTodosFromMessages(messages) ?? [],
      sentFiles: buildSentFilesFromMessages(messages) ?? []
    })
  } catch (err) {
    logger.warn(
      'create-session',
      `canonical seed failed for ${routingId} (shadow state starts empty): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

/**
 * Resolves engine/vendor config, applies proxy/endpoint/model env for Claude
 * (or resolves the spawn model for opencode), and creates the session —
 * shared by the desktop IPC handler and the remote WebSocket handler so both
 * surfaces spawn sessions identically.
 *
 * `win` is the HOST handle a session keeps (voice capture belongs to the machine
 * with the microphone), never a delivery target — every event a session emits
 * goes through the funnel to every subscriber (phase 4c). It is `null` when the
 * app runs windowless (phase 4d): a WS-created session spawns and streams
 * exactly the same, and only the host-local voice path is unavailable.
 */
export async function prepareAndCreateSession(
  manager: SessionManager,
  win: BrowserWindow | null,
  args: CreateSessionArgs
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
  // ONE emit, every subscriber (SyncCore phase 4c). The `notifyMainWindow`
  // asymmetry that lived here — desktop-originated creates skipped the initiating
  // renderer because it "already knew locally" — is deleted: the desktop renderer
  // is client #1 and learns about its own session from the same event as every
  // other client. The originator's own local `createNewSession` makes the arrival
  // idempotent (the handler no-ops when the session already exists).
  emitEvent('session:created', [routingId, { cwd, resumeSessionId }])
  // Canonical seeding (SyncCore phase 4a item 5): a RESUMED session's transcript
  // lives on disk, so canonical state has to read it from the same source the
  // renderer does (`loadSessionHistory`) or 4b's snapshot would hand every client
  // an empty conversation. A fresh session has nothing to seed — the
  // `session:created` apply already marks it seeded.
  //
  // Fire-and-forget and best-effort: this is SHADOW state in 4a, so a failed read
  // must never break session creation. `seedSession` only fills an EMPTY
  // transcript, so live events that arrive first always win.
  if (resumeSessionId) {
    void seedCanonicalTranscript(routingId, resumeSessionId, cwd)
  }
}
