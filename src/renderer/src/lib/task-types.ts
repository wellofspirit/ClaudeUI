/**
 * Task types whose completion makes cli.js AUTO-CONTINUE the conversation.
 *
 * Upstream's own interactive busy predicate counts exactly these four and
 * deliberately excludes the rest: `local_bash` is a dev-server-shaped background
 * shell (an idle session with one running is the user's turn), and the monitor
 * types (`monitor_mcp` / `monitor_ws`) stay armed across many normal turns, so
 * counting either would silence every legitimate turn-end for the session's life.
 */
export const AUTO_CONTINUING_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow'
])

type TaskRecords = Record<string, { taskType: string }>

/**
 * Is delegated work still running, so this `result` is NOT the user's turn?
 *
 * cli.js emits a normal `result` when the main agent ends its turn even while a
 * background subagent runs on; when that task finishes it auto-continues with a
 * fresh `system/init` + turn of its own. Firing "Ready for input" at the first
 * `result` tells the user they are up while the session visibly keeps working.
 *
 * `activeTasks` (reducer, `session:task-started` in / `session:task-notification`
 * out) is exact at result-time in both orderings: a mid-turn completion is folded
 * into the current turn, so its notification always precedes that turn's single
 * `result`. No pending-injection tracking is needed.
 */
export function hasAutoContinuingTask(activeTasks: TaskRecords): boolean {
  return Object.values(activeTasks).some((t) => AUTO_CONTINUING_TASK_TYPES.has(t.taskType))
}

/**
 * How many subagents are still working. The sidebar dot keeps rippling on this
 * after the main turn ends at a background agent's launch ack; a background
 * shell or an armed monitor is not "working" for the same reason as above.
 */
export function countAutoContinuingTasks(activeTasks: TaskRecords): number {
  return Object.values(activeTasks).filter((t) => AUTO_CONTINUING_TASK_TYPES.has(t.taskType)).length
}
