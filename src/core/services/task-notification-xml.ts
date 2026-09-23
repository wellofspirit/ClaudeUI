/**
 * The one reader of cli.js's `<task-notification>` XML — the form a task's
 * terminal event takes when it is fed to the parent model, and so the form the
 * transcript keeps. Two consumers: the history loader (every notification a
 * reopened session shows) and ClaudeSession's legacy user-message path.
 *
 * Shape as of 2.1.280 (probed 2026-09-23):
 *
 *   <task-notification>
 *   <task-id>a63d5f10b49aadaff</task-id>
 *   <tool-use-id>toolu_01NY…</tool-use-id>        ← absent on the --resume reap
 *   <output-file>…</output-file>
 *   <status>completed</status>
 *   <summary>Agent "…" finished</summary>
 *   <result>ONE</result>
 *   <usage><subagent_tokens>22020</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1191</duration_ms></usage>
 *   </task-notification>
 *
 * Older binaries wrote `<usage>` as `total_tokens: N` lines; both parse.
 */
import type { TaskNotification, TaskTerminalStatus } from '../../shared/types'

export interface ParsedTaskNotification {
  taskId: string
  /** Absent when the XML carries none (or one this reader does not know). */
  status?: TaskTerminalStatus
  summary: string
  outputFile: string
  usage?: TaskNotification['usage']
  /** The `<tool-use-id>` of the run it ends — the reap of an orphan on --resume has none. */
  runToolUseId?: string
  /**
   * The whole `<task-notification>…</task-notification>` block. cli.js writes each
   * notification twice with identical text — the queue-operation `enqueue` when
   * it is queued, and the user message when the parent consumes it — so this is
   * what a reader dedups on.
   */
  raw: string
}

const STATUS: Record<string, TaskTerminalStatus> = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'stopped'
}

/** Parse the first `<task-notification>` in `text`; null when there is none or it names no task. */
export function parseTaskNotificationXml(text: string): ParsedTaskNotification | null {
  const block = text.match(/<task-notification>[\s\S]*?<\/task-notification>/)
  if (!block) return null
  const raw = block[0]
  const get = (tag: string): string => {
    const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }

  const taskId = get('task-id')
  if (!taskId) return null
  const status = STATUS[get('status')]
  const runToolUseId = get('tool-use-id')
  const usage = parseNotificationUsage(get('usage'))
  return {
    taskId,
    ...(status ? { status } : {}),
    summary: get('summary'),
    outputFile: get('output-file'),
    ...(usage ? { usage } : {}),
    ...(runToolUseId ? { runToolUseId } : {}),
    raw
  }
}

/**
 * A `<usage>` block, in either form. Undefined when no field parses — an empty
 * or unrecognized block must not become "0 tokens · 0 tools · 0ms".
 */
export function parseNotificationUsage(block: string): TaskNotification['usage'] | undefined {
  if (!block) return undefined
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const m =
        block.match(new RegExp(`<${key}>\\s*(\\d+)\\s*</${key}>`)) ??
        block.match(new RegExp(`${key}:\\s*(\\d+)`))
      if (m) return Number(m[1])
    }
    return undefined
  }
  const totalTokens = num('subagent_tokens', 'total_tokens')
  const toolUses = num('tool_uses')
  const durationMs = num('duration_ms')
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined
  }
  return { totalTokens: totalTokens ?? 0, toolUses: toolUses ?? 0, durationMs: durationMs ?? 0 }
}
