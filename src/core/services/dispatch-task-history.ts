/**
 * The X-Agent cards of a cold-loaded transcript (ADR-105 §5).
 *
 * A dispatch's task lifecycle (`task-started`, `task-notification`) is emitted by the
 * dispatcher and written into no transcript, so a parent reopened from disk would show its
 * `dispatch_agent` cards with nothing to say how they ended. The ledger knows: one row per
 * X-Agent, keyed by the launching tool call. `readSessionHistory` — the one door every
 * cold read goes through — puts them back with {@link withDispatchTasks}.
 *
 * The ledger does not hold what a run said; the report store (ADR-105 §3) does. A finished
 * row with a stored report comes back as the report itself (`handback: 'send'`, the same
 * fields the live notification carried), so a reloaded card shows what the X-Agent handed
 * back; one without says that it ended.
 */
import type { ActiveTask, ChatMessage, TaskNotification } from '../../shared/types'
import {
  dispatchLedger,
  type DispatchLedgerStore,
  type DispatchTargetRow
} from './dispatch-target-ledger'
import {
  dispatchReports,
  type DispatchReportRow,
  type DispatchReportStore
} from './dispatch-report-store'
import {
  HAND_BACK_FALLBACK_WARNING,
  isLaunchAck,
  handBackWithheldText
} from '../../shared/dispatch-agent-description'
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

/**
 * How one run ended, as its card's terminal notification says it: the stored outcome of the
 * run that call launched or continued (ADR-105 §3), in the live notification's fields.
 */
function outcomeFields(
  row: DispatchTargetRow,
  report: DispatchReportRow
): Pick<TaskNotification, 'status' | 'summary' | 'handback' | 'warning'> {
  switch (report.status) {
    case 'delivered':
      return { status: 'completed', summary: report.report ?? '', handback: 'send' }
    case 'fallback':
      return {
        status: 'completed',
        summary: report.report ?? '',
        handback: 'flagged',
        warning: HAND_BACK_FALLBACK_WARNING
      }
    case 'withheld':
      return {
        status: 'completed',
        summary: handBackWithheldText(row.name ?? row.id),
        handback: 'withheld'
      }
    case 'stopped':
      return { status: 'stopped', summary: 'The X-Agent was stopped.' }
    case 'timeout':
      return { status: 'failed', summary: 'The X-Agent ran out of time.' }
    case 'failed':
      return { status: 'failed', summary: 'The X-Agent failed.' }
  }
}

function toolIds(messages: ChatMessage[]): {
  uses: Set<string>
  results: Set<string>
  /** Calls whose result is the background launch acknowledgement, not an answer. */
  launched: Set<string>
} {
  const uses = new Set<string>()
  const results = new Set<string>()
  const launched = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.add(block.toolUseId)
      else if (block.type === 'tool_result') {
        results.add(block.toolUseId)
        if (isLaunchAck(block.toolResult)) launched.add(block.toolUseId)
      }
    }
  }
  return { uses, results, launched }
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
  ledger: Pick<DispatchLedgerStore, 'byParent'> = dispatchLedger,
  reports: Pick<DispatchReportStore, 'rowsOf'> = dispatchReports
): T & DispatchHistoryRead {
  try {
    const rows = ledger.byParent(sessionId)
    if (rows.length === 0) return result
    // One query for the parent's cards; a store that cannot be read costs the outcomes only.
    // Each run's outcome is keyed by the call that launched or continued it, so a card shows
    // its own run's end and not the target's latest.
    const outcomes = new Map<string, DispatchReportRow>()
    try {
      for (const r of reports.rowsOf(rows.map((row) => row.id)))
        if (r.toolUseId) outcomes.set(r.toolUseId, r)
    } catch (err) {
      logger.warn(
        'DispatchHistory',
        `could not read the X-Agent reports of ${sessionId}: ${String(err)}`
      )
    }
    const { uses, results, launched } = toolIds(result.messages)
    const existing = result.taskNotifications ?? []
    const notified = new Set(existing.map((n) => n.toolUseId))
    const notifications: TaskNotification[] = []
    const activeTasks: Record<string, ActiveTask> = {}
    const ledgerById = new Map(rows.map((row) => [row.id, row]))
    for (const row of rows) {
      const toolUseId = row.parentToolUseId
      if (!toolUseId || !uses.has(toolUseId)) continue
      const own = outcomes.get(toolUseId)
      if (row.state === 'running' && !own) {
        // The launch returned (its result is in the transcript) = a background run, whose
        // result is delivered into the parent (B-3b); a call still waiting is a blocking one.
        // Either way it wakes the parent.
        const background = results.has(toolUseId)
        const description = row.description ?? row.name
        activeTasks[toolUseId] = {
          taskId: row.id,
          taskType: 'dispatch',
          isBackgrounded: background,
          wakesParent: true,
          // This run's start: a continuation's clock counts from its own start, not the first launch.
          startedAt: row.lastActiveAt,
          ...(description ? { description } : {})
        }
        continue
      }
      if (notified.has(toolUseId)) continue
      notified.add(toolUseId)
      notifications.push({
        taskId: row.id,
        toolUseId,
        outputFile: '',
        runIndex: 1,
        // The call's result is the launch acknowledgement: a background run, whose input
        // need not say so (the default for a root agent).
        ...(launched.has(toolUseId) ? { isBackgrounded: true } : {}),
        ...(own ? outcomeFields(row, own) : { status: terminalOf(row), summary: summaryOf(row) })
      })
    }
    // A continuation's own card: the run it launched, with its own end.
    for (const [toolUseId, outcome] of outcomes) {
      const row = ledgerById.get(outcome.targetId)
      if (!row || notified.has(toolUseId) || !uses.has(toolUseId)) continue
      notified.add(toolUseId)
      notifications.push({
        taskId: row.id,
        toolUseId,
        outputFile: '',
        runIndex: outcome.run,
        ...(launched.has(toolUseId) ? { isBackgrounded: true } : {}),
        ...outcomeFields(row, outcome)
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
