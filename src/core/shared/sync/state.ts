/**
 * Canonical state shape — SyncCore phase 4a (ADR-051 §"Replication model").
 *
 * `CanonicalState` is `FullStateSnapshot` minus `seq`, with every internal field
 * non-optional. The wire type's optionality exists purely for older-server
 * compatibility (`sentFiles`, `queue`, `activeTasks`, `metering`, …); carrying
 * that optionality into core would mean every reducer branch re-deriving "absent
 * vs empty". {@link toSnapshot} puts the wire shape back.
 *
 * Electron-free and I/O-free by construction (lint-fenced): core, the desktop
 * renderer and the web client all read this module.
 */

import type { ItemStreams } from './item-stream'

import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  SentFile,
  QueuedItem,
  ActiveTask,
  TaskNotification,
  TaskProgress,
  StatusLineData,
  DirectoryGroup,
  SlashCommandInfo,
  WorktreeInfo,
  EngineId,
  ModelRef,
  MeteringSnapshot
} from '../../../shared/types'
import type {
  AuthRequiredState,
  FullStateSnapshot,
  PerSessionSnapshot
} from '../../../shared/remote-protocol'
import type { SessionLinkInfo } from '../../../shared/session-links'
import type { ContextPressureBanner } from '../../../shared/context-pressure'
import { DEFAULT_SANDBOX } from '../../../shared/types/engine-config'
import type { ClaudeSandboxState } from '../../../shared/types/engine-config'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'

export interface CanonicalSessionState {
  routingId: string
  cwd: string
  messages: ChatMessage[]
  itemStreams: ItemStreams
  itemStreamRevision: number
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  /** Derived on message-apply (reducer-internal, ratified §2) — never client-computed. */
  todos: TodoItem[]
  /** Derived on message-apply; NEVER cleared on turn end (unlike todos). */
  sentFiles: SentFile[]
  /** Pending items only, mirroring the wire field (ADR-053). */
  queue: QueuedItem[]
  /** Items from other sessions or agents held for this session's next turn (slice 1a). */
  heldCount: number
  /**
   * The context-pressure banner above this session's composer (slice 4), or null. Canonical
   * so that either answer clears it on every client and a late joiner sees it.
   */
  contextPressure: ContextPressureBanner | null
  taskNotifications: TaskNotification[]
  activeTasks: Record<string, ActiveTask>
  taskProgressMap: Record<string, TaskProgress>
  subagentMessages: Record<string, ChatMessage[]>
  permissionMode: string
  /** `null` when unset — matches what every producer actually puts on the wire. */
  effort: string | null
  thinkingMode: string | null
  reasoningVariant: string | null
  statusLine: StatusLineData | null
  /** 4a addition (sanctioned): without it every resync dropped metering. */
  metering: MeteringSnapshot | null
  /** This session's own slash menu (its engine's list plus the shared Claude skill catalog). */
  slashCommands: SlashCommandInfo[]
  sdkActive: boolean
  selectedEngineId: EngineId
  selectedModel: string
  /**
   * The credential this session needs was rejected and could not be renewed
   * (ADR-068 §4, widened to the three lifetimes of ADR-070 §2).
   *
   * ON the wire since slice 3 (`PerSessionSnapshot.authRequired`): the row that
   * renders it is engine-neutral, so a client that reconnects mid-outage has to
   * learn the owed sign-in from the snapshot as well as from the ringed event.
   *
   * The reducer is the only writer — `session:auth-required` sets it (with the
   * engine's own words and the prompt whose turn died),
   * `provider:auth-resolved` marks it resolved, and a running turn nulls it. Its
   * shape is {@link AuthRequiredState}, declared on the wire type so canonical,
   * the snapshot and the store cannot drift.
   */
  authRequired: AuthRequiredState | null
  /**
   * Does canonical hold this session's transcript? `false` while a resumed
   * session's history read is in flight and again once the host has dropped an
   * exited session's transcript (`SyncCore.evictTranscript`). Derived-field
   * checks skip an unseeded session, because its transcript is not here to
   * derive from.
   *
   * On the wire only as `seeded: false` ({@link toSnapshot}), for EVERY unseeded
   * session — one rule, "canonical does not hold this transcript". Whether a
   * client should read it from disk (the engine is gone) or fill it fold-style
   * (a resume's history read is in flight and live events are coming) is the
   * client's call, from `sdkActive`.
   */
  seeded: boolean
}

export interface CanonicalState {
  sessions: Record<string, CanonicalSessionState>
  directories: DirectoryGroup[]
  activeSessionId: string | null
  settings: Record<string, unknown>
  autoModeDisabledBySettings: boolean
  /** The command sandbox: the user-scope block of Claude Code's settings file (ADR-009). */
  claudeSandbox: ClaudeSandboxState
  recentSessionIds: string[]
  pinnedSessionIds: string[]
  customTitles: Record<string, string>
  worktreeInfoMap: Record<string, WorktreeInfo>
  sessionEngines: Record<string, { engineId: EngineId; model?: ModelRef }>
  hiddenSessions: string[]
  hiddenProjects: string[]
  /** Origin links between sessions, keyed by the started session's ref (slice 1b). */
  sessionLinks: Record<string, SessionLinkInfo>
  /** sidebar id → ref for every session a link names (slice 1b). */
  sessionRefs: Record<string, string>
}

/** Capabilities a session is assumed to have before its first status event. */
const DEFAULT_STATUS: SessionStatus = {
  state: 'idle',
  sessionId: null,
  model: null,
  cwd: null,
  totalCostUsd: 0,
  engineId: 'claude',
  capabilities: resolveClaudeCapabilities('default'),
  account: null
}

/** A fresh session entry. Mirrors the renderer's `EMPTY_SESSION_STATE` fields. */
export function emptySession(routingId: string, cwd = ''): CanonicalSessionState {
  return {
    routingId,
    cwd,
    messages: [],
    itemStreams: {},
    itemStreamRevision: 0,
    status: { ...DEFAULT_STATUS },
    pendingApprovals: [],
    todos: [],
    sentFiles: [],
    queue: [],
    heldCount: 0,
    contextPressure: null,
    taskNotifications: [],
    activeTasks: {},
    taskProgressMap: {},
    subagentMessages: {},
    permissionMode: 'default',
    effort: null,
    thinkingMode: null,
    reasoningVariant: null,
    statusLine: null,
    metering: null,
    slashCommands: [],
    sdkActive: false,
    selectedEngineId: 'claude',
    selectedModel: 'default',
    authRequired: null,
    seeded: false
  }
}

/**
 * Every per-session synced field, in wire key order. Derived from {@link emptySession}, so a
 * field added to `CanonicalSessionState` is listed here as soon as the compiler makes
 * `emptySession` carry it. {@link toSnapshot}, {@link fromSnapshot} and the replica projection
 * all copy by this list.
 */
export const SESSION_FIELDS = Object.keys(
  emptySession('')
) as readonly (keyof CanonicalSessionState)[]

/** The fields `toSnapshot` copies as they are: `seeded` has its own wire rule. */
const WIRE_COPIED_FIELDS = SESSION_FIELDS.filter((key) => key !== 'seeded') as readonly Exclude<
  keyof CanonicalSessionState,
  'seeded'
>[]

function pickFields<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[]
): Pick<T, K> {
  const picked: Partial<T> = {}
  for (const key of keys) picked[key] = source[key]
  return picked as Pick<T, K>
}

/**
 * A copy of an entry holding its synced fields and nothing else, in `SESSION_FIELDS` order.
 * An entry built with `{ ...base, ...seed }` can carry a key that is not a synced field; a
 * consumer that spreads this copy cannot pass one on.
 */
export function sessionFields(s: CanonicalSessionState): CanonicalSessionState {
  return pickFields(s, SESSION_FIELDS)
}

export function emptyCanonicalState(): CanonicalState {
  return {
    sessions: {},
    directories: [],
    activeSessionId: null,
    settings: {},
    autoModeDisabledBySettings: false,
    claudeSandbox: { settings: DEFAULT_SANDBOX, supported: true },
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    sessionEngines: {},
    hiddenSessions: [],
    hiddenProjects: [],
    sessionLinks: {},
    sessionRefs: {}
  }
}

/** What a wire session carries for each canonical field: its value, when there is one. */
type CarriedFields = {
  [K in keyof CanonicalSessionState]?: NonNullable<PerSessionSnapshot[K]>
}

/**
 * The synced fields a wire session carries a value for (not `undefined`, not `null`). Reading
 * `wire[key]` for every canonical key is what makes `PerSessionSnapshot` declare each of them.
 * Keys the wire carries beyond `SESSION_FIELDS` are dropped.
 */
function carriedFields(wire: PerSessionSnapshot): CarriedFields {
  const carried: Partial<Record<keyof CanonicalSessionState, unknown>> = {}
  for (const key of SESSION_FIELDS) {
    const value = wire[key]
    if (value !== undefined && value !== null) carried[key] = value
  }
  return carried as CarriedFields
}

/**
 * One wire session onto an empty entry: a field the wire does not carry keeps its empty
 * value, so an older host's missing field restores as its default. The assignment to
 * `CanonicalSessionState` is what checks every wire field type against its canonical one.
 */
function sessionFromWire(id: string, wire: PerSessionSnapshot): CanonicalSessionState {
  return {
    ...emptySession(id),
    ...carriedFields(wire),
    routingId: id,
    // Absent means an older host, whose snapshots are all complete.
    seeded: wire.seeded ?? true
  }
}

/**
 * Wire → canonical: rebuild a full state from a snapshot (SyncCore phase 4b).
 *
 * The inverse of {@link toSnapshot}, and lossless in the only sense that matters
 * — fold the events after the snapshot's `seq` onto the result and you get the
 * state the producing core holds at head. That equivalence IS the phase-4
 * snapshot invariant (`main/sync/__tests__/snapshot-invariant.unit.test.ts`), and
 * having the restore live here rather than inside the test is what makes the
 * invariant a property of the code instead of a property of a test helper.
 *
 * **`seeded`** round-trips: it rides the wire as `false` when the host does not hold
 * a transcript (see {@link toSnapshot}) and restores as `false`. Absent restores as
 * `true` — only an older host omits it, and its snapshots are all complete; a
 * snapshot-fed session is never "still waiting for history", which would make a
 * restored core skip the comparator and re-seed over live content.
 *
 */
export function fromSnapshot(snapshot: FullStateSnapshot): CanonicalState {
  const sessions: Record<string, CanonicalSessionState> = {}
  for (const [id, s] of Object.entries(snapshot.sessions ?? {})) {
    sessions[id] = sessionFromWire(id, s)
  }
  return {
    sessions,
    directories: snapshot.directories ?? [],
    activeSessionId: snapshot.activeSessionId ?? null,
    settings: snapshot.settings ?? {},
    autoModeDisabledBySettings: snapshot.autoModeDisabledBySettings ?? false,
    claudeSandbox: snapshot.claudeSandbox ?? { settings: DEFAULT_SANDBOX, supported: true },
    recentSessionIds: snapshot.recentSessionIds ?? [],
    pinnedSessionIds: snapshot.pinnedSessionIds ?? [],
    customTitles: snapshot.customTitles ?? {},
    worktreeInfoMap: snapshot.worktreeInfoMap ?? {},
    sessionEngines: snapshot.sessionEngines ?? {},
    hiddenSessions: snapshot.hiddenSessions ?? [],
    hiddenProjects: snapshot.hiddenProjects ?? [],
    sessionLinks: snapshot.sessionLinks ?? {},
    sessionRefs: snapshot.sessionRefs ?? {}
  }
}

/**
 * Canonical → wire. `seq` is stamped by the caller in the SAME synchronous tick
 * it captured the value in (SyncCore.getSnapshot) — the ordering that kills the
 * as-built watermark race (remote.md defect 3) by construction rather than by
 * under-claiming.
 */
export function toSnapshot(state: CanonicalState, seq: number): FullStateSnapshot {
  const sessions: Record<string, PerSessionSnapshot> = {}
  for (const [id, s] of Object.entries(state.sessions)) {
    sessions[id] = {
      // A keyed copy, not a spread: a stray key on a canonical entry must not reach the wire,
      // and the wire's key order is `SESSION_FIELDS`, whatever order the entry was built in.
      // Assigning it to `PerSessionSnapshot` is what checks every canonical field type.
      ...pickFields(s, WIRE_COPIED_FIELDS),
      routingId: id,
      // A hand-built entry may lack these two.
      itemStreams: s.itemStreams ?? {},
      itemStreamRevision: s.itemStreamRevision ?? 0,
      metering: s.metering ?? undefined,
      // One rule: canonical does not hold this transcript. That covers a dropped
      // one AND a resume whose history read is still in flight; omitting the
      // second would hand a client that syncs inside that window an empty
      // transcript marked complete, with no `session:created` coming to fix it.
      // The client tells the two apart by `sdkActive`.
      ...(!s.seeded ? { seeded: false } : {})
    }
  }
  return {
    seq,
    sessions,
    directories: state.directories,
    activeSessionId: state.activeSessionId,
    settings: state.settings,
    autoModeDisabledBySettings: state.autoModeDisabledBySettings,
    claudeSandbox: state.claudeSandbox,
    recentSessionIds: state.recentSessionIds,
    pinnedSessionIds: state.pinnedSessionIds,
    customTitles: state.customTitles,
    worktreeInfoMap: state.worktreeInfoMap,
    sessionEngines: state.sessionEngines,
    hiddenSessions: state.hiddenSessions,
    hiddenProjects: state.hiddenProjects,
    sessionLinks: state.sessionLinks,
    sessionRefs: state.sessionRefs
  }
}
