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

import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  SentFile,
  QueuedItem,
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
import type { FullStateSnapshot, PerSessionSnapshot } from '../../../shared/remote-protocol'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'

export interface CanonicalSessionState {
  routingId: string
  cwd: string
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  /** Derived on message-apply (reducer-internal, ratified §2) — never client-computed. */
  todos: TodoItem[]
  /** Derived on message-apply; NEVER cleared on turn end (unlike todos). */
  sentFiles: SentFile[]
  /** Pending items only, mirroring the wire field (ADR-053). */
  queue: QueuedItem[]
  taskNotifications: TaskNotification[]
  activeTasks: Record<string, { taskId: string; taskType: string }>
  taskProgressMap: Record<string, TaskProgress>
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  permissionMode: string
  /** `null` when unset — matches what every producer actually puts on the wire. */
  effort: string | null
  thinkingMode: string | null
  reasoningVariant: string | null
  statusLine: StatusLineData | null
  /** 4a addition (sanctioned): without it every resync dropped metering. */
  metering: MeteringSnapshot | null
  slashCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
  sdkActive: boolean
  selectedEngineId: EngineId
  selectedModel: string
  /**
   * Core-internal, never serialized: has this session's transcript been seeded
   * from its on-disk history yet? The shadow comparator masks unseeded sessions,
   * because the renderer loads history through a query the reducer cannot see.
   */
  seeded: boolean
}

export interface CanonicalState {
  sessions: Record<string, CanonicalSessionState>
  directories: DirectoryGroup[]
  activeSessionId: string | null
  settings: Record<string, unknown>
  autoModeDisabledBySettings: boolean
  recentSessionIds: string[]
  pinnedSessionIds: string[]
  customTitles: Record<string, string>
  worktreeInfoMap: Record<string, WorktreeInfo>
  sessionEngines: Record<string, { engineId: EngineId; model?: ModelRef }>
  hiddenSessions: string[]
  hiddenProjects: string[]
  /**
   * App-level lists the wire snapshot replicates PER SESSION (every session
   * entry carries the same list). Held once here and fanned out by
   * {@link toSnapshot}, which is what the renderer's snapshot builder does too.
   */
  slashCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
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
    streamingText: '',
    streamingThinking: '',
    status: { ...DEFAULT_STATUS },
    pendingApprovals: [],
    todos: [],
    sentFiles: [],
    queue: [],
    taskNotifications: [],
    activeTasks: {},
    taskProgressMap: {},
    subagentMessages: {},
    subagentStreamingText: {},
    subagentStreamingThinking: {},
    permissionMode: 'default',
    effort: null,
    thinkingMode: null,
    reasoningVariant: null,
    statusLine: null,
    metering: null,
    slashCommands: [],
    sdkSkillNames: [],
    sdkActive: false,
    selectedEngineId: 'claude',
    selectedModel: 'default',
    seeded: false
  }
}

export function emptyCanonicalState(): CanonicalState {
  return {
    sessions: {},
    directories: [],
    activeSessionId: null,
    settings: {},
    autoModeDisabledBySettings: false,
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    sessionEngines: {},
    hiddenSessions: [],
    hiddenProjects: [],
    slashCommands: [],
    sdkSkillNames: []
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
 * Two deliberate asymmetries, both benign:
 *
 *  - **`seeded`** is core-internal and not on the wire. A snapshot-fed session is
 *    complete by definition (its transcript is whatever the producer had), so it
 *    restores as `true` — never as "still waiting for history", which would make
 *    a restored core skip the comparator and re-seed over live content.
 *  - **`slashCommands` / `sdkSkillNames`** are app-level here but the wire
 *    replicates them per session (every entry carries the same list, an as-built
 *    quirk `toSnapshot` preserves). They come back from the first entry, so a
 *    snapshot with NO sessions cannot carry them at all — an honest gap in the
 *    wire shape, recorded in docs/architecture/sync-channels.md.
 */
export function fromSnapshot(snapshot: FullStateSnapshot): CanonicalState {
  const sessions: Record<string, CanonicalSessionState> = {}
  for (const [id, s] of Object.entries(snapshot.sessions ?? {})) {
    sessions[id] = {
      routingId: id,
      cwd: s.cwd,
      messages: s.messages,
      streamingText: s.streamingText,
      streamingThinking: s.streamingThinking,
      status: s.status,
      pendingApprovals: s.pendingApprovals,
      todos: s.todos,
      sentFiles: s.sentFiles ?? [],
      queue: s.queue ?? [],
      taskNotifications: s.taskNotifications,
      activeTasks: s.activeTasks ?? {},
      taskProgressMap: s.taskProgressMap,
      subagentMessages: s.subagentMessages,
      subagentStreamingText: s.subagentStreamingText,
      subagentStreamingThinking: s.subagentStreamingThinking,
      permissionMode: s.permissionMode,
      effort: s.effort ?? null,
      thinkingMode: s.thinkingMode ?? null,
      reasoningVariant: s.reasoningVariant ?? null,
      statusLine: s.statusLine,
      metering: s.metering ?? null,
      // Empty, NOT `s.slashCommands` — canonical holds these once, app-level
      // (below); the per-session copies exist only because the wire shape fans
      // the one list into every entry, and no reducer branch ever writes them.
      // Restoring them per session would make a restored state disagree with the
      // live one it is supposed to equal.
      slashCommands: [],
      sdkSkillNames: [],
      sdkActive: s.sdkActive ?? false,
      selectedEngineId: s.selectedEngineId ?? 'claude',
      selectedModel: s.selectedModel ?? 'default',
      seeded: true
    }
  }
  const first = Object.values(snapshot.sessions ?? {})[0]
  return {
    sessions,
    directories: snapshot.directories ?? [],
    activeSessionId: snapshot.activeSessionId ?? null,
    settings: snapshot.settings ?? {},
    autoModeDisabledBySettings: snapshot.autoModeDisabledBySettings ?? false,
    recentSessionIds: snapshot.recentSessionIds ?? [],
    pinnedSessionIds: snapshot.pinnedSessionIds ?? [],
    customTitles: snapshot.customTitles ?? {},
    worktreeInfoMap: snapshot.worktreeInfoMap ?? {},
    sessionEngines: snapshot.sessionEngines ?? {},
    hiddenSessions: snapshot.hiddenSessions ?? [],
    hiddenProjects: snapshot.hiddenProjects ?? [],
    slashCommands: first?.slashCommands ?? [],
    sdkSkillNames: first?.sdkSkillNames ?? []
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
      routingId: id,
      cwd: s.cwd,
      messages: s.messages,
      streamingText: s.streamingText,
      streamingThinking: s.streamingThinking,
      status: s.status,
      pendingApprovals: s.pendingApprovals,
      todos: s.todos,
      sentFiles: s.sentFiles,
      queue: s.queue,
      taskNotifications: s.taskNotifications,
      activeTasks: s.activeTasks,
      taskProgressMap: s.taskProgressMap,
      subagentMessages: s.subagentMessages,
      subagentStreamingText: s.subagentStreamingText,
      subagentStreamingThinking: s.subagentStreamingThinking,
      permissionMode: s.permissionMode,
      effort: s.effort,
      thinkingMode: s.thinkingMode,
      reasoningVariant: s.reasoningVariant,
      statusLine: s.statusLine,
      metering: s.metering ?? undefined,
      slashCommands: state.slashCommands,
      sdkSkillNames: state.sdkSkillNames,
      sdkActive: s.sdkActive,
      selectedEngineId: s.selectedEngineId,
      selectedModel: s.selectedModel
    }
  }
  return {
    seq,
    sessions,
    directories: state.directories,
    activeSessionId: state.activeSessionId,
    settings: state.settings,
    autoModeDisabledBySettings: state.autoModeDisabledBySettings,
    recentSessionIds: state.recentSessionIds,
    pinnedSessionIds: state.pinnedSessionIds,
    customTitles: state.customTitles,
    worktreeInfoMap: state.worktreeInfoMap,
    sessionEngines: state.sessionEngines,
    hiddenSessions: state.hiddenSessions,
    hiddenProjects: state.hiddenProjects
  }
}
