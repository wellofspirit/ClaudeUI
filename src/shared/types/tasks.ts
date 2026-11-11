import type { AttachmentRef, ChatMessage, FileDiff, ToolResultImage } from './content'
import type { StatusLineData } from './session'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

/**
 * A file the agent handed to the user via Claude Code's `SendUserFile` tool.
 *
 * Derived from the transcript (see `buildSentFilesFromMessages`), never stored
 * on its own — so it rebuilds for free on session resumption, exactly like
 * todos. Unlike todos it is never cleared when the turn ends.
 *
 * `path` is the raw path as it appeared in the tool input: cli.js accepts both
 * absolute and cwd-relative paths, so the renderer resolves it against the
 * session cwd before handing it to the shell IPC. The display name (basename)
 * is derived in the UI, not stored.
 */
export interface SentFile {
  path: string
  caption?: string
  display?: 'render' | 'attach'
  toolUseId: string
  /** Present when the paired tool_result was an error (missing file, UNC, URL, …). */
  error?: string
}

/**
 * One prompt in a session's queue of record (ADR-053 / sync-core.md §Queue).
 *
 * Itemized, never a pre-joined blob: the `\n` join happens at take-back time in
 * the client, so each item can still be correlated one-for-one with the
 * engine's own queue entry. `consumed` and `recalled` are terminal — main
 * broadcasts them exactly once (long enough for clients to synthesize the chat
 * message) and then prunes them from the list.
 */
export interface QueuedItem {
  itemId: string
  text: string
  /** Set for a prompt the host queued on the user's behalf; the consumed row carries the marker. */
  origin?: 'host-instruction'
  /**
   * Refs, never bytes: this item is broadcast and folded into canonical state.
   * The engine-bound uploads stay private to the host's `SessionQueue`.
   */
  attachments?: AttachmentRef[]
  state: 'queued' | 'consumed' | 'recalled'
}

export interface TaskProgress {
  toolUseId: string
  toolName: string
  parentToolUseId: string | null
  elapsedTimeSeconds: number
  /**
   * Cumulative usage for the task so far, from `system/task_progress` (§4.7).
   * Claude-only, and only while the task is running — the terminal figure lives
   * on `TaskNotification.usage`. Absent for every engine that reports no
   * periodic progress.
   */
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  /** The tool the task ran most recently, from `system/task_progress`. */
  lastToolName?: string
}

/**
 * Emitted the moment cli.js spawns a Task/Agent (or background Bash) — mirrors
 * `session:task-notification`'s payload conventions but for the START edge.
 * Claude 2.1.219+ makes Agent/Task tasks background-by-default and the tool_use
 * input usually omits `run_in_background`, so the renderer can no longer infer
 * "is this task actually still running" from tool input alone (an immediate
 * "Async agent launched successfully" tool_result would otherwise read as
 * complete). This event is the authoritative "task exists and is running"
 * signal; task-notification is the authoritative terminal signal. A task with
 * no task-started record (opencode/pi child sessions, historical transcripts)
 * falls back to the pre-existing tool_result/background-flag heuristic.
 */
export interface TaskStartedData {
  /**
   * The agent's ORIGIN tool_use id — the call that first spawned it, which is
   * the id every other subagent channel is keyed by. On a resume this is NOT
   * the id the wire reported (see `runToolUseId`); ClaudeSession normalizes it
   * so a resumed agent re-arms the card that spawned it (ADR-073).
   *
   * opencode is the exception: each run is its own CALL with its own card and
   * roster row (a resume is a new `subagent {sessionID}` call), so its
   * `toolUseId` is the id of the call that ran THIS run and `taskId` (the child
   * session) is what ties the runs together.
   */
  toolUseId: string
  taskId: string
  taskType: string
  /**
   * The tool_use id cli.js actually reported for THIS run, when it differs from
   * the origin — i.e. the `SendMessage` call that resumed a finished agent.
   * Absent on a first run. Carried for diagnostics; nothing keys off it.
   */
  runToolUseId?: string
  /** 1-based run counter for this agent. `> 1` means it was resumed. */
  runIndex?: number
  /**
   * cli.js's `is_backgrounded` (Claude only): `false` for a task running in the
   * foreground — the only kind "Send to background" can move — and `true` once
   * it runs in the background, from the start or after a `background_tasks`
   * flip, which ClaudeSession reports by re-sending this event for the same
   * run. Absent when the engine or task type has no such notion — and for an
   * opencode foreground run, which cannot be moved (2.1.2's background route is
   * whole-session): it omits the flag so no card offers "Send to background".
   */
  isBackgrounded?: boolean
  /**
   * Epoch ms at which THIS run started, stamped by the emitter when it saw the
   * start (the reducer is clock-free). A resume stamps its own run's start. It
   * is what a running task's elapsed clock counts from: cli.js sends no
   * elapsed ticks for an agent (`tool_progress` is Bash/REPL-only in stock
   * use), so without it a running card had no clock at all.
   */
  startedAt?: number
  /**
   * Will this task's end wake the main agent with a turn of its own (so the
   * conversation is NOT waiting on the user while it runs)? Decided by the
   * EMITTER — {@link taskWakesParent} for Claude, `true` for a pi host-run
   * subagent — so the renderer never has to know cli.js's task types. Absent on
   * a record from before the field existed; readers fall back to a type set.
   */
  wakesParent?: boolean
  /**
   * A short label for the task, when the emitter has one the tool input may not carry
   * (a dispatched X-Agent's `description`, else its `name`; ADR-105). Cards still take
   * theirs from the tool input; this is for readers that only see the record.
   */
  description?: string
}

/**
 * One `activeTasks` entry: a task that has started and not yet ended (ADR-040),
 * keyed by its origin tool_use id. The fields of the {@link TaskStartedData}
 * that armed it.
 */
export type ActiveTask = Pick<
  TaskStartedData,
  | 'taskId'
  | 'taskType'
  | 'runIndex'
  | 'isBackgrounded'
  | 'startedAt'
  | 'wakesParent'
  | 'description'
>

/**
 * One Claude subagent transcript on disk, as `session:load-history` indexes it
 * (ADR-102 Arc 2), keyed by the agent's ORIGIN tool_use id — the same key the
 * subagent buckets use. Lets a client plan, order and request the per-agent
 * fetches (`session:load-subagent-history`, by `agentId`) without reading them.
 */
export interface SubagentIndexEntry {
  /** The id `session:load-subagent-history` takes. */
  agentId: string
  /** Origin tool_use id of the agent that spawned this one; null for a depth-1 agent. */
  parentToolUseId: string | null
  /** Size of `subagents/agent-<agentId>.jsonl` when the read ran; 0 when the file is missing. */
  bytes: number
  /**
   * Recency of that file (its mtime in ms; 0 when missing): larger is newer, so a
   * prefetcher sorts DESCENDING. Not a spawn position.
   */
  order: number
  /** From the agent's `.meta.json` sidecar, when it names them. */
  name?: string
  description?: string
  agentType?: string
}

/** The terminal states an engine reports for a task run. */
export type TaskTerminalStatus = 'completed' | 'failed' | 'stopped'

/**
 * How a Claude subagent's report reached its parent when it ended through the
 * `SubagentHandback` tool (auto mode): `send` — delivered as it was written;
 * `flagged` — delivered with an auto-mode security warning; `withheld` — the
 * subagent ended without delivering one.
 */
export type TaskHandback = 'send' | 'flagged' | 'withheld'

export interface TaskNotification {
  taskId: string
  toolUseId: string | null
  /**
   * `unfinished` is not a wire status: the history loader writes it for an
   * agent whose transcript shows its last run starting and never ending
   * (ADR-073 §5). A transcript cannot tell an agent that died with its process
   * from one still running in another process, so history claims neither —
   * the card reads neutral, and a live session replaces it with cli.js's own
   * `stopped` reap.
   */
  status: TaskTerminalStatus | 'unfinished'
  outputFile: string
  /**
   * The run's result text. Under a hand-back it is the REPORT itself
   * (`handback_report.text`), or the withheld text — never cli.js's pointer
   * sentence, which only says where the report went.
   */
  summary: string
  /** Set when the subagent reported through `SubagentHandback`; see {@link TaskHandback}. */
  handback?: TaskHandback
  /** The auto-mode security warning of a `flagged` report, shown above it. */
  warning?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  /**
   * Which run of the agent this terminal event ends (1-based). Kept on the
   * notification as well as on the active record because `activeTasks` drops
   * the task at terminal — this is what still knows "resumed ×2" afterwards.
   */
  runIndex?: number
  /**
   * The task ran in the background. Set by an emitter whose call input does not say so (a
   * dispatched X-Agent that is background by default, ADR-105 §2); a card reads it like the
   * input's `run_in_background`, so a failed or stopped one shows no launch acknowledgement
   * as its body.
   */
  isBackgrounded?: boolean
}

export interface SubagentMessageData {
  toolUseId: string
  message: ChatMessage
}

export interface SubagentMessageBatchData {
  toolUseId: string
  messages: ChatMessage[]
}

export interface SubagentToolResultData {
  toolUseId: string
  toolResultToolUseId: string
  result: string
  isError: boolean
  fileDiffs?: FileDiff[]
  /** Images the tool returned (see ToolResultImage). Omitted when there are none. */
  images?: ToolResultImage[]
}

export interface BackgroundOutput {
  toolUseId: string
  tail: string
  totalSize: number
  done: boolean
}

export interface BashOutputData {
  toolUseId: string
  output: string
  totalLines: number
  totalBytes: number
}

/**
 * A watched external session changed on disk — a NOTIFY since phase 5 S4.
 *
 * The payload used to carry a full re-read of the transcript, which put hundreds
 * of transcripts in a 5000-entry ring and replayed every one of them to a
 * reconnecting client. The content is a SEED now
 * (`SyncCore.seedWatchedSession`, applied BEFORE this event is emitted), so what
 * rides the wire is the ADDRESS of the thing that changed and nothing else.
 *
 * `messages` / `taskNotifications` / `statusLine` survive as OLD-shape fields:
 * committed golden fixtures and any ring a client catches up from across the
 * upgrade still carry them, and the reducer still folds them (see its branch).
 * Nothing emits them any more.
 */
export interface WatchUpdate {
  routingId: string
  /**
   * The watched session's working directory. Optional for OLD-shape events only
   * (a cached `/remote` bundle whose `watchSession` invoke sends three args) —
   * the reducer leaves the existing cwd alone when it is absent. See
   * `main/services/session-watcher.ts` for why it has to ride the event.
   */
  cwd?: string
  /**
   * Where the transcript lives, so a client's refetch does not have to guess it.
   * `routingId` is the sessionId today (the sidebar's eye passes
   * `SessionInfo.sessionId` as both), but `watchSession` takes them separately,
   * and `projectKey` is `cwdToProjectKey`'s lossy, irreversible output — a value
   * only the emitter has. Absent on old-shape events; a client that has neither
   * skips the refetch and heals on its next snapshot.
   */
  sessionId?: string
  projectKey?: string
  /** @deprecated OLD-shape only — see the interface comment. */
  messages?: ChatMessage[]
  /** @deprecated OLD-shape only — see the interface comment. */
  taskNotifications?: TaskNotification[]
  /** @deprecated OLD-shape only — see the interface comment. */
  statusLine?: StatusLineData | null
}
