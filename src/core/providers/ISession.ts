import type {
  AttachmentRef,
  AttachmentUpload,
  ChatMessage,
  EngineId,
  ApprovalDecision,
  PermissionSuggestion,
  QueuedItem,
  SkillInfo,
  SessionConfig
} from '../../shared/types'
import type { ResolvedCapabilities } from '../../shared/model-capabilities'
import type { HostWindowHandle } from '../host'
import type { EmitSessionEvent } from '../shared/sync/events'
import type { BlockedCallLedger } from '../automode/blocked-calls'
import type { TurnOriginLedger } from './turn-origin-ledger'

/**
 * Where a non-user item comes from: another session's message, an agent's note, or the
 * result of an X-Agent the session launched (`dispatch-result`, ADR-105 §3: it wakes the
 * session, has its own wake cap and is not counted in the agent-turn budget).
 */
export type NonUserOrigin = 'session-message' | 'agent-note' | 'dispatch-result'

/**
 * One item another session or an agent puts into a session (slice 1a). Never
 * the user's words: every engine delivers it marked as such and the transcript
 * shows it as a note.
 */
export interface NonUserItem {
  origin: NonUserOrigin
  /** The body the model reads, unwrapped — each engine wraps it its own way. */
  text: string
  /** Who sent it: a stable key (a routing id) and a display name. */
  from: { key: string; title: string }
  /** Start a turn if the session is idle (a `session-message` always does). */
  wake: boolean
  /** The sender's permission class where known (recorded with a held item). */
  senderModeClass?: 'bypass' | 'prompting'
  /** An X-Agent result: the `dispatch_report` run it stands for, stamped delivered when it goes out. */
  reportRun?: number
}

/**
 * What an engine did with a {@link NonUserItem}. `started`: the session was idle
 * and a turn began. `queued`: it was busy and the item went into the running
 * turn's queue. `unavailable`: the engine could not take it now (no process,
 * a refused steer) — nothing was delivered, so the caller holds it.
 */
export type NonUserOutcome = 'started' | 'queued' | 'unavailable'

/** What a worktree tool answers: the text the model reads, an error when it was refused or failed. */
export interface WorktreeToolResult {
  text: string
  isError?: boolean
}

/**
 * Engine-neutral session interface. All methods here are implemented by
 * every backend (Claude, opencode, pi); optional members are gated behind
 * `capabilities` flags. Engine-specific features beyond this interface live
 * on the concrete session classes.
 */
export interface ISession {
  readonly engineId: EngineId
  readonly routingId: string
  readonly cwd: string
  readonly capabilities: ResolvedCapabilities

  /** Whether a prompt sent now will be queued (session actively processing a turn) */
  readonly willQueue: boolean

  /**
   * The in-flight seed of a RESUMED session's own totals (tokens, cost, context)
   * from its transcript, or `undefined` when there is nothing to wait for (a fresh
   * session, a fork, or a seed that has landed). Never rejects. A prompt delivered
   * before it starts the turn on zero accumulators, and a seed landing mid-turn
   * double-counts the new turn's lines, so `sendPrompt` waits on it; returning
   * `undefined` once settled keeps the send synchronous. Optional: only an engine
   * that seeds from a transcript at spawn has anything to wait for (Claude).
   */
  resumeSeedReady?(): Promise<void> | undefined

  /** Get the backend session UUID (available after first message exchange). */
  getSessionId(): string | null

  /** Get all messages exchanged in this session. */
  getMessages(): ChatMessage[]

  /** Run a prompt turn. Passing null spawns the process without sending a message. */
  run(
    prompt: string | null,
    attachments?: AttachmentUpload[],
    clientUserMessageId?: string
  ): Promise<void>

  /** Queue of record (ADR-053): items still awaiting consumption, oldest first. */
  readonly queuedItems: QueuedItem[]

  /**
   * {@link queuedItems} as user turns stamped with their queue time, for a
   * delegated judge's transcript (ADR-091 §4). Implemented in BaseSession;
   * optional so a minimal test double need not carry it.
   */
  queuedUserTurns?(): ChatMessage[]

  /**
   * This session's auto-mode blocks the user can approve after the fact, and
   * the one-shot grants approving them made (ADR-091 part 6) — shared with its
   * children and its pi/opencode dispatch targets. Implemented in BaseSession;
   * optional so a minimal test double need not carry it.
   */
  readonly blockedCalls?: BlockedCallLedger

  /**
   * The directory the engine runs this session in now, when it can differ from `cwd` (opencode:
   * the worktree it moved into). Optional: absent means `cwd`. Read at the moment of use.
   */
  readonly workingDirectory?: string

  /**
   * The hosted `claudeui_enter_worktree` / `claudeui_exit_worktree` tools (opencode, worktree
   * parity D7): move this session into a ClaudeUI worktree and back. Optional: only the opencode
   * session implements them.
   */
  enterWorktree?(input: { name?: string; path?: string }): Promise<WorktreeToolResult>
  exitWorktree?(): Promise<WorktreeToolResult>

  /**
   * Approve one auto-mode block after the fact (ADR-091 part 6): grant, route
   * the nudge, mark the review approved. `prompt` is the nudge the caller
   * sends this session's agent as a user prompt, or `null` when a live agent
   * below the root already took it. `undefined` → unknown, already approved or
   * still held: nothing happened.
   */
  approveBlocked?(toolUseId: string): { prompt: string | null } | undefined

  /**
   * Queue a prompt that arrived while the session was busy. Implemented once in
   * BaseSession for every engine; the only per-engine difference is WHEN the
   * item reaches the engine (claude pushes into cli.js's native queue
   * immediately, opencode posts to its inbox immediately, pi holds until the
   * next sub-turn boundary).
   *
   * `attachments` are the engine-bound uploads; `refs` are what the broadcast
   * item carries (ADR-087). `sendPrompt` interns once and passes both; a caller
   * that omits `refs` gets the uploads interned here.
   */
  enqueuePrompt(
    text: string,
    attachments?: AttachmentUpload[],
    refs?: AttachmentRef[],
    origin?: 'host-instruction' | 'agent-brief'
  ): void

  /**
   * Deliver an item from another session or an agent (slice 1a): the model must
   * read it as theirs, never the user's, ClaudeUI's judge and the engine's own
   * classifier must not take it for consent, and it renders as a note. One
   * adapter method per engine; the delivery rule (busy → queue, idle → wake or
   * hold, budget) is `session-delivery`'s, not the engine's. Optional so a
   * minimal test double need not carry it.
   */
  deliverNonUser?(item: NonUserItem): Promise<NonUserOutcome>

  /**
   * Stop holding peer messages from other Claude Code processes on this session
   * (Claude only; absent elsewhere).
   */
  allowPeerMessages?(): Promise<{ success: boolean; error?: string }>

  /**
   * Is the engine process (or its connection) up right now? `session-delivery`
   * holds a message for an idle session whose engine is gone instead of
   * respawning it: only the user's own prompt brings a closed session back.
   * Optional so a minimal test double need not carry it (absent = live).
   */
  isEngineLive?(): boolean

  /**
   * Taint and agent-turn budget (slice 1a) — read-only for the session tools
   * (slice 1c); written by `session-delivery` and the prompt path. Implemented in
   * BaseSession; optional so a minimal test double need not carry it.
   */
  readonly originLedger?: TurnOriginLedger

  /**
   * Take back every still-recallable queued item, oldest first. `recalled`
   * carries their texts in queue order (the client joins them with `\n`);
   * `notRecalled` counts items the engine had already started consuming —
   * those are left untouched and arrive as chat messages shortly after.
   */
  recallQueued(): Promise<{ recalled: string[]; notRecalled: number }>

  /** Interrupt the current turn without killing the session. */
  interrupt(): Promise<void>

  /** Cancel (tear down) the session entirely. */
  cancel(): void

  /** Resolve a pending tool-use approval. */
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void

  /**
   * Change the running session's config: the one live entry, for every `SessionConfig` field.
   * Applies the fields present in the patch in a fixed order; a field the engine takes no live
   * change of is ignored. `BaseSession` implements it over the engine's `liveConfig` table.
   */
  applyConfig(patch: SessionConfig): Promise<void>

  // ---------------------------------------------------------------------------
  // Optional capability-gated members. Implemented by engines that advertise the
  // named capability flag (or, where noted, are Claude-only with no flag —
  // absence of the method is the gate). Callers MUST check the flag and/or use
  // optional-call (`?.`) before invoking.
  // ---------------------------------------------------------------------------

  /** Background tasks (gated by capabilities.backgroundTasks). */
  watchBackground?(toolUseId: string): void
  unwatchBackground?(toolUseId: string): void
  readBackgroundRange?(toolUseId: string, offset: number, length: number): string
  /**
   * Stop one agent. `hostNote`: text the caller sends the session's model as a
   * `host-instruction` prompt once the stop took effect (opencode: its upstream
   * only says "Subagent cancelled"); the caller never forwards it to the UI.
   */
  stopTask?(toolUseId: string): Promise<{ success: boolean; error?: string; hostNote?: string }>
  backgroundTask?(toolUseId: string): Promise<{ success: boolean; error?: string }>

  /**
   * Voice input (gated by capabilities.voice): the transcription server only.
   * Captures are owned by the client holding the microphone and relayed by
   * `services/voice-relay.ts`, which starts the server through this.
   *
   * `startFields` ride on `voice_start` beside the language: the on-device server
   * (opencode, pi — ADR-101) needs its per-spawn `token` there; cli.js's
   * own server (Claude) takes none.
   */
  voiceStartServer?(): Promise<{ port: number; startFields?: Record<string, unknown> }>
  voiceStopServer?(): Promise<void>

  /** Current ExitPlanMode plan content (gated by capabilities.plan). */
  getPlanContent?(): string | null
  /** Path to this session's cli.js log. Claude-only; no capability flag. */
  getSessionLogPath?(): string | null

  /** Hosted-MCP runtime control (gated by capabilities.hostedMcp AND method
   *  presence — opencode advertises hostedMcp:true but does not host MCP). */
  mcpServerStatus?(): Promise<unknown[]>
  mcpToggleServer?(serverName: string, enabled: boolean): Promise<void>
  mcpReconnectServer?(serverName: string): Promise<void>
  mcpSetServers?(servers: Record<string, unknown>): Promise<unknown>
  /** Re-read the MCP config from disk (after a native `claude mcp add/remove`). */
  mcpReloadServers?(expect?: { name: string; present: boolean }): Promise<void>

  /** Hot-reload settings from disk. Claude-only; no capability flag. */
  notifySettingsChanged?(): Promise<void>
  /** Live token-usage snapshot. Claude-only; no capability flag. */
  getUsage?(): Promise<Record<string, unknown> | null>

  /** The skills this session offers for a cwd: the shared Claude skill catalog (with
   *  `claudeOnly` on non-Claude engines) plus the engine's own as `source: 'engine'`.
   *  Optional: `loadSkillDetails` falls back to the catalog alone. */
  discoverSkills?(cwd: string): Promise<SkillInfo[]>

  /** Update the inactivity timeout. Pass 0 to disable. */
  setInactivityTimeout(ms: number): void

  /**
   * Arm the idle timer again after something that held it ended: the dispatcher calls it
   * when an X-Agent of this session ends (ADR-105 §3). A no-op for a busy session or one
   * whose engine is down. Optional so a minimal test double need not carry it.
   */
  rearmIdleTimer?(): void

  /**
   * Re-broadcast an IPC event under this session's routing (same wire shape
   * as the session's own internal `send()`). Used by cross-engine dispatch
   * (ADR-033 M2) to forward a dispatched Claude target's approval requests
   * into the dispatching opencode session's chat, from OUTSIDE the session
   * class (the opencode-hosted `dispatch_agent` tool handler has no other
   * access to the protected `send()`).
   */
  emit: EmitSessionEvent

  /**
   * Accumulate spend from a cross-engine dispatched-agent turn (ADR-033
   * Slice C) into this session's own cost breakdown (TopBar tooltip), tagged
   * `dispatched: true`. Implemented by BaseSession — every engine gets it.
   * Used from OUTSIDE the session class by both dispatch directions'
   * caller-session lookups (collab-tool.ts / opencode-hosted-tools.ts via
   * main/index.ts), the same "reach into the dispatching session from the
   * dispatcher" pattern as `emit` above.
   */
  addDispatchedCost(engineId: EngineId, modelId: string, costUsd: number): void

  /**
   * Current permission-mode string (Claude-style — 'default'|'plan'|
   * 'acceptEdits'|'auto'|...). Optional: only engines whose sessions are a
   * cross-engine dispatch CALLER need it (ADR-033 M2 autonomy inheritance). Since
   * ADR-105 every caller engine implements it: a dispatch run reads its parent's
   * mode through the session manager at each decision, not through the closure the
   * launching call carried.
   */
  getAutonomyMode?(): string

  /**
   * Ask a one-off question outside the main conversation history (the `/btw`
   * command). Returns the assistant's answer, or null if the engine does not
   * support the capability or encounters an error.
   */
  askSideQuestion(question: string): Promise<string | null>

  /** Tear down all resources held by this session. */
  dispose(): void
}

/**
 * What an engine session is constructed with: the session's config (`SessionConfig`, the same
 * fields a live change patches through `ISession.applyConfig`) plus what only a spawn has. All
 * members are optional; engines ignore options they do not consume (noted per member).
 */
export interface EngineSpawnOptions extends SessionConfig {
  /** Engine session id to resume. Consumed by all three engines. */
  resumeSessionId?: string
  /** Fork ("branch off") anchor, in the engine's own convention: a JSONL line
   *  uuid for Claude (ADR-010), or a pi entryId / the clone-latest sentinel
   *  for pi — see PiSession.doStart's fork block. opencode fork is
   *  unwired (ADR-030). */
  resumeSessionAt?: string
  /** Fork at resumeSessionAt into a new session (ADR-010 Claude; pi via
   *  clone/fork RPCs). opencode fork is unwired (ADR-030). */
  forkSession?: boolean
}

/**
 * Factory type for engine-session construction, registered in EngineRegistry.
 * Args are the same as SessionManager.create() minus the trailing engineId.
 */
export type EngineSessionFactory = (
  routingId: string,
  /** Host window handle, or `null` when the app runs windowless (SyncCore 4d). */
  win: HostWindowHandle | null,
  cwd: string,
  opts: EngineSpawnOptions
) => ISession
