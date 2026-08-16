/**
 * Drive the renderer store the way the app does — SyncCore phase 4c.
 *
 * Before 4c a test set up store state by calling the action a handler would have
 * called (`store().addMessage(rid, msg)`). Those actions are gone: the store's
 * replicated slices are the shared reducer's output, projected by
 * `renderer/src/stores/replica.ts`. This helper is the replacement, and it is
 * deliberately NOT a reimplementation of them — every function here builds the
 * real wire event and pushes it through the real {@link SyncClient}, so the fold
 * under test is `applyEvent` itself. A helper that mutated the store directly
 * would have re-created the second interpretation 4c deleted, in the one place
 * nobody would think to look for it.
 *
 * Two ways in, matching the two ways state legitimately arrives:
 *
 *  - {@link emitSync} + the named wrappers — the event path;
 *  - {@link seedSession} — the sanctioned local write for state no event carries
 *    (a session that has not spawned; a transcript read from disk).
 *
 * Self-seaming: `bootTestApp` installs its client here, and a test that never
 * boots the harness gets one on first use. So a plain store unit test can emit
 * events without any setup, and a harness test shares ONE seq counter with the
 * harness — two counters would manufacture gaps and trip resync detection.
 */

import { SyncClient } from '../../shared/sync/sync-client'
import {
  getSyncClient,
  setSyncClient,
  resetSyncClientForTests
} from '../../shared/sync/client-registry'
import {
  startReplica,
  patchLocalSession,
  patchLocalApp,
  getReplicaState,
  getReplicaAux,
  resetReplicaForTests
} from '../../renderer/src/stores/replica'
import { isVolatileStream } from '../../shared/sync/channels'
import { streamFrameFrom } from '../../shared/sync/stream'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import type { CanonicalSessionState } from '../../shared/sync/state'
import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  QueuedItem,
  TaskProgress,
  TaskNotification,
  TaskStartedData,
  StatusLineData,
  MeteringSnapshot,
  SlashCommandInfo,
  FileDiff,
  ToolResultImage
} from '../../shared/types'

let seq = 0

/** Install the harness's client (called by `bootTestApp`) and reset the cursor. */
export function installSyncSeam(client: SyncClient): void {
  setSyncClient(client)
  client.markReady()
  seq = 0
}

/** Drop the seam's cursor. The client itself is reset by the registry helper. */
export function resetSyncSeam(): void {
  seq = 0
}

function client(): SyncClient {
  const existing = getSyncClient()
  if (existing) return existing
  // No harness: stand up the minimum a fold needs. `requestResync` is a no-op on
  // purpose — a gap here means the TEST emitted out of order, and answering it
  // would hide that.
  const fresh = new SyncClient({ requestResync: () => {} })
  installSyncSeam(fresh)
  startReplica()
  return fresh
}

/**
 * Full per-test reset: drop the installed client, the replica's canonical mirror
 * and the cursor. Call it in `beforeEach` alongside the store reset — the replica
 * is a module singleton, so a test that resets only the store would leave the two
 * disagreeing and the next projection would resurrect the previous test's sessions.
 * (`bootTestApp` does this for harness tests.)
 */
export function resetReplicaSeam(): void {
  resetSyncClientForTests()
  resetReplicaForTests()
  seq = 0
}

/** The seq the next {@link emitSync} will carry. */
export function nextSeq(): number {
  return seq + 1
}

/**
 * Fast-forward the cursor to a snapshot's watermark. Called after a `sync-full`:
 * the client's own `lastSeq` jumps to the watermark, so an emitter still counting
 * from before it would produce seqs the client discards as already-applied.
 */
export function advanceSeqTo(value: number): void {
  if (value > seq) seq = value
}

/**
 * Deliver one emission, exactly as a transport would — routed by the channel's
 * CLASS, exactly as `SyncCore.process` routes it.
 *
 * A `volatile` channel (phase 5 S1) is NOT an event: it never reaches
 * `receiveEvent`, takes no seq, and arrives as a `{streamId, turnId, offset,
 * chunk}` frame instead. Building that frame from the REPLICA's own state is the
 * same computation core does against canonical — the offsets agree because a
 * test has only one state.
 */
export function emitSync(channel: string, args: unknown[]): void {
  const c = client()
  if (isVolatileStream(channel)) {
    const frame = streamFrameFrom(getReplicaState(), getReplicaAux(), channel, args)
    // No frame ⇒ a malformed delta, or a session the replica has never met —
    // the same honest no-op core applies.
    if (frame) c.receiveStreamFrame(frame)
    return
  }
  c.receiveEvent({ seq: ++seq, channel, args })
}

/**
 * Write a session's replicated fields directly — the sanctioned local write, for
 * state no event carries: a session created but not yet spawned, or a transcript
 * loaded from disk. Creates the entry when it does not exist.
 */
export function seedSession(
  routingId: string,
  patch: Partial<CanonicalSessionState> = {}
): void {
  client() // ensure the replica is folding before anything is projected
  patchLocalSession(routingId, patch, { create: true })
}

/**
 * Push the store's sealed per-session + app-level fields INTO the replica.
 *
 * Test-only, and deliberately not something production has an equivalent of: the
 * seal forbids writing a sealed field outside the replica, so this exists purely
 * so a fixture that stages state with `useSessionStore.setState(...)` — the shape
 * every pre-4c store test was written in — keeps working. Call it right after such
 * a `setState`; without it the next projection reverts the staged fields, because
 * canonical never heard about them.
 *
 * Prefer {@link seed} or {@link seedSession} in new tests. This is a bridge for
 * existing fixtures, not a pattern.
 */
export function mirrorStoreIntoReplica(): void {
  client()
  const state = useSessionStore.getState()
  patchLocalApp({
    recentSessionIds: state.recentSessionIds,
    pinnedSessionIds: state.pinnedSessionIds,
    customTitles: state.customTitles,
    worktreeInfoMap: state.worktreeInfoMap,
    sessionEngines: state.sessionEngines,
    hiddenSessions: state.hiddenSessionIds,
    hiddenProjects: state.hiddenProjectKeys,
    directories: state.directories,
    slashCommands: state.slashCommands,
    sdkSkillNames: state.sdkSkillNames
  })
  for (const [routingId, s] of Object.entries(state.sessions)) {
    patchLocalSession(
      routingId,
      {
        cwd: s.cwd,
        messages: s.messages,
        streamingText: s.streamingText,
        streamingThinking: s.streamingThinking,
        status: s.status,
        pendingApprovals: s.pendingApprovals,
        todos: s.todos,
        sentFiles: s.sentFiles,
        queue: s.queuedItems,
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
        metering: s.metering,
        sdkActive: s.sdkActive,
        selectedEngineId: s.selectedEngineId,
        selectedModel: s.selectedModel,
        seeded: true
      },
      { create: true }
    )
  }
}

// ---------------------------------------------------------------------------
// Named wrappers — one per replicated channel a test used to reach via a store
// action. Signatures mirror the deleted actions so a migration reads as a rename.
// ---------------------------------------------------------------------------

export const seed = {
  removed: (routingId: string) => emitSync('session:removed', [routingId]),

  conversationCleared: (routingId: string, permissionMode?: string) =>
    emitSync('session:conversation-cleared', [routingId, { permissionMode }]),

  directories: (directories: unknown[]) =>
    emitSync('session:directories-changed', [directories]),

  created: (routingId: string, data: { cwd?: string; resumeSessionId?: string } = {}) =>
    emitSync('session:created', [routingId, data]),

  userMessage: (
    routingId: string,
    data: {
      id?: string
      timestamp?: number
      prompt?: string
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    }
  ) => emitSync('session:user-message', [routingId, data]),

  message: (routingId: string, message: ChatMessage) =>
    emitSync('session:message', [routingId, message]),

  streamText: (routingId: string, text: string) =>
    emitSync('session:stream', [routingId, { type: 'text', text }]),

  streamThinking: (routingId: string, text: string) =>
    emitSync('session:stream', [routingId, { type: 'thinking', text }]),

  status: (routingId: string, status: SessionStatus) =>
    emitSync('session:status', [routingId, status]),

  result: (routingId: string, data: Record<string, unknown> = {}) =>
    emitSync('session:result', [routingId, data]),

  approvalRequest: (routingId: string, approval: PendingApproval) =>
    emitSync('session:approval-request', [routingId, approval]),

  approvalDismiss: (routingId: string, requestId: string) =>
    emitSync('session:approval-dismiss', [routingId, { requestId }]),

  toolResult: (
    routingId: string,
    toolUseId: string,
    result: string,
    isError = false,
    fileDiffs?: FileDiff[],
    images?: ToolResultImage[]
  ) =>
    emitSync('session:tool-result', [
      routingId,
      { toolUseId, result, isError, fileDiffs, images }
    ]),

  retract: (routingId: string, messageIds: string[]) =>
    emitSync('session:messages-retracted', [routingId, { messageIds }]),

  plan: (routingId: string, todos: TodoItem[]) => emitSync('session:plan', [routingId, todos]),

  queue: (routingId: string, items: QueuedItem[]) =>
    emitSync('session:queue-changed', [routingId, { items }]),

  statusLine: (routingId: string, data: StatusLineData) =>
    emitSync('session:status-line', [routingId, data]),

  metering: (routingId: string, data: MeteringSnapshot) =>
    emitSync('session:metering', [routingId, data]),

  permissionMode: (routingId: string, mode: string) =>
    emitSync('session:permission-mode', [routingId, mode]),

  configChanged: (
    routingId: string,
    patch: {
      model?: string
      effort?: string
      thinkingMode?: string
      reasoningVariant?: string | null
    }
  ) => emitSync('session:config-changed', [routingId, patch]),

  taskStarted: (routingId: string, data: TaskStartedData) =>
    emitSync('session:task-started', [routingId, data]),

  taskProgress: (routingId: string, progress: TaskProgress) =>
    emitSync('session:task-progress', [routingId, progress]),

  taskNotification: (routingId: string, notification: TaskNotification) =>
    emitSync('session:task-notification', [routingId, notification]),

  subagentMessage: (routingId: string, toolUseId: string, message: ChatMessage) =>
    emitSync('session:subagent-message', [routingId, { toolUseId, message }]),

  subagentMessageBatch: (routingId: string, toolUseId: string, messages: ChatMessage[]) =>
    emitSync('session:subagent-message-batch', [routingId, { toolUseId, messages }]),

  subagentStreamText: (routingId: string, toolUseId: string, text: string) =>
    emitSync('session:subagent-stream', [routingId, { type: 'text', toolUseId, text }]),

  subagentStreamThinking: (routingId: string, toolUseId: string, text: string) =>
    emitSync('session:subagent-stream', [routingId, { type: 'thinking', toolUseId, text }]),

  subagentToolResult: (
    routingId: string,
    toolUseId: string,
    toolResultToolUseId: string,
    result: string,
    isError = false
  ) =>
    emitSync('session:subagent-tool-result', [
      routingId,
      { toolUseId, toolResultToolUseId, result, isError }
    ]),

  watchUpdate: (payload: {
    routingId: string
    messages: ChatMessage[]
    taskNotifications?: TaskNotification[]
    statusLine?: StatusLineData | null
  }) => emitSync('session:watch-update', [payload]),

  slashCommands: (routingId: string, commands: SlashCommandInfo[]) =>
    emitSync('session:slash-commands', [routingId, commands]),

  skills: (routingId: string, names: string[]) => emitSync('session:skills', [routingId, names]),

  sessionsConfig: (config: Record<string, unknown>) =>
    emitSync('config:sessions-changed', [config]),

  settings: (settings: Record<string, unknown>) => emitSync('config:settings-changed', [settings]),

  /**
   * Rekey a session the way it actually happens: the engine reports a stable
   * session id on `session:status`, and the reducer moves the entry (plus every
   * id-keyed app-level map) in the same fold. There is no `rekeySession` action
   * and no `session:rekey` invoke on the client any more — core owns the move.
   */
  rekey: (oldId: string, newId: string) => {
    const current = getReplicaState().sessions[oldId]?.status
    emitSync('session:status', [
      oldId,
      { ...(current ?? {}), state: current?.state ?? 'running', sessionId: newId }
    ])
  }
}
