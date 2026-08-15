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
 * Uses `loadSessionHistory` — the SAME source every client's own resume path
 * uses (`useClaudeEvents`'s `session:created` observer) — so canonical and every
 * replica start from identical content.
 *
 * `resumeSessionAt` is why "identical" needs saying: a FORK resumes from a
 * truncated prefix of its parent's transcript, and a seed that ignored the anchor
 * showed every client the parent's post-anchor turns above an engine that had
 * never seen them. Both seeds pass the anchor, so both truncate at the same line.
 */
async function seedCanonicalTranscript(
  routingId: string,
  resumeSessionId: string,
  cwd: string,
  resumeSessionAt?: string
): Promise<void> {
  try {
    const { messages, taskNotifications, statusLine } = await loadSessionHistory(
      resumeSessionId,
      cwdToProjectKey(cwd),
      resumeSessionAt
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
  //
  // The birth event carries the birth CONFIG. Without it the payload was
  // `{cwd, resumeSessionId}` only, so the reducer built the entry from
  // `emptySession()` — permissionMode 'default', engine 'claude', model 'default'
  // — and ONLY the originating client was right (its own `createNewSession`
  // seeds the replica). Every other client, and canonical itself (hence every
  // snapshot and every resync), showed the wrong mode/engine/model until some
  // later event happened to carry the real value. These are exactly the values
  // this session just spawned with, including the RESOLVED model, so no client
  // has to guess.
  //
  // `effort` / `thinkingMode` are deliberately NOT announced even though they are
  // right here in scope: the values that reach this function are already RESOLVED
  // spawn args (the renderer's `resolveSessionSdkOptions` substitutes the model's
  // default when the session's own value is `null`), while canonical's `effort` /
  // `thinkingMode` mean "the user explicitly picked this" — `null` is unset, and
  // `session:config-changed` only ever announces an accepted explicit pick.
  // Folding a resolved default in as an explicit one would freeze it: the effort
  // ladder is `session pick > per-model user default > engine heuristic`, so a
  // later change to the per-model default would stop reaching this session. Every
  // client already derives the same display default from `availableModels`, so
  // there is nothing to replicate here.
  emitEvent('session:created', [
    routingId,
    {
      cwd,
      resumeSessionId,
      // The fork/branch anchor, when there is one. It belongs on the birth event
      // for the same reason the spawn config does: only THIS function knows it,
      // and every client that reads the resumed transcript for itself has to
      // truncate at the same line the engine did, or a forked session renders its
      // parent's discarded turns. Absent = resume the whole transcript, which is
      // both the non-fork case and the old-shape fallback.
      ...(resumeSessionAt != null ? { resumeSessionAt } : {}),
      // Announced only when the CALLER named an engine, same rule as the other
      // fields: `resolvedEngineId` exists for every spawn (the claude default),
      // but announcing that default for a caller that omitted `engineId` would
      // clobber the session's real engine on every replica.
      ...(engineId != null ? { engineId: resolvedEngineId } : {}),
      // `!= null`, not `!== undefined`: a WS client's JSON turns an omitted
      // positional arg into an explicit `null`, and announcing `null` for a
      // field the canonical type declares as `string` would be a worse lie than
      // announcing nothing (the reducer folds an absent field as "leave it
      // alone"). `resolvedModel` is legitimately undefined when pi's catalog
      // probe fails — then no client is told anything and each keeps the model
      // it already had.
      ...(permissionMode != null ? { permissionMode } : {}),
      // BOTH guards: `model` (the request) and `resolvedModel` (the outcome).
      // The opencode/pi resolvers return a catalog fallback for an ABSENT
      // request — announcing that would rewrite the user's pick on every
      // replica just because a caller (e.g. a lazy re-spawn) didn't name one.
      // A real request that got swapped IS announced: converging the picker on
      // what actually spawned is the point.
      ...(model != null && resolvedModel != null ? { model: resolvedModel } : {})
    }
  ])
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
    void seedCanonicalTranscript(routingId, resumeSessionId, cwd, resumeSessionAt)
  }
}
