/**
 * The client replica — SyncCore phase 4c (ADR-051 §"Replication model").
 *
 * One module owns every replicated slice of the renderer store. It holds a real
 * {@link CanonicalState} (plus the reducer's {@link ReducerAux}), folds
 * `applyEvent` over the raw event tap, and projects the result into Zustand in a
 * single `set()`. Both clients use it: the desktop over the MessagePort, the web
 * client over the WebSocket — same reducer, same projection, same bugs or none.
 *
 * ## Why a real CanonicalState and not a store→canonical inverse
 *
 * The obvious alternative is to fold over a canonical view *derived from the
 * store* on every event. That needs a lossy inverse mapping (the store carries
 * ~40 view-only fields the snapshot has never heard of, and `queuedItems` /
 * `hiddenSessionIds` are renamed) recomputed per event, and it silently launders
 * any store drift back into "canonical". Holding the real thing means the replica
 * is byte-comparable with `SyncCore.getCanonicalState()` — which is what the
 * hydration-parity e2e asserts, now that the shadow comparator is retired.
 *
 * ## Projection is identity-diffed, and that is load-bearing
 *
 * `applyEvent` is persistent: it returns the SAME object for slices it did not
 * touch. The projection exploits that — a `session:stream` delta rebuilds one
 * session entry and writes nothing app-level. Without the diff, every event would
 * re-write `settings`, `recentSessionIds`, and every session, so any in-flight
 * local write (a pick whose `config:*` echo has not landed yet) would be reverted
 * by the next unrelated delta, and every subscriber would re-render on every
 * token.
 *
 * ## The three ways state gets in
 *
 * 1. **The fold** — `onSyncAnyEvent` → `applyEvent` → project. The default, and
 *    the only path for anything an event carries. Since phase 5 S1 there is a
 *    SECOND feed on the same path: `onSyncStreamFrame` → `applyStreamFrame` →
 *    project, carrying the streaming deltas that left the event lane.
 * 2. **Hydration** — `sync-full` → `fromSnapshot` + `auxFromCanonical` → project
 *    everything. Carries ADR-041's local selection resolution (see
 *    {@link resolveActiveSessionId}).
 * 3. **Sanctioned local writes** — a small, named set for state that is genuinely
 *    client-originated or client-cached: cold history the host has never seen
 *    ({@link seedColdSession}), a watched session's re-read after its notify
 *    ({@link seedWatchedSession}), a session created before it has spawned
 *    ({@link patchLocalSession}), the desktop's own boot read of the config files
 *    ({@link seedLocalApp}), and the renderer's heap-bounding eviction
 *    ({@link evictLocalSessions}). Each writes CANONICAL and re-projects, so the
 *    invariant "the store's sealed fields equal the projection of canonical" holds
 *    after every one of them — which is exactly what a store-side write would
 *    break the moment the next event re-projected over it.
 *
 * The lint brand in `eslint.config.mjs` names this file as the only place a
 * sealed key may be written; `sealed-fields.ts` defines the set and explains why
 * the `canonical: false` channels are NOT in it.
 */

import { onSyncAnyEvent, onSyncStreamFrame } from '../../../shared/sync/client-registry'
import { channelSpec } from '../../../shared/sync/channels'
import {
  applyStreamFrame,
  dropStreamTurns,
  type StreamFrame
} from '../../../shared/sync/stream'
import {
  applyEvent,
  applyWatchedContent,
  auxFromCanonical,
  emptyAux,
  rekeyTargetFor,
  type ReducerAux,
  type WatchedContent
} from '../../../shared/sync/reducer'
import {
  emptyCanonicalState,
  emptySession,
  fromSnapshot,
  type CanonicalSessionState,
  type CanonicalState
} from '../../../shared/sync/state'
import type { FullStateSnapshot } from '../../../shared/remote-protocol'
import { AUTONOMY_TO_PERMISSION } from '../../../shared/permission-modes'
import type { PermissionMode, SessionStatus, WorktreeInfo } from '../../../shared/types'
import {
  useSessionStore,
  EMPTY_SESSION_STATE,
  DEFAULT_SETTINGS,
  applyTheme,
  type AppSettings,
  type PerSessionState,
  type SessionState
} from './session-store'

// ---------------------------------------------------------------------------
// Replica state
// ---------------------------------------------------------------------------

let canonical: CanonicalState = emptyCanonicalState()
let aux: ReducerAux = emptyAux()
/** The installed raw-event tap's unsubscribe, or null — see {@link startReplica}. */
let tapOff: (() => void) | null = null
/** The volatile lane's tap (phase 5 S1). */
let streamTapOff: (() => void) | null = null

/** Post-apply observers — see {@link onReplicaApplied}. */
type PostApplyObserver = (channel: string, args: unknown[]) => void
const observers = new Set<PostApplyObserver>()

/**
 * Read the replica's canonical state. Diagnostics + tests only — components read
 * the store, which is the projection of exactly this.
 */
export function getReplicaState(): CanonicalState {
  return canonical
}

/**
 * The replica's reducer aux (thinking spans + stream generations). Diagnostics +
 * tests only — in production the only reader is the fold itself.
 */
export function getReplicaAux(): ReducerAux {
  return aux
}

/**
 * Observe events AFTER their fold has been committed to the store.
 *
 * This is where the *side-effect halves* of the old per-channel handlers live:
 * notification sounds, attention marks, the historical-transcript load a
 * `session:created` triggers, the custom-command re-scan a `session:slash-commands`
 * triggers. They READ state (already up to date) and never write a sealed field —
 * that is the whole distinction between an observer and a handler.
 */
export function onReplicaApplied(cb: PostApplyObserver): () => void {
  observers.add(cb)
  return () => {
    observers.delete(cb)
  }
}

/**
 * Subscribe the replica to the transport's event stream.
 *
 * Called once, from the entry point, BEFORE React mounts — the fold must own the
 * store's replicated slices from the first event, and `SyncClient`'s readiness
 * gate (phase 0) is what makes "before React" safe rather than lossy.
 */
export function startReplica(): () => void {
  // Idempotent: the web entry can only reach this after its lazy store import, so
  // it calls it on every `sync-full` rather than once at page load. A second tap
  // would fold every event twice.
  if (tapOff) return stopReplica
  tapOff = onSyncAnyEvent((event) => {
    // The CLASSIFICATION decides, not a per-event guess: a channel with no
    // snapshot field has nothing to fold into, and its transient store writer
    // stays (sealed-fields.ts §TRANSIENT_*).
    if (channelSpec(event.channel)?.canonical) {
      // Computed BEFORE the fold, exactly as `SyncCore.pendingRekeyFor` does:
      // afterwards the old id is gone from the map.
      const rekey = pendingRekeyFor(event)
      const removed = removedIdOf(event)
      commit(applyEvent(canonical, event, aux), { rekey, removed })
      if (rekey) persistRekeyedRegistry(rekey.newId)
      // The host now owns this id (or has dropped it) — either way it stops being
      // this client's private invention. A rekey carries the marker across, since
      // the pre-rekey id named the same still-private session.
      if (event.channel === 'session:created') locallyCreated.delete(routingIdOf(event))
      if (removed) locallyCreated.delete(removed)
      if (rekey && locallyCreated.delete(rekey.oldId)) locallyCreated.add(rekey.newId)
    }
    for (const observer of observers) {
      try {
        observer(event.channel, event.args)
      } catch {
        /* one broken observer must not stop the others */
      }
    }
  })
  // The volatile lane's fold (phase 5 S1). A second feed, not a second writer:
  // `applyStreamFrame` writes the same sealed streaming fields the reducer used
  // to, through the same `commit` + identity-diffed projection.
  streamTapOff = onSyncStreamFrame(foldStreamFrame)
  return stopReplica
}

/** Detach both feeds. One function so the idempotent early return can hand it back. */
function stopReplica(): void {
  tapOff?.()
  tapOff = null
  streamTapOff?.()
  streamTapOff = null
}

// ---------------------------------------------------------------------------
// The volatile stream lane (phase 5 S1)
// ---------------------------------------------------------------------------

/** Re-send the current `stream:watch` set — installed by the watch effect. */
let rewatch: (() => void) | null = null
let rewatchTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Register the cure for a stream mismatch.
 *
 * The replica is what DETECTS a mismatch (it holds the offsets), and the watch
 * effect is what knows the current set, so the two are wired here rather than
 * either one guessing at the other's job.
 */
export function setStreamRewatch(fn: (() => void) | null): void {
  rewatch = fn
}

/**
 * A frame whose offset or generation does not fit is a NO-OP, and the cure is to
 * re-send the watch set: the server answers with the coalesced value at
 * `offset: 0`, which is a REPLACE by construction.
 *
 * Debounced, because a mismatch is usually the FIRST of a burst — one dropped
 * frame invalidates every later offset of that stream — and one re-watch heals
 * all of them.
 */
function scheduleRewatch(): void {
  if (rewatchTimer !== null) return
  rewatchTimer = setTimeout(() => {
    rewatchTimer = null
    rewatch?.()
  }, STREAM_REWATCH_DEBOUNCE_MS)
}

const STREAM_REWATCH_DEBOUNCE_MS = 50

function foldStreamFrame(frame: StreamFrame): void {
  const outcome = applyStreamFrame(canonical, aux, frame)
  if (outcome.result === 'mismatch') {
    scheduleRewatch()
    return
  }
  // `unknown` is an honest no-op: a frame for a session this client has never
  // heard of (a delete it already folded, a watch that outlived a selection).
  if (outcome.result === 'unknown') return
  commit(outcome.state)
}

/**
 * Does this event imply a rekey (the engine reported a stable session id that
 * differs from the routing id the session was created under)?
 *
 * The reducer applies the move itself — to `sessions` and to every id-keyed
 * app-level map — so the client no longer has a `rekeySession` action and no
 * longer invokes `session:rekey` (core re-keys its own registry in the same tick
 * it emits the status). What the CLIENT still owes is the two things canonical
 * cannot do for it: carry this session's view state (draft, panels, scroll) to the
 * new key, and persist the renamed registry config to `sessions.json`.
 */
function pendingRekeyFor(event: { channel: string; args: unknown[] }): Rekey | null {
  if (event.channel !== 'session:status') return null
  const oldId = event.args[0]
  if (typeof oldId !== 'string') return null
  const newId = rekeyTargetFor(canonical, oldId, event.args[1] as SessionStatus | undefined)
  return newId ? { oldId, newId } : null
}

/**
 * Sessions THIS client invented that the host has never heard of.
 *
 * `createNewSession` registers a session in the replica before anything spawns
 * (`patchLocalSession` with `create: true`) and never calls
 * `window.api.createSession` — the spawn happens on the first send. So between
 * those two moments the entry exists here and nowhere else: not in canonical, not
 * in any other client.
 *
 * That distinction has no other representation, which is why it needs a set.
 * Every cheaper proxy is ambiguous: `sdkActive: false`, `messages: []`,
 * `seeded: false` and `evicted: false` all describe a brand-new local session AND
 * a real host session that was cancelled before its first prompt. The store's
 * `cleanupEmptySession` used the ambiguous version and therefore discarded the
 * second kind on every switch — and post-F7 the host's later events for it are
 * honest no-ops, so it did not come back.
 *
 * An id leaves the set the moment the host announces it (`session:created`) or
 * removes it. Membership is a lower bound on "safe to forget locally", never an
 * upper bound on what exists.
 */
const locallyCreated = new Set<string>()

/**
 * Did THIS client create this session without the host ever being told?
 *
 * The only sanctioned use is the store's empty-session cleanup: it may drop an
 * abandoned scratch session, and must not drop anything the host knows about.
 */
export function isLocallyCreated(routingId: string): boolean {
  return locallyCreated.has(routingId)
}

/**
 * The id an explicit DELETE just removed, or null.
 *
 * Only `session:removed` counts. Sessions leave the replica for other reasons —
 * the empty-session cleanup on a switch (`dropLocalSessions`), the retiring half
 * of a rekey — and neither is a statement about what this client should be
 * LOOKING at, so neither may touch the selection.
 */
function removedIdOf(event: { channel: string; args: unknown[] }): string | null {
  if (event.channel !== 'session:removed') return null
  return typeof event.args[0] === 'string' ? event.args[0] : null
}

/** `args[0]` as a routing id, or `''` — the wire's positional session scoping. */
function routingIdOf(event: { args: unknown[] }): string {
  return typeof event.args[0] === 'string' ? event.args[0] : ''
}

/**
 * Persist the post-rekey registry, and guarantee the new id has a
 * `sessionEngines` row.
 *
 * The reducer renamed the existing rows; a session that never had one (created
 * before its engine was recorded) needs it minted from the session's own choices,
 * or reopening it from the sidebar would resolve Claude defaults for a pi /
 * opencode conversation.
 */
function persistRekeyedRegistry(newId: string): void {
  const session = canonical.sessions[newId]
  if (!session) return
  const store = useSessionStore.getState()
  if (!canonical.sessionEngines[newId]) {
    store.recordSessionEngine(newId, session.selectedEngineId, session.selectedModel)
    return
  }
  store.persistSessionRegistry()
}

// ---------------------------------------------------------------------------
// Hydration (`sync-full`)
// ---------------------------------------------------------------------------

/**
 * Apply a full snapshot — the initial sync, and every reconnect re-sync.
 *
 * Replaces `applyRemoteSnapshot`, and keeps its two hard-won behaviours verbatim
 * because both were bug fixes:
 *
 *  - **Session MERGE on a resync.** A client that backgrounded and returned may
 *    have navigated to a historical session the host's snapshot knows nothing
 *    about (`loadHistoricalSession` reads disk, not canonical). Replacing the map
 *    would drop it and route the next prompt at a session that no longer exists.
 *    Snapshot entries still win where both sides know the session.
 *  - **App-level catalogs survive an empty snapshot.** `slashCommands` /
 *    `sdkSkillNames` ride the wire per SESSION, so a snapshot with no sessions
 *    cannot carry them at all (`shared/sync/state.ts` records the gap). Keeping
 *    the current value is what stops a cold desktop boot from blanking the slash
 *    menu that `hydrateConfigFromDisk` just filled in.
 */
export function hydrateReplica(snapshot: FullStateSnapshot, isResync = false): void {
  const restored = fromSnapshotSafe(snapshot)
  const sessions = isResync ? { ...canonical.sessions, ...restored.sessions } : restored.sessions
  const next: CanonicalState = {
    ...restored,
    sessions,
    slashCommands:
      restored.slashCommands.length > 0 ? restored.slashCommands : canonical.slashCommands,
    sdkSkillNames:
      restored.sdkSkillNames.length > 0 ? restored.sdkSkillNames : canonical.sdkSkillNames
  }
  aux = auxFromCanonical(next)
  const activeSessionId = resolveActiveSessionId(snapshot, next, isResync)
  commit(next, { force: true, activeSessionId })
}

/**
 * `fromSnapshot`, tolerant of an older host.
 *
 * `fromSnapshot` reads `snapshot.sessions` and the app-level fields with `??`
 * fallbacks already; this wrapper exists only to coerce the one value whose TYPE
 * changed under us — a pre-removal remote server can still send
 * `permissionMode: 'localAuto'`, a mode this client's union no longer has.
 */
function fromSnapshotSafe(snapshot: FullStateSnapshot): CanonicalState {
  const state = fromSnapshot(snapshot)
  for (const session of Object.values(state.sessions)) {
    if (session.permissionMode === 'localAuto') session.permissionMode = 'auto'
  }
  return state
}

/**
 * Selection is per-client VIEW state (ADR-041) and since phase 4b the snapshot
 * serves `activeSessionId: null` on purpose — a host-wide selection is not
 * something a shared state can have. Resolve it locally, in preference order:
 *
 *  1. this client's own selection on a RE-sync — a phone that navigated to a
 *     historical session must not be yanked off it by a reconnect (a stale
 *     pointer that no longer resolves post-merge is skipped: a broken view is
 *     worse than a fallback);
 *  2. whatever the server offered, for an older host that still sends one;
 *  3. the most recent session THIS snapshot knows about — the landing spot that
 *     replaces "the desktop's current session" for a fresh client. Empty ⇒ null
 *     ⇒ the welcome screen, which is also the honest answer when the host has no
 *     sessions at all.
 */
function resolveActiveSessionId(
  snapshot: FullStateSnapshot,
  next: CanonicalState,
  isResync: boolean
): string | null {
  const local = useSessionStore.getState().activeSessionId
  return (
    [
      isResync ? local : null,
      snapshot.activeSessionId,
      ...(snapshot.recentSessionIds ?? [])
    ].find((id): id is string => !!id && !!next.sessions[id]) ?? null
  )
}

// ---------------------------------------------------------------------------
// Sanctioned local writes
// ---------------------------------------------------------------------------

/**
 * Seed a session's transcript from disk — the cold-history path canonical cannot
 * hold (the host only seeds sessions it has SPAWNED; browsing an old session in
 * the sidebar spawns nothing).
 *
 * Idempotent by id, with the same guard `SyncCore.seedSession` uses: a seed that
 * arrives after live events have already streamed in records that it happened and
 * leaves the content alone. Without that, a slow `loadSessionHistory` resolving
 * mid-turn would blow away the turn.
 */
export function seedColdSession(
  routingId: string,
  seed: Partial<CanonicalSessionState> & { cwd?: string }
): void {
  const existing = canonical.sessions[routingId]
  if (existing && existing.messages.length > 0 && (seed.messages?.length ?? 0) > 0) {
    commit({
      ...canonical,
      sessions: { ...canonical.sessions, [routingId]: { ...existing, seeded: true } }
    })
    return
  }
  const base = existing ?? emptySession(routingId, seed.cwd ?? '')
  commit({
    ...canonical,
    sessions: {
      ...canonical.sessions,
      [routingId]: { ...base, ...seed, routingId, seeded: true }
    }
  })
}

/**
 * Seed a WATCHED external session's transcript — {@link seedColdSession}'s
 * REPLACE twin, and the client half of `SyncCore.seedWatchedSession` (phase 5 S4).
 *
 * Same split, same reason, both sides of the wire: `seedColdSession` refuses to
 * clobber a live transcript, because the session it seeds is spawned and a slow
 * disk read resolving mid-turn would wipe the turn. A watched session spawns
 * nothing — its `.jsonl` is the only writer, and the refetch this serves fires
 * BECAUSE that file grew — so filling-only would freeze the transcript at its
 * first read.
 *
 * Both sides apply {@link applyWatchedContent}, so canonical and this replica
 * derive the same todos / sentFiles / dismissal from the same transcript, which is
 * what keeps the hydration-parity e2e true.
 *
 * A no-op for an unknown id: the refetch is async, and a `session:removed` may
 * have landed while it was in flight (F7 — a delete must not be re-minted).
 */
export function seedWatchedSession(routingId: string, content: WatchedContent): void {
  const existing = canonical.sessions[routingId]
  if (!existing) return
  commit({
    ...canonical,
    sessions: { ...canonical.sessions, [routingId]: applyWatchedContent(existing, content) }
  })
}

/**
 * Write a session's replicated fields from a LOCAL origin — a session created
 * before it has spawned (so no `session:created` exists yet and the engine/model
 * pick lives nowhere else), a fork seeded from its parent, a conversation
 * cleared, or an sdk-active flag the UI flips itself.
 *
 * Every one of these is a value that an event WOULD carry if there were an event;
 * routing them through canonical is what keeps the next projection from reverting
 * them to `emptySession()` defaults. `create: false` makes the call a no-op for an
 * unknown id, matching the store's `updateSession` contract.
 */
export function patchLocalSession(
  routingId: string,
  patch: Partial<CanonicalSessionState>,
  options: { create?: boolean } = {}
): void {
  const existing = canonical.sessions[routingId]
  if (!existing && !options.create) return
  // A session that appears here FIRST, before any event, is this client's own —
  // see {@link locallyCreated} for why that has to be recorded, not inferred.
  if (!existing) locallyCreated.add(routingId)
  const base = existing ?? emptySession(routingId, patch.cwd ?? '')
  commit({
    ...canonical,
    sessions: { ...canonical.sessions, [routingId]: { ...base, ...patch, routingId } }
  })
}

/** Drop sessions from the replica (explicit delete / empty-session cleanup). */
export function dropLocalSessions(routingIds: readonly string[]): void {
  let sessions = canonical.sessions
  for (const id of routingIds) {
    locallyCreated.delete(id)
    if (!sessions[id]) continue
    if (sessions === canonical.sessions) sessions = { ...sessions }
    delete sessions[id]
    delete aux.thinkingOpen[id]
    dropStreamTurns(aux, id)
  }
  if (sessions === canonical.sessions) return
  commit({ ...canonical, sessions })
}

/**
 * Strip the heavy arrays of cold sessions — the renderer's heap bound (Opus B).
 *
 * Applied to the REPLICA rather than to the store, because a store-side strip
 * would be undone by the next projection. Canonical on the HOST deliberately does
 * not evict (`docs/architecture/sync-channels.md` §Eviction); this is a per-client
 * cache decision, and the entry keeps `seeded: false` so a later re-select
 * re-hydrates through {@link seedColdSession} instead of being treated as complete.
 */
export function evictLocalSessions(routingIds: readonly string[]): void {
  let sessions = canonical.sessions
  for (const id of routingIds) {
    const session = sessions[id]
    if (!session) continue
    if (sessions === canonical.sessions) sessions = { ...sessions }
    sessions[id] = {
      ...session,
      messages: [],
      streamingText: '',
      streamingThinking: '',
      subagentMessages: {},
      subagentStreamingText: {},
      subagentStreamingThinking: {},
      seeded: false
    }
    delete aux.thinkingOpen[id]
    // The stripped buffers are back to length 0, so their generations restart —
    // otherwise the next live delta would arrive at an offset this entry no
    // longer has and cost a re-watch round trip.
    dropStreamTurns(aux, id)
  }
  if (sessions === canonical.sessions) return
  commit({ ...canonical, sessions })
}

/**
 * Seed app-level replicated state from the desktop's own boot read of
 * `~/.claude/ui/` (`hydrateConfigFromDisk`).
 *
 * Not a competing source of truth: `services/sync-seed.ts` seeds canonical on the
 * host from the SAME files at the same point in boot, so whichever lands second
 * writes equal values. It exists because the desktop reads those files
 * synchronously-ish at startup and must have a theme and a sidebar before the
 * port's first `sync-full` arrives — without it, boot would flash defaults.
 */
export function seedLocalApp(patch: Partial<Omit<CanonicalState, 'sessions'>>): void {
  commit({ ...canonical, ...patch })
}

/**
 * Apply a registry-config change locally (pins / titles / hidden / recents /
 * sessionEngines / worktree map / settings).
 *
 * These are client-ORIGINATED writes that persist through
 * `config:save-sessions` / `config:save-settings` and come back as a
 * `config:*-changed` echo, which since 4c reaches the saver too. The echo is a
 * whole-config REPLACE, so applying it here first is idempotent — and it is what
 * keeps the sidebar from lagging a round trip behind the click on a phone.
 */
export function patchLocalApp(patch: Partial<Omit<CanonicalState, 'sessions'>>): void {
  commit({ ...canonical, ...patch })
}

/** Test seam — production hydrates exactly once per page. */
export function resetReplicaForTests(): void {
  canonical = emptyCanonicalState()
  aux = emptyAux()
  locallyCreated.clear()
  observers.clear()
  rewatch = null
  if (rewatchTimer !== null) {
    clearTimeout(rewatchTimer)
    rewatchTimer = null
  }
  stopReplica()
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** A session id move the reducer just performed — see {@link pendingRekeyFor}. */
interface Rekey {
  oldId: string
  newId: string
}

interface CommitOptions {
  /** Write every sealed field, skipping the identity diff (hydration). */
  force?: boolean
  /** Resolved per-client selection (hydration only — never derived from canonical). */
  activeSessionId?: string | null
  rekey?: Rekey | null
  /** A `session:removed` id — the one drop that may clear the selection. */
  removed?: string | null
}

function commit(next: CanonicalState, options: CommitOptions = {}): void {
  const prev = canonical
  canonical = next
  if (prev === next && !options.force && options.activeSessionId === undefined) return
  useSessionStore.setState((state) => buildPatch(state, prev, next, options))
}

function buildPatch(
  state: SessionState,
  prev: CanonicalState,
  next: CanonicalState,
  options: CommitOptions
): Partial<SessionState> {
  const force = options.force === true
  const patch: Partial<SessionState> = {}

  if (options.activeSessionId !== undefined) patch.activeSessionId = options.activeSessionId

  // Selection is per-client view state, so canonical cannot clear it for us — but
  // a session that was explicitly DELETED is gone for everyone, and leaving this
  // client pointed at it renders EMPTY_SESSION_STATE forever. Handled here rather
  // than in the delete ACTION so a delete driven from a phone lands the same way
  // on the desktop.
  if (
    options.removed &&
    state.activeSessionId === options.removed &&
    patch.activeSessionId === undefined
  ) {
    patch.activeSessionId = null
  }

  // --- app-level ----------------------------------------------------------
  if (force || prev.directories !== next.directories) patch.directories = next.directories
  if (force || prev.recentSessionIds !== next.recentSessionIds) {
    patch.recentSessionIds = next.recentSessionIds
  }
  if (force || prev.pinnedSessionIds !== next.pinnedSessionIds) {
    patch.pinnedSessionIds = next.pinnedSessionIds
  }
  if (force || prev.customTitles !== next.customTitles) patch.customTitles = next.customTitles
  if (force || prev.sessionEngines !== next.sessionEngines) patch.sessionEngines = next.sessionEngines
  if (force || prev.hiddenSessions !== next.hiddenSessions) {
    patch.hiddenSessionIds = next.hiddenSessions
  }
  if (force || prev.hiddenProjects !== next.hiddenProjects) {
    patch.hiddenProjectKeys = next.hiddenProjects
  }
  if (force || prev.worktreeInfoMap !== next.worktreeInfoMap) {
    patch.worktreeInfoMap = next.worktreeInfoMap
  }
  if (force || prev.slashCommands !== next.slashCommands) patch.slashCommands = next.slashCommands
  if (force || prev.sdkSkillNames !== next.sdkSkillNames) patch.sdkSkillNames = next.sdkSkillNames
  if (force || prev.autoModeDisabledBySettings !== next.autoModeDisabledBySettings) {
    patch.autoModeDisabledBySettings = next.autoModeDisabledBySettings
  }
  if (force || prev.settings !== next.settings) {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, ...(next.settings as Partial<AppSettings>) }
    patch.settings = settings
    // Derived, not replicated: the web client never runs `hydrateConfigFromDisk`,
    // so the fields that hydration derives from settings must be derived here too
    // — otherwise a remote-created session spawns without the configured autonomy
    // default (createNewSession reads the INITIATING client's store).
    patch.defaultPermissionMode = AUTONOMY_TO_PERMISSION[settings.defaultAutonomyMode] ?? 'default'
    if (settings.theme !== state.settings.theme) applyTheme(settings.theme)
  }

  // --- per session --------------------------------------------------------
  const rekey = options.rekey ?? null
  const worktreesMoved = force || prev.worktreeInfoMap !== next.worktreeInfoMap
  if (force || prev.sessions !== next.sessions || worktreesMoved || rekey) {
    let changed = false
    const sessions: Record<string, PerSessionState> = { ...state.sessions }
    // A rekey carries the OLD entry's view state to the new key and retires the
    // old one — without this the store would hold both ids and split-brain the
    // session (the bug the deleted `rekeySession` action existed to avoid).
    if (rekey && sessions[rekey.oldId]) {
      sessions[rekey.newId] = sessions[rekey.oldId]
      delete sessions[rekey.oldId]
      changed = true
      if (state.activeSessionId === rekey.oldId) patch.activeSessionId = rekey.newId
    }
    for (const [id, c] of Object.entries(next.sessions)) {
      const resident = sessions[id]
      const untouched =
        !force &&
        !(rekey && rekey.newId === id) &&
        resident !== undefined &&
        prev.sessions[id] === c &&
        prev.worktreeInfoMap[id] === next.worktreeInfoMap[id]
      if (untouched) continue
      sessions[id] = projectSession(resident, c, next.worktreeInfoMap[id])
      changed = true
    }
    // Entries canonical HAD and no longer has (an explicit drop, or the retiring
    // half of a rekey). Sessions canonical never knew are left alone: a
    // not-yet-spawned session created by this client is store-only until
    // `createNewSession` seeds it, and dropping those would empty the sidebar.
    for (const id of Object.keys(prev.sessions)) {
      if (next.sessions[id] || !sessions[id]) continue
      delete sessions[id]
      changed = true
    }
    if (changed) patch.sessions = sessions
  }

  return patch
}

/**
 * Overlay one canonical session onto its resident store entry.
 *
 * Only the sealed fields are written (`sealed-fields.ts`); everything else on the
 * entry — draft text and attachments, panel/right-rail state, git panel state,
 * plan/mockup state, error and warning toasts, `isHistorical`, `evicted`,
 * `needsAttention` — is per-client view state the replica must not touch. That
 * split IS the store split ADR-051 asks for; it lives in one function instead of
 * two Zustand stores so the ~200 components that read `useActiveSession(...)` did
 * not all have to change.
 */
function projectSession(
  resident: PerSessionState | undefined,
  c: CanonicalSessionState,
  worktreeInfo: WorktreeInfo | undefined
): PerSessionState {
  const base = resident ?? { ...EMPTY_SESSION_STATE, cwd: c.cwd }
  return {
    ...base,
    cwd: c.cwd,
    messages: c.messages,
    streamingText: c.streamingText,
    streamingThinking: c.streamingThinking,
    status: c.status,
    pendingApprovals: c.pendingApprovals,
    todos: c.todos,
    sentFiles: c.sentFiles,
    queuedItems: c.queue,
    taskNotifications: c.taskNotifications,
    activeTasks: c.activeTasks,
    taskProgressMap: c.taskProgressMap,
    subagentMessages: c.subagentMessages,
    subagentStreamingText: c.subagentStreamingText,
    subagentStreamingThinking: c.subagentStreamingThinking,
    permissionMode: c.permissionMode as PermissionMode,
    effort: c.effort as PerSessionState['effort'],
    thinkingMode: c.thinkingMode as PerSessionState['thinkingMode'],
    reasoningVariant: c.reasoningVariant,
    statusLine: c.statusLine,
    metering: c.metering,
    sdkActive: c.sdkActive,
    selectedEngineId: c.selectedEngineId,
    selectedModel: c.selectedModel,
    // The per-session mirror of the app-level map, so `session:status`'s
    // worktree-exit rule (the reducer drops the entry when cwd returns to
    // `originalCwd`) clears the card without a second code path.
    worktreeInfo: worktreeInfo ?? null,
    // Presentation clock for ThinkingBlock's live ticker, derived from the sealed
    // buffer rather than measured by a handler: stamped when thinking output
    // starts, cleared the moment the reducer seals the span. The four writers this
    // replaces each had to re-implement that rule, and `setStatus`'s copy was the
    // "safety net" for the paths the other three missed.
    thinkingStartedAt:
      c.streamingThinking === '' ? null : (resident?.thinkingStartedAt ?? Date.now())
  }
}
