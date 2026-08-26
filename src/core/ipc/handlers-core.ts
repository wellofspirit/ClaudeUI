import * as crypto from 'node:crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SessionManager } from '../services/session-manager'
import { scanSkills } from '../services/skill-scanner'
import { saveCleanupPeriodDays, saveClaudePermissions } from '../services/claude-settings'
import type {
  ClaudePermissions,
  EngineId,
  ListPlacesResult,
  PermissionScope
} from '../../shared/types'
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
import { emitEvent, syncCore } from '../services/sync-host'
import { deleteSessionByEngine } from '../services/session-delete'
import { deleteProjectFiles } from '../services/delete-session-files'
import { refreshCanonicalDirectories } from '../services/sync-seed'
import { unwatchSession } from '../services/session-watcher'
import { cwdToProjectKey } from '../../shared/project-key'
import { applyProxyEnv, applyEndpointEnv, applyModelEnv } from '../providers/claude-spawn-prep'
import type { ISession } from '../providers/ISession'
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
//  - the trivial `load-*`/`usage:*` passthroughs — single-line delegations to
//    an already-single-sourced service fn; extracting adds indirection with no
//    dedup value. `session:delete-session` / `session:delete-project` USED to be
//    on this list for exactly that reason; they stopped being single-line the
//    moment a delete had to cancel the live session and replicate the removal,
//    so they moved into this module — see §Deletion.
//  - `session:set-reasoning-variant` — desktop-only, no remote counterpart,
//    nothing to dedup.

// ---------------------------------------------------------------------------
// Session control
// ---------------------------------------------------------------------------

/**
 * Run a prompt turn and relay the user message back to all renderers (local +
 * remote) as the single source of truth for chat history.
 *
 * A prompt that lands while the session is busy goes to the QUEUE instead
 * (ADR-053): the session owns the item and broadcasts `session:queue-changed`,
 * which replaces the old `session:user-message {queued:true}` flavor. That
 * flavor was a lie by construction — it told every client "pending" with no id
 * to hang a later consume/recall off, so the transitions were guessed from turn
 * state. `session:user-message` now means exactly one thing: this text is in
 * the transcript.
 *
 * **Identity is minted HERE, not per client (SyncCore phase 4b).** The payload
 * used to carry `{prompt, attachments}` only, so every client invented its own
 * `msg-<uuid>`/`Date.now()` — meaning the same user turn had a different id in
 * each replica, and core (which must be clock- and randomness-free in the
 * reducer) could only mint a positional `user-<seq>`. With the snapshot becoming
 * the state of record, that difference would surface as a transcript whose ids
 * change under a client on every resync. One mint at the emitter is the fix; the
 * queue path already had stable `steer-<itemId>` ids and is unchanged.
 */
export function sendPrompt(
  manager: SessionManager,
  routingId: string,
  prompt: string,
  attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
): void {
  const session = manager.get(routingId)
  if (!session) throw new Error(`No session for routingId: ${routingId}`)
  // Check before run() — if the session is already active this send queues.
  if (session.willQueue) {
    session.enqueuePrompt(prompt, attachments)
    return
  }
  session.run(prompt, attachments)
  emitEvent('session:user-message', [
    routingId,
    // `msg-` prefix + randomUUID mirrors what the renderer minted, so nothing
    // downstream (React keys, retraction bookkeeping) sees a new id SHAPE.
    { id: `msg-${crypto.randomUUID()}`, timestamp: Date.now(), prompt, attachments }
  ])
}

/**
 * Apply a permission-mode change. Delegates to the session, which owns its own
 * broadcast (`session.setPermissionMode` sends `session:permission-mode` itself,
 * including the reverted mode if the SDK rejects the change).
 *
 * **The pre-spawn echo is gone (R5), because it could no longer do anything.**
 * It used to emit `session:permission-mode` when no session object existed, on
 * the theory that "multiple clients can be looking at the same pre-spawn session
 * simultaneously". They cannot: `createNewSession` (session-store.ts) registers a
 * not-yet-spawned session ONLY in its creating client's own replica and never
 * calls `window.api.createSession`, so no other client — and not canonical —
 * has ever heard of that routingId. The echo landed on nobody. It USED to look
 * like it worked because the reducer's `ensured()` minted a placeholder entry
 * for the unknown id; that placeholder was the `cwd: ''` ghost F7 deleted, and
 * with it gone the emit became an unconditional no-op with a ring entry attached.
 * The originator's own optimistic store write is, and always was, what makes a
 * pre-spawn pick visible — and the real config now reaches every client in the
 * birth event (`session:created`, 0065eef).
 *
 * `mode` still arrives as an untyped string over a remote-reachable channel, so
 * it is validated before being handed to the session.
 */
export async function setPermissionMode(
  manager: SessionManager,
  routingId: string,
  mode: string
): Promise<void> {
  if (!PERMISSION_MODE_CYCLE.includes(mode as (typeof PERMISSION_MODE_CYCLE)[number])) {
    logger.warn('IPC', `session:set-permission-mode: rejecting unknown mode "${mode}"`)
    return
  }
  await manager.get(routingId)?.setPermissionMode(mode)
}

// ---------------------------------------------------------------------------
// Deletion (F1 — a delete has to reach every replica, not just the deleter)
// ---------------------------------------------------------------------------
//
// Deleting used to mean "remove the FILES", full stop: the live engine process
// kept running, canonical kept the session forever (`SyncCore.removeSession` had
// zero production callers), and every client except the one that clicked delete
// kept a row pointing at a transcript that no longer exists. Worse, the deleting
// client's own replica could get the entry back — it dropped it locally, then a
// late event from the still-running engine re-minted a `cwd: ''` placeholder
// through the reducer's `ensured()` (closed by F7).
//
// The order below is the fix, and it is an order rather than a set:
//   1. unwatch — stop the transcript watcher, so the file's own disappearance
//                cannot fire one more update;
//   2. cancel  — stop the engine, so nothing can emit for this id afterwards;
//   3. remove  — one ringed `session:removed` every replica folds;
//   4. unlink  — the files, last, because they are the only irreversible step.
//
// Step 1 is not belt-and-braces. `session:watch-update` is the ONE reducer branch
// that still bootstraps an entry (`ensured()` — a watched session has no birth
// event, F2/F7), so an update that lands after the removal RE-MINTS the deleted
// session in canonical and in every replica. And unlinking a watched `.jsonl` is
// exactly what provokes one: `fs.watch` fires a change/rename for the deletion,
// and on Linux the watcher's own error path fires too. The debounced reload then
// reads a missing file, `loadSessionHistory` resolves to an empty transcript
// rather than throwing, and the watcher happily emits it.

/** Stop watching a transcript that is about to stop existing. Idempotent. */
function unwatchForDelete(sessionId: string): void {
  unwatchSession(sessionId)
}

/**
 * Delete one persisted session, everywhere.
 *
 * `sessionId` is also the routingId of a live session for it, when there is one
 * — that identity is what the status-driven rekey exists to establish.
 */
export async function deleteSession(
  manager: SessionManager,
  sessionId: string,
  projectKey: string,
  engineId?: EngineId
): Promise<void> {
  unwatchForDelete(sessionId)
  manager.cancel(sessionId)
  syncCore.removeSession(sessionId)
  await deleteSessionByEngine(sessionId, projectKey, engineId)
  // opencode / pi deletes touch no watched path, so nothing else would tell the
  // other clients their sidebar row is stale until the next poll.
  void refreshCanonicalDirectories()
}

/**
 * Delete a whole project: every session it owns, then its files.
 *
 * "Every session it owns" is the union of two sources, mirroring the store
 * action that used to be the only place this was computed: the sessions the
 * directory listing groups under this project key (on-disk, possibly never
 * spawned) and every LIVE session whose cwd maps to the same key (spawned, not
 * necessarily flushed to a group yet). Canonical is the source for both, so the
 * sweep works identically for a desktop click and a phone one.
 *
 * **`deleteProjectFiles` only removes CLAUDE's files**, and that asymmetry used
 * to resurrect the group it had just deleted. opencode keeps sessions in its own
 * server store and pi under `~/.pi`, so removing `~/.claude/projects/<key>` left
 * both engines' rows intact; the `refreshCanonicalDirectories()` below then
 * re-read them, the merge re-created a group for the same cwd, and the project
 * came back. On the desktop that lasted until the renderer's own follow-up loop
 * landed (up to the emit floor); over the remote surface there is no such loop,
 * so it was permanent. Deleting each foreign-engine session through its OWN
 * mechanism first is what makes the sweep complete on both surfaces.
 */
export async function deleteProject(manager: SessionManager, projectKey: string): Promise<void> {
  const state = syncCore.getCanonicalState()
  const group = state.directories.find((g) => g.projectKey === projectKey)
  const ids = new Set<string>(group?.sessions.map((s) => s.sessionId) ?? [])
  for (const [routingId, session] of Object.entries(state.sessions)) {
    if (cwdToProjectKey(session.cwd) === projectKey) ids.add(routingId)
  }
  for (const id of ids) {
    unwatchForDelete(id)
    manager.cancel(id)
    syncCore.removeSession(id)
  }

  // Engine-owned storage first (see above). `allSettled`: one engine being down
  // must not abandon the rest of the delete — the Claude unlink below is the
  // irreversible step and it still has to run.
  const foreign = (group?.sessions ?? []).filter((s) => s.engineId && s.engineId !== 'claude')
  const results = await Promise.allSettled(
    foreign.map((s) => deleteSessionByEngine(s.sessionId, projectKey, s.engineId))
  )
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn(
        'IPC',
        `session:delete-project: ${foreign[i].engineId} session ${foreign[i].sessionId} survived the delete`,
        result.reason
      )
    }
  })

  await deleteProjectFiles(projectKey)
  void refreshCanonicalDirectories()
}

/**
 * "Start fresh": reset a session's conversation in place.
 *
 * **PRECONDITION: the caller cancels the session first.** This handler does NOT
 * cancel, and that is a contract rather than an omission — its only UI caller
 * (`ExitPlanModeCard.handleStartFresh`) denies the plan approval,
 * `cancelSession`s the process, clears, and then `createSession`s a brand-new one
 * with no `resumeSessionId`, so the fresh cli.js starts with an empty context and
 * never sees the discarded plan turn. Cancelling here would double-cancel that
 * flow. Compaction is a different mechanism entirely (cli.js's own `/compact`,
 * which REWRITES the transcript and keeps the process) and is untouched.
 *
 * **The QUEUE is not optional, though.** `session:conversation-cleared` folds
 * `queue: []` into canonical and every replica, so leaving items in the engine's
 * own `SessionQueue` would make the queue of record disagree with the queue that
 * actually runs (ADR-053) — items would still be injected into the next turn with
 * no card, no take-back and no transcript row. `recallQueued()` is the honest
 * primitive: it asks the engine to drop each item and broadcasts them `recalled`,
 * so clients see them come back rather than silently vanish. After a cancel it is
 * a no-op (cancel already ran `recallQueuedOnEngineLoss`), which is exactly why
 * it is safe to run unconditionally — and it is what makes a BARE remote clear
 * (no cancel) correct too.
 *
 * What clearing did NOT do before is replicate: the clearing client blanked its
 * own replica and canonical kept the full transcript, so a resync — or any other
 * client, or the same client after a reconnect — still had the conversation the
 * user just cleared. The emit is that fix.
 *
 * `mode` arrives over a remote-reachable channel, so it is validated against
 * `PERMISSION_MODE_CYCLE` exactly like `setPermissionMode` does; anything else
 * is dropped and the reducer falls back to `'default'`.
 */
export async function clearConversation(
  manager: SessionManager,
  routingId: string,
  mode?: string
): Promise<void> {
  const permissionMode =
    typeof mode === 'string' &&
    PERMISSION_MODE_CYCLE.includes(mode as (typeof PERMISSION_MODE_CYCLE)[number])
      ? mode
      : undefined
  if (mode !== undefined && permissionMode === undefined) {
    logger.warn('IPC', `session:clear-conversation: ignoring unknown mode "${mode}"`)
  }
  // Best-effort: a dead child or an engine that refuses the dequeue must not
  // block the reset the user asked for — the fold below is what they see.
  try {
    await manager.get(routingId)?.recallQueued()
  } catch (err) {
    logger.warn('IPC', `session:clear-conversation: queue recall failed for ${routingId}`, err)
  }
  emitEvent('session:conversation-cleared', [routingId, { permissionMode }])
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

/**
 * Take back every still-recallable queued item (ADR-053). Replaces the
 * dequeue-by-value path, which could never match once two messages were queued
 * (the renderer coalesced them into one `\n`-joined blob, and no single engine
 * queue entry ever carried that text).
 */
export async function recallQueued(
  manager: SessionManager,
  routingId: string
): Promise<{ recalled: string[]; notRecalled: number }> {
  const session = manager.get(routingId)
  return (await session?.recallQueued()) ?? { recalled: [], notRecalled: 0 }
}

/**
 * @deprecated ADR-053 — recall-all shim behind the old channel, kept only so a
 * `/remote` bundle cached in a phone browser can still take messages back. It
 * ignores `value` (the blob it would send can no longer match anything) and
 * reports the recalled count as `removed`, which is what that client checks.
 * Remove once cached bundles of that vintage are no longer a concern.
 */
export async function dequeueMessage(
  manager: SessionManager,
  routingId: string,
  _value: string
): Promise<{ removed: number }> {
  const { recalled } = await recallQueued(manager, routingId)
  return { removed: recalled.length }
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

/**
 * `session:rekey` — an idempotent no-op shim (SyncCore phase 4a item 7).
 *
 * Core owns the rekey now: it applies the status-driven rule to canonical state
 * and re-keys the SessionManager in the same tick as the append
 * (`SessionManager`'s constructor subscribes to `syncCore.onRekey`). By the time
 * a client's `session:rekey` invoke lands, the old key is already gone — which is
 * exactly the state this shim reports success for.
 *
 * The channel stays because every client still invokes it (desktop
 * `useClaudeEvents`, web `api-adapter`) and a cached `/remote` bundle in a phone
 * browser will keep doing so for a while. Removing those call sites is 4c.
 *
 * `already-applied` is NOT an error: N clients each firing one invoke is the
 * as-built behavior, and the whole point of moving ownership into core is that
 * their duplicates now converge on one application instead of N.
 */
export function rekeyShim(
  manager: SessionManager,
  oldId: string,
  newId: string
): { ok: true; applied: boolean } {
  if (!manager.get(oldId)) {
    logger.debug('IPC', `session:rekey ${oldId} -> ${newId}: already applied by core (no-op)`)
    return { ok: true, applied: false }
  }
  // Reachable only if core did not own this transition (a client-invented rekey,
  // or a session created outside the funnel). Apply it rather than diverge.
  logger.warn(
    'IPC',
    `session:rekey ${oldId} -> ${newId}: applying a client-driven rekey core did not own`
  )
  manager.rekey(oldId, newId)
  return { ok: true, applied: true }
}

// ---------------------------------------------------------------------------
// Per-session config (SyncCore phase 4a item 6 — `session:config-changed`)
// ---------------------------------------------------------------------------
//
// Before 4a, `set-model` / `set-effort` / `set-thinking-mode` /
// `set-reasoning-variant` emitted nothing any client could map back into picker
// state (docs/architecture/remote.md defect 1): a model pick on a phone was
// invisible to the desktop, and a resync clobbered it with the desktop's
// ignorance. Each setter now emits ONE partial patch on the replicated
// `session:config-changed` channel:
//
//  - every subscriber, always — the originating client's own optimistic write
//    makes it idempotent there, and the reducer applies a per-field REPLACE, so
//    re-applying converges;
//  - only when the change was actually accepted: an engine without the
//    capability silently ignores the setter today, and announcing a value the
//    engine rejected would be the same lie the old `user-message {queued:true}`
//    flavor was;
//  - only when a SESSION EXISTS (R5). 4a emitted pre-spawn too, "because
//    multiple clients can be looking at the same not-yet-spawned session". They
//    cannot — a pre-spawn session lives only in its creating client's replica
//    (`createNewSession` never calls `window.api.createSession`), so nobody else
//    and not canonical has the routingId. With the reducer's `ensured()` gone
//    (F7) such an emit is an unconditional no-op that still costs a ring entry;
//    with `ensured()` present it minted the `cwd: ''` ghost. The birth event
//    carries the real config to every client (0065eef), which is what actually
//    solved the problem this echo was reaching for.

/**
 * One field of a session's config changed — emit the partial patch.
 *
 * Takes the SESSION rather than the routingId alone: an absent session is the
 * pre-spawn case, and the emit is dropped there (see the note above). Passing the
 * object every caller has already looked up is what makes that gate impossible to
 * forget — and it is the same object whose capability check decided whether the
 * change was accepted at all.
 */
function emitConfigChanged(
  session: ISession | undefined,
  routingId: string,
  patch: {
    model?: string
    effort?: string
    thinkingMode?: string
    reasoningVariant?: string | null
  }
): void {
  if (!session) return
  emitEvent('session:config-changed', [routingId, patch])
}

export async function setModel(
  manager: SessionManager,
  routingId: string,
  model: string
): Promise<void> {
  const session = manager.get(routingId)
  await session?.setModel(model)
  // `reasoningVariant: null` rides along because a model change genuinely
  // invalidates the variant (different models expose different variants) — the
  // desktop picker already resets it locally, so emitting only `model` would
  // leave every OTHER replica holding a variant that no longer exists.
  emitConfigChanged(session, routingId, { model, reasoningVariant: null })
}

export function setEffort(manager: SessionManager, routingId: string, effort: string): void {
  const s = manager.get(routingId)
  if (s && s.capabilities.reasoning.effort == null) return
  s?.setEffort?.(effort)
  emitConfigChanged(s, routingId, { effort })
}

export function setThinkingMode(manager: SessionManager, routingId: string, mode: string): void {
  const s = manager.get(routingId)
  if (s && s.capabilities.reasoning.thinking == null) return
  s?.setThinkingMode?.(mode)
  emitConfigChanged(s, routingId, { thinkingMode: mode })
}

export function setReasoningVariant(
  manager: SessionManager,
  routingId: string,
  variant: string | null
): void {
  const s = manager.get(routingId)
  s?.setReasoningVariant?.(variant)
  emitConfigChanged(s, routingId, { reasoningVariant: variant })
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
 * Persist session config and broadcast the change to every client.
 *
 * SyncCore phase 4c deleted the `notifyMainWindow` split. The desktop caller used
 * to be skipped on the theory that its renderer "already knew locally", which was
 * the delivery privilege in miniature: it meant the one client that could NOT be
 * corrected by the broadcast was the one whose optimistic write might be wrong.
 * The payload is a whole-config replace, so the echo is idempotent for the writer
 * and authoritative for everyone else.
 */
export function saveSessions(config: UISessionConfig): void {
  saveSessionConfig(config)
  emitEvent('config:sessions-changed', [config])
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
 * stores, and session idle timeout propagation. As of SyncCore phase 4c there is
 * no per-surface difference at all: the broadcast reaches every client including
 * the one that saved (see `saveSessions`).
 */
export function saveUiSettings(manager: SessionManager, incomingSettings: UISettings): void {
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
    applyProxyEnv(engCfg.proxy).catch((err) =>
      logger.error('Proxy', `Failed to apply proxy settings: ${err}`)
    )
    applyEndpointEnv(venCfg.endpoint)
    applyModelEnv(venCfg.modelOverride)
  }
  // Propagate session idle timeout change
  const timeoutMins = (settings as Record<string, unknown>).sessionTimeoutMins
  if (typeof timeoutMins === 'number') {
    manager.setSessionTimeout(timeoutMins * 60 * 1000)
  }
  emitEvent('config:settings-changed', [settings])
}

// ---------------------------------------------------------------------------
// Stateless
// ---------------------------------------------------------------------------

export async function listDirEntries(dirPath: string): Promise<{
  entries: Array<{ name: string; isDirectory: boolean }>
  isRoot: boolean
  resolvedPath: string
}> {
  // Nothing typed yet (the remote picker's opening state): seed the host's home
  // directory. Must branch BEFORE readdir — `readdir('')` throws into the empty
  // shape below, and `path.resolve('')` would answer the process cwd, which for
  // a packaged host is meaningless to the client. No capability change: fs-read
  // already lists any path by name.
  const target = dirPath || os.homedir()
  try {
    const entries = await fs.promises.readdir(target, { withFileTypes: true })
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
    const resolved = path.resolve(target)
    const isRoot = path.dirname(resolved) === resolved
    const resolvedPosix = resolved.replace(/\\/g, '/').replace(/\/$/, '')
    return { entries: result, isRoot, resolvedPath: resolvedPosix }
  } catch {
    return { entries: [], isRoot: false, resolvedPath: '' }
  }
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Reachable filesystem roots. On win32 there is no API to enumerate them, so
 * every letter is probed concurrently and the ones that answer are kept — an
 * unmapped letter simply throws ENOENT. POSIX has exactly one root.
 *
 * Each probe is bounded at 1.5 s ON ITS OWN. `access` against a stale mapped
 * network drive stays pending for the SMB timeout, and `home` + `hostname` ride
 * the same `listPlaces` promise — so one dead mapping would otherwise stall the
 * whole rail, header included. A letter that misses the bound drops out; every
 * fast letter still appears.
 */
async function probeDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const PROBE_TIMEOUT_MS = 1500
  const probes = await Promise.all(
    [...DRIVE_LETTERS].map(async (letter) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const reachable = await Promise.race([
          fs.promises.access(`${letter}:\\`).then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)
          })
        ])
        return reachable ? `${letter}:/` : null
      } catch {
        return null
      } finally {
        // Losing the race leaves the timer armed, and an armed timer holds the
        // event loop open — which for the bun-compiled server means a process
        // that will not exit. `clearTimeout` rather than `unref`: it behaves the
        // same on every runtime this file is built for.
        clearTimeout(timer)
      }
    })
  )
  return probes.filter((d): d is string => d !== null)
}

/**
 * The picker's places rail (ADR-046): where a browse can start, as opposed to
 * `listDirEntries`, which answers what is inside one directory.
 *
 * No capability change — this rides `fs-read` with the listing itself, and the
 * home path plus drive roots are strictly weaker than the arbitrary-path
 * listing that channel already grants. Best-effort throughout: a failure hides
 * one rail entry, so nothing here is allowed to throw.
 */
export async function listPlaces(): Promise<ListPlacesResult> {
  let home = ''
  try {
    const posix = os.homedir().replace(/\\/g, '/')
    // Trailing-slash strip mirrors `listDirEntries`' resolvedPath — but a
    // one-character home ('/') is the path, not a separator to trim.
    home = posix.length > 1 ? posix.replace(/\/$/, '') : posix
  } catch {
    home = ''
  }
  let hostname = ''
  try {
    hostname = os.hostname()
  } catch {
    hostname = ''
  }
  let drives: string[] = []
  try {
    drives = await probeDrives()
  } catch {
    drives = []
  }
  return { home, hostname, drives }
}
