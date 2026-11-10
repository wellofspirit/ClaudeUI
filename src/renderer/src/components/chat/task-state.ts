/**
 * The one place that answers "is this task running, and how did it end?".
 *
 * ADR-040 made task running-state a projection of explicit lifecycle events
 * (`task_started` arms, `task_notification` disarms) rather than an inference
 * from tool input or tool results. That rule was then copy-pasted into
 * `TaskCard` and `TaskEntry`, and the agent roster (ADR-073) would have been a
 * third copy — three places to keep in step every time the wire moves. It is
 * one function now; the views decide how to render the answer, not what it is.
 */
import type { ContentBlock, TaskNotification } from '../../../../shared/types'
import { backgroundBashTaskId } from '../../../../shared/claude-background-bash'

/**
 * The **last** notification for a tool_use id — never the first.
 *
 * A task can reach a terminal state more than once. `SendMessage` to a finished
 * agent restarts it, and cli.js re-emits the whole lifecycle per run
 * (ADR-073; `docs/protocol-cc/04-system-subtypes.md` §4.5), so a card that read
 * `taskNotifications.find(...)` kept showing run 1's status, summary and usage
 * for the rest of the session — including after a later run failed.
 *
 * Single-run tasks (background Bash, and every engine that emits no lifecycle
 * events at all) have exactly one notification, so this is `find` for them.
 */
export function latestNotification(
  notifications: readonly TaskNotification[],
  toolUseId: string
): TaskNotification | undefined {
  for (let i = notifications.length - 1; i >= 0; i--) {
    if (notifications[i].toolUseId === toolUseId) return notifications[i]
  }
  return undefined
}

export interface TaskLifecycleInput {
  /** A replayed transcript: nothing in it is running, whatever the events say. */
  isHistorical: boolean
  /**
   * This task has a live `task_started` record with no matching notification.
   * Authoritative when true — Claude 2.1.219+ async-launches Agent/Task calls,
   * omits `run_in_background` from the input, and returns an immediate
   * "Async agent launched successfully" tool_result, so neither the input flag
   * nor the result can be trusted to mean "finished".
   */
  hasActiveTask: boolean
  /** The tool input asked for background execution. */
  isBackground: boolean
  /** A `tool_result` block exists for this tool_use id. */
  hasResult: boolean
  /** The task's most recent terminal event, via {@link latestNotification}. */
  notification?: TaskNotification
  /** `tool_result.isError` — only consulted when there is no notification. */
  resultIsError?: boolean
  /**
   * The call has not started: see {@link isBehindUnfinishedCall}. Only a call that is
   * still all the card knows of the task counts — a lifecycle record, a terminal event
   * or a result means it has started (or been settled), whatever the heuristic says.
   */
  queued?: boolean
}

export interface TaskLifecycleState {
  isRunning: boolean
  /**
   * The call is waiting for an earlier call of its own assistant message to finish, so it
   * has not started: not running (no spinner, no clock), yet a Stop on it is meant and
   * lands when it does start. Never set together with `isRunning`.
   */
  isQueued: boolean
  isError: boolean
  /**
   * Ended by a stop — the user's, or the process dying under it — rather than
   * finishing. Its own look, not "completed": the agent did not get to answer.
   */
  isStopped: boolean
  /**
   * Neither running nor settled: a historical task with nothing to say how it
   * ended, or an agent whose transcript ends mid-run (`unfinished`, ADR-073 §5)
   * and which might equally have died or still be running elsewhere.
   */
  isLoaded: boolean
}

/**
 * The ADR-040 predicate, unchanged in behaviour.
 *
 * The `isBackground ? !notification : !hasResult` fallback is deliberate and
 * load-bearing: opencode and pi child sessions, cross-engine
 * dispatch cards and every historical transcript emit no `task_started` at all,
 * so they have no `hasActiveTask` record and must keep the pre-ADR-040
 * heuristic exactly. A lifecycle record only ever ADDS running-ness.
 */
export function deriveTaskState({
  isHistorical,
  hasActiveTask,
  isBackground,
  hasResult,
  notification,
  resultIsError = false,
  queued = false
}: TaskLifecycleInput): TaskLifecycleState {
  const isQueued = queued && !isHistorical && !hasActiveTask && !notification && !hasResult
  const isRunningOtherwise = isHistorical
    ? // A transcript knows no running task, except a record the caller kept for it: a
      // dispatched X-Agent, rebuilt from the ledger on a reopen (ADR-105 §5).
      hasActiveTask
    : // An armed lifecycle record outranks everything, INCLUDING an earlier
      // terminal event: that is exactly the state a resumed agent is in — run
      // 1 notified, then run 2 started (ADR-073).
      hasActiveTask
      ? true
      : // Otherwise a terminal event settles it whatever the tool result says.
        // ADR-040 calls task_notification authoritative; the foreground branch
        // used to ignore it and leave such a task "running" forever, because a
        // synchronous task that notified may never post a tool_result.
        notification
        ? false
        : // A background launch answers with a success result at once; an
          // ERROR result means it never launched (a judge block, a start
          // failure), so nothing will ever notify — it is settled, not running.
          isBackground
          ? !(hasResult && resultIsError)
          : !hasResult
  const isRunning = isRunningOtherwise && !isQueued

  const unfinished = notification?.status === 'unfinished'
  return {
    isRunning,
    isQueued,
    isError: notification ? notification.status === 'failed' : resultIsError,
    isStopped: !isRunning && notification?.status === 'stopped',
    isLoaded: !isRunning && ((isHistorical && !hasResult && !notification) || unfinished)
  }
}

/**
 * A cross-engine dispatch tool call (ADR-033), by the name each engine gives it. The bare
 * `dispatch_agent` is pi's (`pi.registerTool()` has no mcp__/claudeui_ prefix to sanitize),
 * safe to match unconditionally since only pi emits that exact bare name.
 */
export function isDispatchToolName(toolName: string): boolean {
  return (
    toolName === 'mcp__claude-ui-collab__dispatch_agent' ||
    toolName === 'claudeui_dispatch_agent' ||
    toolName === 'dispatch_agent'
  )
}

/**
 * Why a failed task failed, for a card whose body does not already say: the tool_result's
 * error text. It stays in the result body of a foreground task with no streamed output; it
 * is a line of its own beside the output of one that streamed some (the output hid the
 * reason), and for a BACKGROUND task, whose result body is hidden altogether (a refused
 * background launch is an error result carrying the reason, nothing else).
 */
export function taskFailureText(i: {
  isError: boolean
  /** `tool_result.isError`: a failure the notification alone (which has no reason) cannot explain. */
  resultIsError: boolean
  resultText: string
  /** The body shows the agent's streamed output (or is about to). */
  showsOutput: boolean
  isBackground: boolean
}): string {
  return i.isError && i.resultIsError && (i.showsOutput || i.isBackground) ? i.resultText : ''
}

/**
 * How a settled X-Agent ended, when the notification says it in words and no hand-back
 * report does: "The X-Agent ran out of time.", "Dispatched turn failed: …", a stop, a run
 * a reload found unfinished ("It can be resumed."), or a background result that came with
 * no report (ADR-105 §5). The card and the panel draw it as a muted line.
 *
 * Empty when the card already says it: a hand-back report, the failure line
 * ({@link taskFailureText}), or the tool_result body (which a foreground call shows).
 */
export function dispatchEndNote(i: {
  isDispatch: boolean
  notification: TaskNotification | undefined
  /** Neither running nor queued. */
  settled: boolean
  /** The notification carries a hand-back report the card draws (`hasHandbackReport`). */
  hasHandback: boolean
  isBackground: boolean
  /** The tool_result text. */
  resultText: string
  failureShown: boolean
}): string {
  const summary = i.notification?.summary.trim() ?? ''
  if (!i.isDispatch || !i.settled || i.hasHandback || i.failureShown || !summary) return ''
  return i.isBackground || !i.resultText ? summary : ''
}

/**
 * Whether a tool call has not started because an EARLIER call of its own assistant message
 * has no result yet (cli.js 2.1.293, the streaming tool executor):
 * `canExecuteTool` lets a call that is not concurrency-safe run only when nothing else of
 * the message is executing, and its scan stops at the first such call it cannot start, so
 * every call after it waits too. A first-party MCP tool carries no `readOnlyHint`
 * (`isConcurrencySafe` reads nothing else), so `dispatch_agent` is exclusive: the second of
 * two in one message — or one behind a blocking call, a foreground Agent, a question —
 * starts only when everything before it has returned (docs/protocol-cc/10-mcp-hosting.md).
 *
 * The wire marks no such state: the card sees a tool_use with no `task_started`, no result
 * and no notification, exactly as for a call that has started and not yet answered. The
 * order of the message's own blocks is the evidence. Claude Code only: pi runs a message's
 * tool calls in parallel by default, and the other engines announce a call when it starts.
 */
export function isBehindUnfinishedCall(
  content: readonly ContentBlock[],
  toolUseId: string
): boolean {
  const own = content.findIndex((b) => b.type === 'tool_use' && b.toolUseId === toolUseId)
  if (own < 0) return false
  const answered = new Set<string>()
  for (const block of content) if (block.type === 'tool_result') answered.add(block.toolUseId)
  return content.slice(0, own).some((b) => b.type === 'tool_use' && !answered.has(b.toolUseId))
}

/**
 * Whether a message holds a dispatch call that follows another tool call: the only shape
 * {@link isQueuedDispatchCall} can ever answer yes for. A bubble without one need not follow
 * the turn's state.
 */
export function hasDispatchBehindCall(content: readonly ContentBlock[]): boolean {
  let seenCall = false
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    if (seenCall && isDispatchToolName(block.toolName)) return true
    seenCall = true
  }
  return false
}

/**
 * Whether a dispatch call is queued, for every surface that shows one (the card, the task
 * panel, the agent roster): a `dispatch_agent` call of a Claude session, behind an unanswered
 * call of its own assistant message ({@link isBehindUnfinishedCall}), while the session's turn
 * is running. cli.js can hold a call queued only inside a live turn: in a session whose turn is
 * over (a crash cut it, a reopened session sent a prompt) the same block order is stale, and a
 * card reading "queued" for it would never settle.
 */
export function isQueuedDispatchCall(opts: {
  engineId: string
  /** The session's turn is running (`status.state === 'running'`). */
  turnRunning: boolean
  content: readonly ContentBlock[]
  block: { toolUseId: string; toolName: string }
}): boolean {
  return (
    opts.engineId === 'claude' &&
    opts.turnRunning &&
    isDispatchToolName(opts.block.toolName) &&
    !!opts.block.toolUseId &&
    isBehindUnfinishedCall(opts.content, opts.block.toolUseId)
  )
}

/**
 * Whether cli.js moved a foreground Bash to the background: "Send to
 * background", a timeout, or a message that arrived while it ran. From then on
 * it is a background command, and its tool_result only says where the output
 * goes.
 *
 * While the task runs, the record's flip says so (`isBackgrounded`). The
 * terminal event drops the record; from then on, the tool_result's wording
 * plus that event say so. A transcript has neither, because history maps no
 * shell's notification to its call, so a reopened session keeps showing the
 * tool_result rather than a command that would never end.
 */
export function bashMovedToBackground({
  isHistorical,
  activeTask,
  notification,
  resultText
}: {
  isHistorical: boolean
  activeTask?: { isBackgrounded?: boolean }
  notification?: TaskNotification | null
  resultText?: string
}): boolean {
  if (isHistorical) return false
  if (activeTask?.isBackgrounded === true) return true
  return (
    !!notification && resultText !== undefined && backgroundBashTaskId(resultText) !== undefined
  )
}
