import type { HostWindowHandle } from '../host'
import type { SessionManager } from '../services/session-manager'
import { emitEvent } from '../services/sync-host'
import { syncCore } from '../services/sync-host'
import { seedCanonicalTranscript } from './seed-canonical-transcript'
import { loadEngineConfig } from '../services/ui-config'
import { spawnPrepRegistry } from '../providers/SpawnPrepRegistry'
// Side-effect: guarantees the spawn-prep + session-factory registries are
// populated wherever session:create runs (mirrors session-manager.ts's own
// register-engines import).
import '../providers/register-engines'
import type { EngineId } from '../../shared/types'
import type { EngineSpawnOptions } from '../providers/ISession'
import { getSessionMeta } from '../services/db'

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
  /**
   * The values every replica adopts as this session's own on the birth event.
   * `effort`: a string = announce the positional spawn effort; `null` = the
   * client knows the model takes none (clears); absent/`undefined` = the client
   * does not know the model, announce nothing. `thinkingMode`: the raw pick
   * (`null` = no pick). Optional because older clients (a cached phone bundle)
   * omit it, and a WS client's JSON may carry `null` for it or for either field.
   */
  announce?: { effort?: string | null; thinkingMode?: string | null }
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
  win: HostWindowHandle | null,
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
    engineId,
    announce
  } = args

  // engineId ?? 'claude' is the legacy default at the IPC/WS boundary (old callers
  // omit engineId). Any OTHER unrecognised id must throw — no silent Claude default.
  const resolvedEngineId = engineId ?? 'claude'
  const storedEngine = resumeSessionId ? getSessionMeta(resumeSessionId)?.engineId : undefined
  if (storedEngine && storedEngine !== resolvedEngineId)
    throw new Error('Resume engine does not match persisted session identity')
  const engineCfg = loadEngineConfig(resolvedEngineId)
  const prep = spawnPrepRegistry.require(resolvedEngineId)
  const { resolvedModel } = await prep(model, engineCfg)
  const spawnOpts: EngineSpawnOptions = {
    effort,
    resumeSessionId,
    permissionMode,
    model: resolvedModel,
    // Claude's own sandbox feature, unrelated to Codex's native sandbox policy.
    sandboxConfig: resolvedEngineId === 'codex' ? undefined : engineCfg.sandbox,
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
  // `effort` / `thinkingMode` ride the event from `announce`, which only a
  // current client sends (an old one omits it, `null` over WS JSON): with no
  // `announce` the event carries NEITHER and every replica leaves its value
  // alone, exactly as before. With one, the event ALWAYS carries both — a string
  // or `null` — so a spawn can also CLEAR a value (a model that takes no effort,
  // a thinking pick that was reset); an absent field could only ever set.
  //
  // The announced `effort` is the POSITIONAL `effort` this process is spawned
  // with, not the value the client put in `announce` — the host announces what
  // it actually runs, so replicas cannot show a value the process does not have.
  // `announce.effort === null` is the renderer's "this model takes no effort"
  // signal and announces `null`; a string only says "announce the spawn effort".
  // `thinkingMode` is the client's RAW pick (the spawn arg beside it is a
  // resolved default).
  //
  // Canonical `effort` is null only BEFORE a session's first spawn — then the
  // per-model starting effort applies, and every client derives it from the
  // replicated `modelEffortDefaults` / `engineEffortDefaults`. At spawn the starting effort becomes the
  // session's OWN: this event hands it to every replica. Freezing it is the
  // intent: the per-model value is "Starting effort per model", and the display
  // must show what the process runs, so a later change to it (another session's
  // pick rewrites it) affects only sessions that have not started, never one
  // already running at the old value. The freeze lasts for the HOST RUN:
  // canonical `effort` is not persisted, so after a host restart a resumed
  // session re-resolves against the current per-model value — and, as it is
  // respawned with that value, still shows what its process runs. The same event
  // covers a Claude / pi pick (a local write plus a respawn, with no setter that
  // emits `session:config-changed`) and a PRE-spawn session (no live session for
  // `emitConfigChanged` to reach).
  // `announce.effort` has three states. A string: announce the positional spawn
  // effort. `null`: the client KNOWS the model takes no effort, so announce
  // `null` (clears). Absent / `undefined`: the client does not know the model
  // (empty or failed catalog), so announce NOTHING and every replica keeps the
  // effort it has — a `null` here would wipe a pick the process is still running
  // at. Electron's structured clone keeps an `undefined`-valued key and WS JSON
  // drops it; `!== undefined` treats both as absent. `thinkingMode` needs no such
  // state: it is the raw pick, where `null` correctly means "no pick".
  const announcedConfig =
    announce != null
      ? {
          ...(announce.effort !== undefined
            ? { effort: typeof announce.effort === 'string' ? (effort ?? null) : null }
            : {}),
          thinkingMode: typeof announce.thinkingMode === 'string' ? announce.thinkingMode : null
        }
      : {}
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
      ...(model != null && resolvedModel != null ? { model: resolvedModel } : {}),
      ...announcedConfig
    }
  ])
  // Canonical seeding (SyncCore phase 4a item 5): a RESUMED session's transcript
  // lives on disk, so canonical state has to read it from the same source the
  // renderer does (`loadSessionHistory`) or 4b's snapshot would hand every client
  // an empty conversation. A fresh session has nothing to seed — the
  // `session:created` apply already marks it seeded.
  //
  // Best-effort: a failed read must never break session creation, so nothing here
  // awaits it. But `seedSession` only fills an EMPTY transcript, so the read is
  // registered with core and `handlers-core.sendPrompt` waits on it — a prompt that
  // beat the read would otherwise be the transcript, and the history a no-op.
  if (resumeSessionId) {
    const read = seedCanonicalTranscript(
      routingId,
      resumeSessionId,
      cwd,
      resumeSessionAt,
      resolvedEngineId
    )
    // A respawn that did not pass through an exit (the session was disposed and
    // recreated in place) still holds its seeded transcript, so the read is a no-op
    // and a prompt has nothing to wait for.
    const held = syncCore.getCanonicalState().sessions[routingId]
    if (!(held?.seeded && held.messages.length > 0)) syncCore.trackSeed(routingId, read)
  }
}
