/**
 * The shared reducer — SyncCore phase 4a (ADR-051 §"Replication model").
 *
 * ONE pure interpretation of every replicated event, used by core (canonical
 * state) and, from 4c, by every client replica. Snapshot/event divergence
 * becomes unrepresentable once both sides fold the same function.
 *
 * ## Purity contract (invariant 5 — pinned by test)
 *
 * No I/O, no emission, no Electron, **no clock**, no randomness. That is not
 * decoration: a reducer that read `Date.now()` would produce a different
 * canonical state on every replay, so replay-equals-live — the property the
 * whole replication model rests on — would be false.
 *
 * Two as-built consequences, both real and both recorded rather than papered
 * over (see `docs/architecture/sync-channels.md` §"Reducer purity deltas"):
 *
 * 1. **Thinking-span durations are not computed here.** The renderer stamps
 *    `durationMs` on thinking blocks from wall-clock deltas. Core tracks only
 *    the boolean "is a thinking span open" ({@link CanonicalSessionState} has no
 *    timestamp), so the shadow comparator masks `durationMs`. Making durations
 *    replicable means the *emitter* must put the elapsed time in the event.
 * 2. **User-message identity is client-minted today.** `session:user-message`
 *    carries `{prompt, attachments}` only — the renderer mints
 *    `msg-${crypto.randomUUID()}` and `Date.now()` locally. Core therefore mints
 *    a deterministic `user-<seq>` id and a `0` timestamp, and the comparator
 *    masks both. 4b's cutover REQUIRES the id to move into the event payload.
 *
 * ## Cost fields (ratified §5)
 *
 * Engine cost fields are cumulative-per-process snapshots that reset on
 * `--resume`, so every apply is a REPLACE. Accumulating would double-count on
 * every status-line tick. Pinned by `reducer-cost.unit.test.ts`.
 */

import type {
  ChatMessage,
  ContentBlock,
  SessionStatus,
  PendingApproval,
  TodoItem,
  TaskNotification,
  TaskProgress,
  StatusLineData,
  QueuedItem,
  MeteringSnapshot,
  EngineId,
  ModelRef,
  WorktreeInfo,
  SlashCommandInfo
} from '../types'
import { mergeContentBlocks } from '../content-blocks'
import {
  buildTodosFromMessages,
  buildSentFilesFromMessages,
  TODO_TRIGGER_TOOLS,
  SEND_USER_FILE_TOOL
} from '../derive-session'
import { channelSpec } from './channels'
import { emptySession, type CanonicalSessionState, type CanonicalState } from './state'

/** One event as the ring holds it (the frame envelope, minus transport bits). */
export interface ReducerEvent {
  channel: string
  args: unknown[]
  /**
   * Ring sequence. Optional because a golden-fixture fold may omit it; supplied
   * in production. Used ONLY to mint deterministic identities for payloads that
   * carry none (see the class note on user-message identity) — never as a clock.
   */
  seq?: number
}

/**
 * Core-internal per-session bookkeeping that is NOT part of the wire snapshot.
 * Held in a side table keyed by routingId so {@link CanonicalSessionState} stays
 * structurally equal to `PerSessionSnapshot` minus `seq`.
 */
export interface ReducerAux {
  /** Is a thinking span currently open? The clock-free stand-in for `thinkingStartedAt`. */
  thinkingOpen: Record<string, boolean>
}

export function emptyAux(): ReducerAux {
  return { thinkingOpen: {} }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withSession(
  state: CanonicalState,
  routingId: string,
  updater: (s: CanonicalSessionState) => Partial<CanonicalSessionState>
): CanonicalState {
  const session = state.sessions[routingId]
  if (!session) return state
  return {
    ...state,
    sessions: { ...state.sessions, [routingId]: { ...session, ...updater(session) } }
  }
}

/**
 * Bootstrap a placeholder entry so an event for an unknown routingId is not
 * dropped — the renderer's `ensureSession` contract, kept verbatim (cross-client
 * events can outrun the `session:created` that names the session).
 */
function ensured(state: CanonicalState, routingId: string): CanonicalState {
  if (state.sessions[routingId]) return state
  return {
    ...state,
    sessions: { ...state.sessions, [routingId]: emptySession(routingId) }
  }
}

function arg<T>(event: ReducerEvent, index: number): T | undefined {
  return event.args[index] as T | undefined
}

/** `args[0]` is the routing id for every session-scoped channel (wire encoding). */
function routingIdOf(event: ReducerEvent): string | undefined {
  const first = event.args[0]
  return typeof first === 'string' ? first : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Build the ContentBlock[] for a user message: attachments first, then the text
 * block. Duplicated from the renderer store (which will adopt the reducer in 4c)
 * so both replicas render an attachment-carrying prompt identically.
 */
function buildUserContentBlocks(
  text: string,
  attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const att of attachments ?? []) {
    if (att.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        mediaType: 'application/pdf',
        base64Data: att.base64Data,
        fileName: att.fileName
      })
    } else {
      content.push({
        type: 'image',
        mediaType: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        base64Data: att.base64Data,
        fileName: att.fileName
      })
    }
  }
  if (text) content.push({ type: 'text', text })
  return content
}

/** Re-derive todos, honoring the null = "transcript says nothing" contract. */
function rederiveTodos(s: CanonicalSessionState): Partial<CanonicalSessionState> {
  const todos = buildTodosFromMessages(s.messages)
  return todos ? { todos } : {}
}

/** Re-derive sentFiles (never cleared — see derive-session's doc comment). */
function rederiveSentFiles(s: CanonicalSessionState): Partial<CanonicalSessionState> {
  const sentFiles = buildSentFilesFromMessages(s.messages)
  return sentFiles ? { sentFiles } : {}
}

/** Drop a fully-completed todo list, as every client does at a turn boundary. */
function dismissCompletedTodos(s: CanonicalSessionState): Partial<CanonicalSessionState> {
  if (s.todos.length === 0) return {}
  return s.todos.every((t) => t.status === 'completed') ? { todos: [] } : {}
}

/** Move a session entry (and every id-keyed app-level map) to a new routing id. */
export function rekeyCanonical(
  state: CanonicalState,
  oldId: string,
  newId: string
): CanonicalState {
  if (oldId === newId) return state
  const session = state.sessions[oldId]
  if (!session) return state
  const { [oldId]: _dropped, ...rest } = state.sessions
  const sessions = { ...rest, [newId]: { ...session, routingId: newId } }

  const customTitles = { ...state.customTitles }
  if (customTitles[oldId] !== undefined) {
    customTitles[newId] = customTitles[oldId]
    delete customTitles[oldId]
  }
  const worktreeInfoMap = { ...state.worktreeInfoMap }
  if (worktreeInfoMap[oldId] !== undefined) {
    worktreeInfoMap[newId] = worktreeInfoMap[oldId]
    delete worktreeInfoMap[oldId]
  }
  const sessionEngines = { ...state.sessionEngines }
  if (sessionEngines[oldId] !== undefined) {
    sessionEngines[newId] = sessionEngines[oldId]
    delete sessionEngines[oldId]
  }

  return {
    ...state,
    sessions,
    activeSessionId: state.activeSessionId === oldId ? newId : state.activeSessionId,
    recentSessionIds: state.recentSessionIds.map((id) => (id === oldId ? newId : id)),
    pinnedSessionIds: state.pinnedSessionIds.map((id) => (id === oldId ? newId : id)),
    hiddenSessions: state.hiddenSessions.map((id) => (id === oldId ? newId : id)),
    customTitles,
    worktreeInfoMap,
    sessionEngines
  }
}

/**
 * The rekey a `session:status` event implies: the engine reported a stable
 * sessionId that differs from the routing id the session was created under.
 * Exported because core must apply the SAME rule to its own registry in the same
 * tick (item 7 — rekey ownership moved into core).
 */
export function rekeyTargetFor(
  state: CanonicalState,
  routingId: string,
  status: SessionStatus | undefined
): string | null {
  if (!status?.sessionId) return null
  if (status.sessionId === routingId) return null
  if (!state.sessions[routingId]) return null
  return status.sessionId
}

// ---------------------------------------------------------------------------
// applyEvent
// ---------------------------------------------------------------------------

/**
 * Fold one event into canonical state. Pure: same (state, event) ⇒ same result,
 * always. Unclassified channels and `host-local` / non-canonical channels are
 * no-ops — the CLASSIFICATION decides, not a per-call guess, which is what makes
 * "did this event change state?" answerable from the table alone.
 *
 * `aux` is mutated in place (core-internal bookkeeping outside the wire shape).
 * Callers that need reducer-only purity for a replay can pass a fresh {@link emptyAux}.
 */
export function applyEvent(
  state: CanonicalState,
  event: ReducerEvent,
  aux: ReducerAux = emptyAux()
): CanonicalState {
  const spec = channelSpec(event.channel)
  if (!spec || !spec.canonical) return state

  switch (event.channel) {
    // -----------------------------------------------------------------------
    // Session registry
    // -----------------------------------------------------------------------
    case 'session:created': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      const data = arg<{ cwd?: string; resumeSessionId?: string }>(event, 1)
      const existing = state.sessions[routingId]
      const base = existing ?? emptySession(routingId)
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...base,
            cwd: data?.cwd ?? base.cwd,
            sdkActive: true,
            // A resumed session's transcript arrives via seedSession (a query);
            // a fresh one has nothing to seed, so it is already complete.
            seeded: data?.resumeSessionId ? base.seeded : true
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Transcript
    // -----------------------------------------------------------------------
    case 'session:user-message': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      const data = arg<{
        prompt?: string
        attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
      }>(event, 1)
      if (!state.sessions[routingId]) return state
      const id = `user-${event.seq ?? state.sessions[routingId].messages.length}`
      return withSession(state, routingId, (s) => ({
        messages: [
          ...s.messages,
          {
            id,
            role: 'user' as const,
            content: buildUserContentBlocks(data?.prompt ?? '', data?.attachments),
            timestamp: 0
          }
        ]
      }))
    }

    case 'session:message': {
      const routingId = routingIdOf(event)
      const message = arg<ChatMessage>(event, 1)
      if (!routingId || !message) return state
      let next = ensured(state, routingId)
      const session = next.sessions[routingId]

      const idx = session.messages.findIndex((m) => m.id === message.id)
      // `content` is defensive: engine adapters and older cached clients have
      // shipped partial messages, and canonical state must degrade rather than
      // throw (SyncCore fences the apply, but a no-op beats a fenced throw).
      const content = message.content ?? []
      const hasNonThinking = content.some((b) => b.type === 'text' || b.type === 'tool_use')
      const sealsThinking = aux.thinkingOpen[routingId] === true && hasNonThinking

      const committed: ChatMessage =
        idx < 0
          ? { ...message, content }
          : {
              ...message,
              content: mergeContentBlocks(session.messages[idx].content ?? [], content)
            }
      const messages =
        idx < 0
          ? [...session.messages, committed]
          : session.messages.map((m, i) => (i === idx ? committed : m))

      if (sealsThinking) aux.thinkingOpen[routingId] = false

      next = withSession(next, routingId, () => ({
        messages,
        streamingText: '',
        ...(sealsThinking ? { streamingThinking: '' } : {})
      }))

      // Derived fields (ratified §2) — same triggers as the as-built renderer:
      // task-tool presence rebuilds todos, SendUserFile presence rebuilds files.
      const hasTaskTool = content.some(
        (b) => b.type === 'tool_use' && TODO_TRIGGER_TOOLS.has(b.toolName)
      )
      if (hasTaskTool) next = withSession(next, routingId, rederiveTodos)
      const hasSendUserFile = content.some(
        (b) => b.type === 'tool_use' && b.toolName === SEND_USER_FILE_TOOL
      )
      if (hasSendUserFile) next = withSession(next, routingId, rederiveSentFiles)
      return next
    }

    case 'session:messages-retracted': {
      const routingId = routingIdOf(event)
      const data = arg<{ messageIds?: string[] }>(event, 1)
      if (!routingId) return state
      const messageIds = data?.messageIds ?? []
      aux.thinkingOpen[routingId] = false
      return withSession(state, routingId, (s) => ({
        messages:
          messageIds.length > 0 ? s.messages.filter((m) => !messageIds.includes(m.id)) : s.messages,
        streamingText: '',
        streamingThinking: ''
      }))
    }

    case 'session:tool-result': {
      const routingId = routingIdOf(event)
      const data = arg<{
        toolUseId?: string
        result?: string
        isError?: boolean
        fileDiffs?: unknown
        images?: unknown
      }>(event, 1)
      if (!routingId || !data?.toolUseId) return state
      const session = state.sessions[routingId]
      if (!session) return state

      const toolUseId = data.toolUseId
      const messages = [...session.messages]
      let attached = false
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role !== 'assistant') continue
        if (!msg.content.some((b) => b.type === 'tool_use' && b.toolUseId === toolUseId)) continue
        // Idempotent — first result wins (a replayed catchup must not append twice).
        if (msg.content.some((b) => b.type === 'tool_result' && b.toolUseId === toolUseId)) break
        messages[i] = {
          ...msg,
          content: [
            ...msg.content,
            {
              type: 'tool_result',
              toolUseId,
              toolResult: data.result ?? '',
              isError: data.isError === true,
              ...(data.fileDiffs ? { fileDiffs: data.fileDiffs as never } : {}),
              ...(data.images ? { images: data.images as never } : {})
            }
          ]
        }
        attached = true
        break
      }

      let next = attached
        ? withSession(state, routingId, () => ({
            messages,
            // A tool_result resolves its approval — the belt-and-suspenders rule
            // every client applies (ADR-038: still event-driven, since THIS is
            // the event; nothing is inferred from turn state).
            pendingApprovals: session.pendingApprovals.filter((a) => a.toolUseId !== toolUseId)
          }))
        : withSession(state, routingId, () => ({
            pendingApprovals: session.pendingApprovals.filter((a) => a.toolUseId !== toolUseId)
          }))

      if (data.isError !== true) next = withSession(next, routingId, rederiveTodos)
      // Unlike todos this runs for error results too — the error text IS the
      // payload — but only once the widget already knows the toolUseId.
      if (next.sessions[routingId].sentFiles.some((f) => f.toolUseId === toolUseId)) {
        next = withSession(next, routingId, rederiveSentFiles)
      }
      return next
    }

    // -----------------------------------------------------------------------
    // Streaming accumulation (volatile lane until phase 5)
    // -----------------------------------------------------------------------
    case 'session:stream': {
      const routingId = routingIdOf(event)
      const data = arg<{ type?: string; text?: string }>(event, 1)
      if (!routingId || typeof data?.text !== 'string') return state
      const next = ensured(state, routingId)
      if (data.type === 'thinking') {
        aux.thinkingOpen[routingId] = true
        return withSession(next, routingId, (s) => ({
          streamingThinking: s.streamingThinking + data.text
        }))
      }
      const sealing = aux.thinkingOpen[routingId] === true
      if (sealing) aux.thinkingOpen[routingId] = false
      return withSession(next, routingId, (s) => ({
        streamingText: s.streamingText + data.text,
        ...(sealing ? { streamingThinking: '' } : {})
      }))
    }

    case 'session:subagent-stream': {
      const routingId = routingIdOf(event)
      const data = arg<{ type?: string; toolUseId?: string; text?: string }>(event, 1)
      if (!routingId || !data?.toolUseId || typeof data.text !== 'string') return state
      const toolUseId = data.toolUseId
      const next = ensured(state, routingId)
      if (data.type === 'thinking') {
        return withSession(next, routingId, (s) => ({
          subagentStreamingThinking: {
            ...s.subagentStreamingThinking,
            [toolUseId]: (s.subagentStreamingThinking[toolUseId] || '') + data.text
          }
        }))
      }
      return withSession(next, routingId, (s) => ({
        subagentStreamingText: {
          ...s.subagentStreamingText,
          [toolUseId]: (s.subagentStreamingText[toolUseId] || '') + data.text
        },
        subagentStreamingThinking: { ...s.subagentStreamingThinking, [toolUseId]: '' }
      }))
    }

    // -----------------------------------------------------------------------
    // Subagent transcripts
    // -----------------------------------------------------------------------
    case 'session:subagent-message': {
      const routingId = routingIdOf(event)
      const data = arg<{ toolUseId?: string; message?: ChatMessage }>(event, 1)
      if (!routingId || !data?.toolUseId || !data.message) return state
      return upsertSubagentMessages(ensured(state, routingId), routingId, data.toolUseId, [
        data.message
      ])
    }

    case 'session:subagent-message-batch': {
      const routingId = routingIdOf(event)
      const data = arg<{ toolUseId?: string; messages?: ChatMessage[] }>(event, 1)
      if (!routingId || !data?.toolUseId || !Array.isArray(data.messages)) return state
      return upsertSubagentMessages(
        ensured(state, routingId),
        routingId,
        data.toolUseId,
        data.messages
      )
    }

    case 'session:subagent-tool-result': {
      const routingId = routingIdOf(event)
      const data = arg<{
        toolUseId?: string
        toolResultToolUseId?: string
        result?: string
        isError?: boolean
        fileDiffs?: unknown
        images?: unknown
      }>(event, 1)
      if (!routingId || !data?.toolUseId || !data.toolResultToolUseId) return state
      const session = state.sessions[routingId]
      if (!session) return state
      const target = data.toolResultToolUseId
      const msgs = [...(session.subagentMessages[data.toolUseId] || [])]
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.role !== 'assistant') continue
        if (!msg.content.some((b) => b.type === 'tool_use' && b.toolUseId === target)) continue
        msgs[i] = {
          ...msg,
          content: [
            ...msg.content,
            {
              type: 'tool_result',
              toolUseId: target,
              toolResult: data.result ?? '',
              isError: data.isError === true,
              ...(data.fileDiffs ? { fileDiffs: data.fileDiffs as never } : {}),
              ...(data.images ? { images: data.images as never } : {})
            }
          ]
        }
        break
      }
      const toolUseId = data.toolUseId
      return withSession(state, routingId, (s) => ({
        subagentMessages: { ...s.subagentMessages, [toolUseId]: msgs }
      }))
    }

    // -----------------------------------------------------------------------
    // Approvals (ADR-038 — event-driven ONLY)
    // -----------------------------------------------------------------------
    case 'session:approval-request': {
      const routingId = routingIdOf(event)
      const approval = arg<PendingApproval>(event, 1)
      if (!routingId || !approval) return state
      return withSession(ensured(state, routingId), routingId, (s) => ({
        pendingApprovals: [...s.pendingApprovals, approval]
      }))
    }

    case 'session:approval-dismiss': {
      const routingId = routingIdOf(event)
      const data = arg<{ requestId?: string }>(event, 1)
      if (!routingId || !data?.requestId) return state
      const requestId = data.requestId
      return withSession(state, routingId, (s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== requestId)
      }))
    }

    // -----------------------------------------------------------------------
    // Status / lifecycle
    // -----------------------------------------------------------------------
    case 'session:status': {
      const routingId = routingIdOf(event)
      const status = arg<SessionStatus>(event, 1)
      if (!routingId || !status) return state

      // The status-driven rekey rule, applied FIRST so the rest of this handler
      // (and every later event) targets the post-rekey id.
      const target = rekeyTargetFor(state, routingId, status)
      let next = target ? rekeyCanonical(state, routingId, target) : state
      const id = target ?? routingId
      if (target && aux.thinkingOpen[routingId] !== undefined) {
        aux.thinkingOpen[target] = aux.thinkingOpen[routingId]
        delete aux.thinkingOpen[routingId]
      }
      if (!next.sessions[id]) return next

      if (status.state === 'disconnected') {
        // ADR-045: report idle, drop approvals, mark the engine gone. Queue
        // transitions are NOT inferred here (ADR-053) — the session's own
        // disconnect path recalls and broadcasts.
        aux.thinkingOpen[id] = false
        return withSession(next, id, () => ({
          status: { ...status, state: 'idle' as const },
          sdkActive: false,
          pendingApprovals: [],
          streamingThinking: ''
        }))
      }

      const sealing = status.state === 'idle' && aux.thinkingOpen[id] === true
      if (sealing) aux.thinkingOpen[id] = false
      next = withSession(next, id, (s) => ({
        status,
        ...(status.cwd && status.cwd !== s.cwd ? { cwd: status.cwd } : {}),
        ...(sealing ? { streamingThinking: '' } : {})
      }))

      if (status.state === 'idle') next = clearForegroundSubagentBuffers(next, id)

      // Worktree exit: cwd returned to the recorded original.
      const wt = next.worktreeInfoMap[id]
      if (wt && status.cwd && status.cwd === wt.originalCwd) {
        const { [id]: _dropped, ...rest } = next.worktreeInfoMap
        next = { ...next, worktreeInfoMap: rest }
      }
      return next
    }

    case 'session:result': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      return withSession(state, routingId, dismissCompletedTodos)
    }

    // -----------------------------------------------------------------------
    // Tasks
    // -----------------------------------------------------------------------
    case 'session:task-started': {
      const routingId = routingIdOf(event)
      const data = arg<{ toolUseId?: string; taskId?: string; taskType?: string }>(event, 1)
      if (!routingId || !data?.toolUseId) return state
      const toolUseId = data.toolUseId
      return withSession(ensured(state, routingId), routingId, (s) => ({
        activeTasks: {
          ...s.activeTasks,
          [toolUseId]: { taskId: data.taskId ?? '', taskType: data.taskType ?? '' }
        }
      }))
    }

    case 'session:task-progress': {
      const routingId = routingIdOf(event)
      const progress = arg<TaskProgress>(event, 1)
      if (!routingId || !progress?.toolUseId) return state
      return withSession(ensured(state, routingId), routingId, (s) => ({
        taskProgressMap: { ...s.taskProgressMap, [progress.toolUseId]: progress }
      }))
    }

    case 'session:task-notification': {
      const routingId = routingIdOf(event)
      const notification = arg<TaskNotification>(event, 1)
      if (!routingId || !notification) return state
      return withSession(ensured(state, routingId), routingId, (s) => {
        const activeTasks = notification.toolUseId
          ? Object.fromEntries(
              Object.entries(s.activeTasks).filter(([id]) => id !== notification.toolUseId)
            )
          : s.activeTasks
        return { taskNotifications: [...s.taskNotifications, notification], activeTasks }
      })
    }

    // -----------------------------------------------------------------------
    // Queue of record (ADR-053)
    // -----------------------------------------------------------------------
    case 'session:queue-changed': {
      const routingId = routingIdOf(event)
      const data = arg<{ items?: QueuedItem[] }>(event, 1)
      if (!routingId || !Array.isArray(data?.items)) return state
      const session = state.sessions[routingId]
      if (!session) return state
      const items = data.items
      const seen = new Set(session.messages.map((m) => m.id))
      const synthesized: ChatMessage[] = []
      for (const item of items) {
        if (item.state !== 'consumed') continue
        // Stable across replicas — the SAME id is derived from the item id
        // everywhere, so a resync can never append a steer twice.
        const id = `steer-${item.itemId}`
        if (seen.has(id)) continue
        seen.add(id)
        synthesized.push({
          id,
          role: 'user',
          content: buildUserContentBlocks(item.text, item.attachments),
          timestamp: 0
        })
      }
      return withSession(state, routingId, (s) => ({
        queue: items.filter((item) => item.state === 'queued'),
        messages: synthesized.length > 0 ? [...s.messages, ...synthesized] : s.messages
      }))
    }

    // -----------------------------------------------------------------------
    // Per-session config
    // -----------------------------------------------------------------------
    case 'session:permission-mode': {
      const routingId = routingIdOf(event)
      const mode = arg<string>(event, 1)
      if (!routingId || typeof mode !== 'string') return state
      return withSession(ensured(state, routingId), routingId, () => ({ permissionMode: mode }))
    }

    case 'session:config-changed': {
      const routingId = routingIdOf(event)
      const patch = arg<{
        model?: string
        effort?: string
        thinkingMode?: string
        reasoningVariant?: string | null
      }>(event, 1)
      if (!routingId || !isRecord(patch)) return state
      return withSession(ensured(state, routingId), routingId, () => ({
        // Partial, per-field REPLACE — an absent key leaves the field alone.
        ...(patch.model !== undefined ? { selectedModel: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.thinkingMode !== undefined ? { thinkingMode: patch.thinkingMode } : {}),
        ...(patch.reasoningVariant !== undefined
          ? { reasoningVariant: patch.reasoningVariant }
          : {})
      }))
    }

    case 'session:status-line': {
      const routingId = routingIdOf(event)
      const data = arg<StatusLineData>(event, 1)
      if (!routingId || data === undefined) return state
      // REPLACE (ratified §5): cost fields inside are cumulative-per-process
      // snapshots that reset on --resume. Adding would double-count every tick.
      return withSession(state, routingId, () => ({ statusLine: data }))
    }

    case 'session:metering': {
      const routingId = routingIdOf(event)
      const data = arg<MeteringSnapshot>(event, 1)
      if (!routingId || data === undefined) return state
      return withSession(state, routingId, () => ({ metering: data }))
    }

    case 'session:plan': {
      const routingId = routingIdOf(event)
      const todos = arg<TodoItem[]>(event, 1)
      if (!routingId || !Array.isArray(todos)) return state
      return withSession(ensured(state, routingId), routingId, () => ({ todos }))
    }

    // -----------------------------------------------------------------------
    // App-level catalogs
    // -----------------------------------------------------------------------
    case 'session:slash-commands': {
      const commands = arg<SlashCommandInfo[]>(event, 1)
      if (!Array.isArray(commands)) return state
      return { ...state, slashCommands: commands }
    }

    case 'session:skills': {
      const names = arg<string[]>(event, 1)
      if (!Array.isArray(names)) return state
      return { ...state, sdkSkillNames: names }
    }

    // -----------------------------------------------------------------------
    // Watched sessions (payload-heavy; phase-5 target: notify + refetch)
    // -----------------------------------------------------------------------
    case 'session:watch-update': {
      const payload = arg<{
        routingId?: string
        messages?: ChatMessage[]
        taskNotifications?: TaskNotification[]
        statusLine?: StatusLineData | null
      }>(event, 0)
      const routingId = payload?.routingId
      if (!routingId || !Array.isArray(payload?.messages)) return state
      let next = ensured(state, routingId)
      next = withSession(next, routingId, () => ({
        messages: payload.messages as ChatMessage[],
        taskNotifications: payload.taskNotifications ?? [],
        // A watched session's transcript IS the on-disk truth, so this update
        // completes any pending seed.
        seeded: true,
        ...(payload.statusLine ? { statusLine: payload.statusLine } : {})
      }))
      next = withSession(next, routingId, rederiveTodos)
      next = withSession(next, routingId, rederiveSentFiles)
      // Watched sessions get no `session:result`, so the completed-list dismissal
      // rides here (verbatim from useClaudeEvents.onWatchUpdate).
      return withSession(next, routingId, dismissCompletedTodos)
    }

    // -----------------------------------------------------------------------
    // Cross-instance config
    // -----------------------------------------------------------------------
    case 'config:settings-changed': {
      const settings = arg<Record<string, unknown>>(event, 0)
      if (!isRecord(settings)) return state
      return { ...state, settings }
    }

    case 'config:sessions-changed': {
      const config = arg<{
        recentSessions?: string[]
        pinnedSessions?: string[]
        customTitles?: Record<string, string>
        worktreeInfoMap?: Record<string, WorktreeInfo>
        hiddenSessions?: string[]
        hiddenProjects?: string[]
        sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
      }>(event, 0)
      if (!isRecord(config)) return state
      // Per-key presence semantics (H15): the on-disk payload strips
      // sessionEngines (it lives in the DB), so a missing key must mean "leave
      // the current value intact" — never "zero it".
      return {
        ...state,
        recentSessionIds:
          'recentSessions' in config ? (config.recentSessions ?? []) : state.recentSessionIds,
        pinnedSessionIds:
          'pinnedSessions' in config ? (config.pinnedSessions ?? []) : state.pinnedSessionIds,
        customTitles: 'customTitles' in config ? (config.customTitles ?? {}) : state.customTitles,
        worktreeInfoMap:
          'worktreeInfoMap' in config ? (config.worktreeInfoMap ?? {}) : state.worktreeInfoMap,
        hiddenSessions:
          'hiddenSessions' in config ? (config.hiddenSessions ?? []) : state.hiddenSessions,
        hiddenProjects:
          'hiddenProjects' in config ? (config.hiddenProjects ?? []) : state.hiddenProjects,
        sessionEngines:
          'sessionEngines' in config ? (config.sessionEngines ?? {}) : state.sessionEngines
      }
    }

    default:
      // Classified `canonical: true` but unhandled: a coding error the
      // classification-coverage test catches, not something to guess at here.
      return state
  }
}

// ---------------------------------------------------------------------------
// Local helpers that need CanonicalState
// ---------------------------------------------------------------------------

function upsertSubagentMessages(
  state: CanonicalState,
  routingId: string,
  toolUseId: string,
  incoming: ChatMessage[]
): CanonicalState {
  const session = state.sessions[routingId]
  if (!session) return state
  const current = [...(session.subagentMessages[toolUseId] || [])]
  for (const message of incoming) {
    const idx = current.findIndex((m) => m.id === message.id)
    if (idx < 0) current.push(message)
    else
      current[idx] = {
        ...message,
        content: mergeContentBlocks(current[idx].content, message.content)
      }
  }
  return withSession(state, routingId, (s) => ({
    subagentMessages: { ...s.subagentMessages, [toolUseId]: current },
    subagentStreamingText: { ...s.subagentStreamingText, [toolUseId]: '' },
    subagentStreamingThinking: { ...s.subagentStreamingThinking, [toolUseId]: '' }
  }))
}

/**
 * The parent going idle means every FOREGROUND subagent is done, so its
 * streaming buffer is stale. Background tasks (`run_in_background`) keep
 * streaming past the parent's turn and are left alone. Verbatim from the
 * renderer's `setStatus`.
 */
function clearForegroundSubagentBuffers(state: CanonicalState, routingId: string): CanonicalState {
  const s = state.sessions[routingId]
  if (!s) return state
  const ids = new Set([
    ...Object.keys(s.subagentStreamingThinking),
    ...Object.keys(s.subagentStreamingText)
  ])
  if (ids.size === 0) return state

  const background = new Set<string>()
  for (const msg of s.messages) {
    for (const block of msg.content) {
      if (
        block.type === 'tool_use' &&
        ids.has(block.toolUseId) &&
        block.toolInput?.run_in_background
      ) {
        background.add(block.toolUseId)
      }
    }
  }

  let thinking = s.subagentStreamingThinking
  let text = s.subagentStreamingText
  for (const id of ids) {
    if (background.has(id)) continue
    if (thinking[id]) {
      if (thinking === s.subagentStreamingThinking) thinking = { ...thinking }
      thinking[id] = ''
    }
    if (text[id]) {
      if (text === s.subagentStreamingText) text = { ...text }
      text[id] = ''
    }
  }
  if (thinking === s.subagentStreamingThinking && text === s.subagentStreamingText) return state
  return withSession(state, routingId, () => ({
    subagentStreamingThinking: thinking,
    subagentStreamingText: text
  }))
}

// ---------------------------------------------------------------------------
// Derived-field tripwire (ratified §2)
// ---------------------------------------------------------------------------

export interface DerivedDrift {
  routingId: string
  field: 'todos' | 'sentFiles'
  carried: unknown
  fresh: unknown
}

/**
 * Assert that snapshot-carried derived fields equal a fresh derivation from the
 * transcript in the same snapshot. Returns the drift rows (empty when clean).
 *
 * Called on snapshot ingest in dev; **logs loudly and never throws in prod** —
 * a derivation disagreement is a correctness bug worth shouting about, but
 * refusing to hydrate would turn it into an outage.
 *
 * A `null` derivation means "the transcript says nothing", which legitimately
 * coexists with a non-empty carried value (a resumed session whose todos came
 * from an explicit `session:plan`, or sentFiles from an evicted transcript), so
 * those rows are not drift.
 */
export function checkDerivedFields(state: CanonicalState): DerivedDrift[] {
  const drift: DerivedDrift[] = []
  for (const [routingId, s] of Object.entries(state.sessions)) {
    if (!s.seeded) continue
    const todos = buildTodosFromMessages(s.messages)
    // The turn-boundary dismissal (an all-completed list is dropped) is a
    // deliberate divergence from pure derivation, not drift — recognize it
    // instead of reporting every finished turn.
    const dismissed =
      s.todos.length === 0 && todos !== null && todos.every((t) => t.status === 'completed')
    if (todos && !dismissed && !sameJson(todos, s.todos)) {
      drift.push({ routingId, field: 'todos', carried: s.todos, fresh: todos })
    }
    const sentFiles = buildSentFilesFromMessages(s.messages)
    if (sentFiles && !sameJson(sentFiles, s.sentFiles)) {
      drift.push({ routingId, field: 'sentFiles', carried: s.sentFiles, fresh: sentFiles })
    }
  }
  return drift
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
