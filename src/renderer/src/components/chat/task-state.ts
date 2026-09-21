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
import type { TaskNotification } from '../../../../shared/types'

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
}

export interface TaskLifecycleState {
  isRunning: boolean
  isError: boolean
  /** Historical transcripts show unfinished tasks as neutral, not as running. */
  isLoaded: boolean
}

/**
 * The ADR-040 predicate, unchanged in behaviour.
 *
 * The `isBackground ? !notification : !hasResult` fallback is deliberate and
 * load-bearing: opencode and pi child sessions, Codex agents, cross-engine
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
  resultIsError = false
}: TaskLifecycleInput): TaskLifecycleState {
  const isRunning = isHistorical
    ? false
    : hasActiveTask
      ? true
      : isBackground
        ? !notification
        : !hasResult

  return {
    isRunning,
    isError: notification ? notification.status === 'failed' : resultIsError,
    isLoaded: isHistorical && !hasResult && !notification
  }
}
