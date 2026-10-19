/**
 * The task types an `activeTasks` record from BEFORE `wakesParent` existed is
 * judged by (an older server's snapshot, a replayed ring).
 *
 * These are the four types upstream's own interactive busy predicate counts. They
 * are only a fallback: the emitter stamps `wakesParent` on every record it
 * writes now (`src/shared/waking-task-types.ts` holds the live set), and the
 * field wins whenever it is present.
 */
export const LEGACY_WAKING_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow'
])

type TaskRecords = Record<string, { taskType: string; wakesParent?: boolean }>

function wakes(task: { taskType: string; wakesParent?: boolean }): boolean {
  return task.wakesParent ?? LEGACY_WAKING_TASK_TYPES.has(task.taskType)
}

/**
 * Is background work still running that will wake the main agent again, so this
 * `result` is a pause and NOT the user's turn?
 *
 * cli.js emits a normal `result` when the main agent ends its turn even while a
 * background task runs on; when that task finishes it auto-continues with a
 * fresh `system/init` + turn of its own. That holds for a background shell and
 * a monitor as much as for a subagent (live probe on 2.1.293: a background
 * Bash's `task_notification` started a new turn by itself), so the 2.1.241-era
 * reasoning that left them out — "an idle session with a dev server is the
 * user's turn" — is gone: the owner ruled they count (2026-10-19), at the cost
 * of no turn-end yellow while a dev server or watcher stays up. Permission,
 * question and plan prompts are approvals and still raise attention.
 *
 * `activeTasks` (reducer, `session:task-started` in / `session:task-notification`
 * out) is exact at result-time in both orderings: a mid-turn completion is folded
 * into the current turn, so its notification always precedes that turn's single
 * `result`, and `task_started` always precedes the launching turn's `result`.
 * No pending-injection tracking is needed.
 */
export function hasWakingTask(activeTasks: TaskRecords): boolean {
  return Object.values(activeTasks).some(wakes)
}

/**
 * How many background tasks will wake the main agent. The sidebar dot keeps
 * rippling violet on this after the main turn ends at a background task's launch
 * ack.
 */
export function countWakingTasks(activeTasks: TaskRecords): number {
  return Object.values(activeTasks).filter(wakes).length
}
