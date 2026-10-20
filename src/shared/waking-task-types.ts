/**
 * Which background task types will WAKE the main agent again when they finish.
 *
 * cli.js (2.1.293, live probe in `docs/protocol-cc/03-inbound-messages.md` §3.7)
 * turns the terminal `task_notification` of every one of these into a fresh
 * auto-continued turn of the main agent — including a background shell
 * (`local_bash`), which the 2.1.241-era rationale wrongly called "the user's
 * turn". While one runs, the main agent has not handed the conversation back:
 * its `result` is a pause, not a request for the user, so the sidebar dot shows
 * "subagents" instead of attention and no "Ready for input" fires.
 *
 * Counted on purpose, owner ruling 2026-10-19: a dev server or an armed monitor
 * keeps the session in this state for as long as it runs. Permission, question
 * and plan prompts are approvals and still turn the dot yellow.
 *
 * The EMITTER decides, once, at `task-started` time ({@link taskWakesParent}) and
 * stamps `wakesParent` on the record; the renderer reads the field and only falls
 * back to a type set for a record that has none (an older replay).
 */

/** cli.js `task_type` values whose completion wakes the main agent. */
export const WAKING_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'local_bash',
  'monitor_mcp',
  'monitor_ws',
  'mcp_task'
])

/**
 * Will a task of this cli.js type wake the main agent when it ends? `false` for
 * the housekeeping types (`dream`, `auto_mode_scan`, `local_memory_import`) and
 * for any type this build has never heard of.
 */
export function taskWakesParent(taskType: string): boolean {
  return WAKING_TASK_TYPES.has(taskType)
}
