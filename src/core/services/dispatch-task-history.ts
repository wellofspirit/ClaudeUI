/**
 * The X-Agent cards of a cold-loaded transcript (ADR-105 §5).
 *
 * A dispatch's task lifecycle (`task-started`, `task-notification`) is emitted by the
 * dispatcher and written into no transcript, so a parent reopened from disk would show its
 * `dispatch_agent` cards with nothing to say how they ended. The ledger knows: one row per
 * X-Agent, keyed by the launching tool call. `readSessionHistory` — the one door every
 * cold read goes through — puts them back with {@link withDispatchTasks}.
 *
 * What the ledger does NOT hold is the run's result text (B-3's report store will), so a
 * finished card says that it ended, not what it said.
 */
import type { ActiveTask, ChatMessage, TaskNotification } from '../../shared/types'
import {
  dispatchLedger,
  type DispatchLedgerStore,
  type DispatchTargetRow
} from './dispatch-target-ledger'
import { logger } from './logger'

/**
 * A finished row as the status the card understands. `interrupted` has no terminal status
 * of its own on the wire, and `stopped` would read as "never resumed" for an X-Agent that
 * can be: it is the neutral `unfinished` (ADR-073 §5), and the summary says what happened.
 */
function terminalOf(row: DispatchTargetRow): TaskNotification['status'] {
  switch (row.state) {
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'interrupted':
      return 'unfinished'
    default:
      return 'completed'
  }
}

function summaryOf(row: DispatchTargetRow): string {
  switch (row.state) {
    case 'failed':
      return 'The X-Agent failed.'
    case 'stopped':
      return 'The X-Agent was stopped.'
    case 'interrupted':
      return 'The X-Agent was interrupted before it finished (the app closed or its parent session cancelled). It can be resumed.'
    default:
      return 'The X-Agent finished. Its result text is not kept with this card.'
  }
}

function toolIds(messages: ChatMessage[]): { uses: Set<string>; results: Set<string> } {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.add(block.toolUseId)
      else if (block.type === 'tool_result') results.add(block.toolUseId)
    }
  }
  return { uses, results }
}

/** What a cold read returns that carries a transcript: every engine's history result has these. */
export interface DispatchHistoryRead {
  messages: ChatMessage[]
  taskNotifications?: TaskNotification[]
  activeTasks?: Record<string, ActiveTask>
}

/**
 * `result` with the parent's X-Agent cards back: a terminal task notification per finished
 * row, an `activeTasks` record per running one. Only a row whose launching tool call is in
 * the loaded transcript yields anything (a card needs its tool_use), and a notification the
 * engine's own reader already produced for that call is kept as is. One run per row.
 * Never throws: a history read must not fail because the ledger could not be read.
 */
export function withDispatchTasks<T extends DispatchHistoryRead>(
  sessionId: string,
  result: T,
  ledger: Pick<DispatchLedgerStore, 'byParent'> = dispatchLedger
): T & DispatchHistoryRead {
  try {
    const rows = ledger.byParent(sessionId)
    if (rows.length === 0) return result
    const { uses, results } = toolIds(result.messages)
    const existing = result.taskNotifications ?? []
    const notified = new Set(existing.map((n) => n.toolUseId))
    const notifications: TaskNotification[] = []
    const activeTasks: Record<string, ActiveTask> = {}
    for (const row of rows) {
      const toolUseId = row.parentToolUseId
      if (!toolUseId || !uses.has(toolUseId)) continue
      if (row.state === 'running') {
        // The launch returned (its result is in the transcript) = a background run, which
        // wakes nothing until B-3 delivers; a call still waiting is a blocking one.
        const background = results.has(toolUseId)
        const description = row.description ?? row.name
        activeTasks[toolUseId] = {
          taskId: row.id,
          taskType: 'dispatch',
          isBackgrounded: background,
          wakesParent: !background,
          // This run's start: a continuation's clock counts from its own start, not the first launch.
          startedAt: row.lastActiveAt,
          ...(description ? { description } : {})
        }
        continue
      }
      if (notified.has(toolUseId)) continue
      notifications.push({
        taskId: row.id,
        toolUseId,
        status: terminalOf(row),
        outputFile: '',
        summary: summaryOf(row),
        runIndex: 1
      })
    }
    const hasActive = Object.keys(activeTasks).length > 0
    if (notifications.length === 0 && !hasActive) return result
    return {
      ...result,
      taskNotifications: [...existing, ...notifications],
      ...(hasActive ? { activeTasks: { ...result.activeTasks, ...activeTasks } } : {})
    }
  } catch (err) {
    logger.warn('DispatchHistory', `could not add X-Agent cards to ${sessionId}: ${String(err)}`)
    return result
  }
}
