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
 * Both as-built consequences of that contract were closed by **phase 4b**, in
 * the only place they can be: the EMITTER now measures what needs a clock and
 * mints what needs randomness, and the reducer just files it (see
 * `docs/architecture/sync-channels.md` §"Reducer purity deltas"):
 *
 * 1. **Thinking-span durations arrive in the event.** `BaseSession.send` times
 *    the span and stamps `ChatMessage.thinkingDurationMs` on the message that
 *    seals it; {@link stampThinkingDuration} moves it onto the block. Core still
 *    tracks only the boolean "is a span open" ({@link CanonicalSessionState} has
 *    no timestamp). The shadow comparator keeps masking `durationMs` until 4c,
 *    because the desktop renderer still measures its own value in parallel and
 *    the two differ by scheduling jitter.
 * 2. **User-message identity arrives in the event.** `sendPrompt` mints
 *    `msg-<uuid>` + `Date.now()` into the `session:user-message` payload, so
 *    every replica agrees. The positional `user-<seq>` fallback below stays for
 *    old-shape events (committed fixtures, a client mid-upgrade), and the
 *    comparator keeps masking user identity until 4c retires the renderer's own
 *    local mint.
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

/**
 * The aux a snapshot-restored state must resume from (SyncCore phase 4b).
 *
 * `thinkingOpen` is not on the wire, but it does not need to be: it is exactly
 * "this session has un-sealed thinking output", and the snapshot field
 * `streamingThinking` holds that output. Every writer keeps the two in lockstep —
 * a thinking delta sets the flag AND appends, every seal clears the flag AND
 * blanks the buffer — so recovering the flag from the buffer is a derivation, not
 * a guess.
 *
 * Without this, a client (or a second core) that resumed from a snapshot taken
 * mid-thinking-span would not recognise the next text delta as a seal, and its
 * `streamingThinking` would never clear: stale thinking text under a finished
 * answer, until the next turn overwrote it.
 */
export function auxFromCanonical(state: CanonicalState): ReducerAux {
  const aux = emptyAux()
  for (const [routingId, session] of Object.entries(state.sessions)) {
    if (session.streamingThinking !== '') aux.thinkingOpen[routingId] = true
  }
  return aux
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
 * Bootstrap a placeholder entry for a routingId nothing has introduced yet.
 *
 * **Exactly ONE branch may use this: `session:watch-update`.** A watched session
 * is the only replicated state that has no birth event at all — the user clicks
 * the eye on a historical row in the sidebar and a file watcher starts emitting;
 * nothing spawns, so no `session:created` ever exists and the watch-update IS
 * the introduction (which is why it also had to start carrying `cwd`).
 *
 * Everywhere else it was a hazard, not a safety net. The original rationale —
 * "cross-client events can outrun the `session:created` that names the session"
 * — does not survive the funnel: `prepareAndCreateSession` emits `session:created`
 * synchronously at spawn, `SyncCore.emit` serializes emissions FIFO, and the ring
 * replays catchup in seq order, so no engine event can precede its session's birth
 * event on any transport. What DID reach these branches for unknown ids was:
 *
 *  - the pre-spawn `session:permission-mode` / `session:config-changed` echoes,
 *    which since the birth event carries the spawn config (0065eef) have nothing
 *    left to say about a session canonical has never heard of — a mode picked and
 *    never sent left a permanent `cwd: ''` row in every snapshot;
 *  - engine traffic arriving AFTER an explicit delete, which re-minted the entry
 *    the delete had just removed (the ghost F1 closes).
 *
 * Both are honest no-ops, which is what {@link withSession} does.
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

/**
 * Move an emitter-supplied thinking-span duration onto the block it belongs to
 * (SyncCore phase 4b — see {@link ChatMessage.thinkingDurationMs}).
 *
 * Scope is the COMMITTED content of the sealing message, which is the renderer's
 * rule verbatim (`addMessage` maps over `committed.content`): after the merge
 * that content includes the thinking block even when it arrived in an earlier
 * frame of the same message id. Only the first still-unstamped block is written,
 * so a re-delivered message (catchup overlap) is idempotent.
 */
function stampThinkingDuration(
  content: ContentBlock[],
  durationMs: number | undefined
): ContentBlock[] {
  if (typeof durationMs !== 'number') return content
  const idx = content.findIndex((b) => b.type === 'thinking' && b.durationMs == null)
  if (idx < 0) return content
  const next = [...content]
  next[idx] = { ...(next[idx] as { type: 'thinking'; text: string }), durationMs }
  return next
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
      const data = arg<{
        cwd?: string
        resumeSessionId?: string
        permissionMode?: string
        engineId?: EngineId
        model?: string
      }>(event, 1)
      const existing = state.sessions[routingId]
      const base = existing ?? emptySession(routingId)
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...base,
            cwd: data?.cwd ?? base.cwd,
            // The spawn config the emitter announced (create-session.ts). Every
            // field falls back to `base`, which is what makes an OLD-shape event
            // (committed golden fixtures, catchup from an older host) fold exactly
            // as it did before — and what makes the arriving event idempotent for
            // the originator, whose `createNewSession` already seeded the same
            // values into `base`.
            //
            // `effort` / `thinkingMode` are absent by design, not by omission: the
            // spawn args carrying them are RESOLVED model defaults, and these
            // fields mean "explicitly picked" (`null` = unset). See the emit site.
            permissionMode: data?.permissionMode ?? base.permissionMode,
            selectedEngineId: data?.engineId ?? base.selectedEngineId,
            selectedModel: data?.model ?? base.selectedModel,
            sdkActive: true,
            // A resumed session's transcript arrives via seedSession (a query);
            // a fresh one has nothing to seed, so it is already complete.
            seeded: data?.resumeSessionId ? base.seeded : true
          }
        }
      }
    }

    /**
     * Explicit removal — a session (or every session on a project) was deleted.
     *
     * Deletes the entry AND every id-keyed app-level row, which is the same set
     * {@link rekeyCanonical} renames. The app-level half runs even when the
     * session entry is absent: a COLD session (browsed from the sidebar, never
     * spawned) has no canonical entry but can absolutely have a custom title, a
     * pin and a recents slot, and leaving those behind is how a deleted session
     * comes back as a dangling sidebar row.
     *
     * The paired half of this is {@link withSession} everywhere else (F7): a
     * late engine event for a removed id must be an honest no-op, not a
     * re-mint of a `cwd: ''` placeholder.
     */
    case 'session:removed': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      delete aux.thinkingOpen[routingId]

      const hadSession = state.sessions[routingId] !== undefined
      const { [routingId]: _dropped, ...sessions } = state.sessions
      const customTitles = { ...state.customTitles }
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      const sessionEngines = { ...state.sessionEngines }
      const hadRow =
        customTitles[routingId] !== undefined ||
        worktreeInfoMap[routingId] !== undefined ||
        sessionEngines[routingId] !== undefined
      delete customTitles[routingId]
      delete worktreeInfoMap[routingId]
      delete sessionEngines[routingId]

      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== routingId)
      const hiddenSessions = state.hiddenSessions.filter((id) => id !== routingId)
      const listChanged =
        recentSessionIds.length !== state.recentSessionIds.length ||
        pinnedSessionIds.length !== state.pinnedSessionIds.length ||
        hiddenSessions.length !== state.hiddenSessions.length
      const wasActive = state.activeSessionId === routingId

      // Identity-stable when the id was unknown everywhere — the projection is
      // identity-diffed, so a no-op removal must not re-write every slice.
      if (!hadSession && !hadRow && !listChanged && !wasActive) return state

      return {
        ...state,
        sessions,
        customTitles,
        worktreeInfoMap,
        sessionEngines,
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessions,
        activeSessionId: wasActive ? null : state.activeSessionId
      }
    }

    /**
     * "Start fresh": reset a session to its birth state without removing it.
     *
     * Blanks exactly the set the store's `clearConversation` blanked locally —
     * expressed as `emptySession()` rather than a hand-written field list, so it
     * cannot drift from what a genuinely new session looks like — with three
     * deliberate carry-overs:
     *
     *  - `cwd`, because the session stays where it is;
     *  - `sdkActive`, because clearing the CONVERSATION is not a statement about
     *    the process. The only caller (ExitPlanModeCard's "start fresh") cancels
     *    and re-creates around this call, and those are the events that own that
     *    flag;
     *  - `seeded: true`, because an empty transcript is a COMPLETE one — without
     *    it the next reselect would try to re-hydrate the cleared session from
     *    disk and put the conversation back.
     *
     * `permissionMode` rides the event because a fresh RUN starts in the
     * configured default, and resolving that default needs `availableModels` +
     * the auto-mode gate — client state the reducer cannot see. The emitter
     * validates it; an absent/invalid one falls back to `'default'`, which is
     * `emptySession()`'s value.
     */
    case 'session:conversation-cleared': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      const data = arg<{ permissionMode?: string }>(event, 1)
      const session = state.sessions[routingId]
      if (!session) return state
      aux.thinkingOpen[routingId] = false
      const fresh = emptySession(routingId, session.cwd)
      return withSession(state, routingId, (s) => ({
        ...fresh,
        sdkActive: s.sdkActive,
        // Carried, not reset. These per-session copies are vestigial — canonical
        // holds ONE app-level list and `toSnapshot` fans it into every entry, so
        // in practice both are always `[]` here — but the catalogs describe the
        // ENGINE, not the conversation, and a bare remote clear (no cancel, no
        // respawn) must not look like the slash menu went away. Blanking them
        // would also be the one place this branch disagreed with the app-level
        // fields it cannot see.
        slashCommands: s.slashCommands,
        sdkSkillNames: s.sdkSkillNames,
        permissionMode: data?.permissionMode ?? fresh.permissionMode,
        seeded: true
      }))
    }

    // -----------------------------------------------------------------------
    // Transcript
    // -----------------------------------------------------------------------
    case 'session:user-message': {
      const routingId = routingIdOf(event)
      if (!routingId) return state
      const data = arg<{
        id?: string
        timestamp?: number
        prompt?: string
        attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
      }>(event, 1)
      if (!state.sessions[routingId]) return state
      // Identity comes from the EVENT as of phase 4b (`handlers-core.sendPrompt`
      // mints it), so every replica agrees on the id and a resync cannot renumber
      // the transcript. The positional fallback stays for old-shape events: the
      // committed golden fixtures replay them, and so does any client mid-upgrade.
      const id = data?.id ?? `user-${event.seq ?? state.sessions[routingId].messages.length}`
      const timestamp = typeof data?.timestamp === 'number' ? data.timestamp : 0
      return withSession(state, routingId, (s) => ({
        messages: [
          ...s.messages,
          {
            id,
            role: 'user' as const,
            content: buildUserContentBlocks(data?.prompt ?? '', data?.attachments),
            timestamp
          }
        ]
      }))
    }

    case 'session:message': {
      const routingId = routingIdOf(event)
      const message = arg<ChatMessage>(event, 1)
      if (!routingId || !message) return state
      // No `ensured()`: an assistant message for an id canonical does not know is
      // either post-delete engine traffic or a payload for a session that was
      // never born here. Both are no-ops (see {@link ensured}).
      const session = state.sessions[routingId]
      if (!session) return state
      let next = state

      const idx = session.messages.findIndex((m) => m.id === message.id)
      // `content` is defensive: engine adapters and older cached clients have
      // shipped partial messages, and canonical state must degrade rather than
      // throw (SyncCore fences the apply, but a no-op beats a fenced throw).
      const content = message.content ?? []
      const hasNonThinking = content.some((b) => b.type === 'text' || b.type === 'tool_use')
      const sealsThinking = aux.thinkingOpen[routingId] === true && hasNonThinking

      // The emitter's elapsed-time hint (phase 4b) is consumed here and never
      // stored: it moves onto the sealed thinking block and the field is dropped,
      // so a snapshot carries `durationMs` exactly where a client renders it.
      const { thinkingDurationMs, ...bare } = message
      const merged = idx < 0 ? content : mergeContentBlocks(session.messages[idx].content ?? [], content)
      const committed: ChatMessage = {
        ...bare,
        content: stampThinkingDuration(merged, thinkingDurationMs)
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
      // `withSession` (not `ensured`) — and the aux writes are gated on the
      // session existing too, or a stream delta for a removed id would leave an
      // orphan `thinkingOpen` flag behind that a same-id respawn would inherit.
      if (!state.sessions[routingId]) return state
      if (data.type === 'thinking') {
        aux.thinkingOpen[routingId] = true
        return withSession(state, routingId, (s) => ({
          streamingThinking: s.streamingThinking + data.text
        }))
      }
      const sealing = aux.thinkingOpen[routingId] === true
      if (sealing) aux.thinkingOpen[routingId] = false
      return withSession(state, routingId, (s) => ({
        streamingText: s.streamingText + data.text,
        ...(sealing ? { streamingThinking: '' } : {})
      }))
    }

    case 'session:subagent-stream': {
      const routingId = routingIdOf(event)
      const data = arg<{ type?: string; toolUseId?: string; text?: string }>(event, 1)
      if (!routingId || !data?.toolUseId || typeof data.text !== 'string') return state
      const toolUseId = data.toolUseId
      if (data.type === 'thinking') {
        return withSession(state, routingId, (s) => ({
          subagentStreamingThinking: {
            ...s.subagentStreamingThinking,
            [toolUseId]: (s.subagentStreamingThinking[toolUseId] || '') + data.text
          }
        }))
      }
      return withSession(state, routingId, (s) => ({
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
      // `upsertSubagentMessages` already no-ops on an unknown id.
      return upsertSubagentMessages(state, routingId, data.toolUseId, [data.message])
    }

    case 'session:subagent-message-batch': {
      const routingId = routingIdOf(event)
      const data = arg<{ toolUseId?: string; messages?: ChatMessage[] }>(event, 1)
      if (!routingId || !data?.toolUseId || !Array.isArray(data.messages)) return state
      return upsertSubagentMessages(state, routingId, data.toolUseId, data.messages)
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
      return withSession(state, routingId, (s) => ({
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
      return withSession(state, routingId, (s) => ({
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
      return withSession(state, routingId, (s) => ({
        taskProgressMap: { ...s.taskProgressMap, [progress.toolUseId]: progress }
      }))
    }

    case 'session:task-notification': {
      const routingId = routingIdOf(event)
      const notification = arg<TaskNotification>(event, 1)
      if (!routingId || !notification) return state
      return withSession(state, routingId, (s) => {
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
      return withSession(state, routingId, () => ({ permissionMode: mode }))
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
      return withSession(state, routingId, () => ({
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
      return withSession(state, routingId, () => ({ todos }))
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
        cwd?: string
      }>(event, 0)
      const routingId = payload?.routingId
      if (!routingId || !Array.isArray(payload?.messages)) return state
      // The ONE surviving `ensured()` — see its doc comment. A watched session
      // has no birth event, so this IS the introduction, which is exactly why the
      // payload had to start carrying `cwd`.
      let next = ensured(state, routingId)
      next = withSession(next, routingId, () => ({
        messages: payload.messages as ChatMessage[],
        taskNotifications: payload.taskNotifications ?? [],
        // A watched session's transcript IS the on-disk truth, so this update
        // completes any pending seed.
        seeded: true,
        ...(payload.statusLine ? { statusLine: payload.statusLine } : {}),
        // Old-shape events (no cwd) leave the existing value alone — never blank
        // a cwd some other event already established.
        ...(payload.cwd ? { cwd: payload.cwd } : {})
      }))
      next = withSession(next, routingId, rederiveTodos)
      next = withSession(next, routingId, rederiveSentFiles)
      // Watched sessions get no `session:result`, so the completed-list dismissal
      // rides here (verbatim from useClaudeEvents.onWatchUpdate).
      return withSession(next, routingId, dismissCompletedTodos)
    }

    /**
     * The merged sidebar listing (claude + opencode + pi), as a REPLACE.
     *
     * It carries its payload now instead of being a "refetch" notify each client
     * answered with its own three-query merge — the arrangement that made
     * canonical's claude-only list and the clients' merged lists two different
     * lists rather than two views of one.
     *
     * An ABSENT payload folds as the no-op notify it used to be. That matters for
     * replay, not just for old hosts: the committed golden fixtures and any ring
     * a client catches up from across the upgrade contain payload-less entries,
     * and blanking the sidebar on one of those would be a regression.
     */
    case 'session:directories-changed': {
      const directories = arg<unknown>(event, 0)
      if (!Array.isArray(directories)) return state
      return { ...state, directories: directories as CanonicalState['directories'] }
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
