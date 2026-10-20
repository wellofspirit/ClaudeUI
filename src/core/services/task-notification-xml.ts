/**
 * The one reader of cli.js's `<task-notification>` XML — the form a task's
 * terminal event takes when it is fed to the parent model, and so the form the
 * transcript keeps. Two consumers: the history loader (every notification a
 * reopened session shows) and ClaudeSession's user-message path. Both show the
 * delivery as an agent note (services/agent-note.ts), never a user bubble.
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
import type { TaskHandback, TaskNotification, TaskTerminalStatus } from '../../shared/types'
import {
  HANDBACK_FLAGGED_GENERIC_WARNING,
  HANDBACK_WITHHELD_TEXT
} from '../../shared/task-handback'
import type { ResultMessage, SystemMessage } from '../sdk/types'

export interface ParsedTaskNotification {
  taskId: string
  /** Absent when the XML carries none (or one this reader does not know). */
  status?: TaskTerminalStatus
  summary: string
  /**
   * The `<result>` body: the run's final text, or cli.js's own sentence under a
   * hand-back. Always set by {@link parseTaskNotificationXml}; optional so a
   * note title can be built from the live frame's fields alone.
   */
  result?: string
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
    result: get('result'),
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

/**
 * Whether a user frame (live) or transcript line (history) is a task
 * notification cli.js delivered — never something the user typed.
 *
 * The marker is structural first: cli.js (2.1.241+) stamps every user message
 * with an `origin` — `{kind: 'task-notification', …}` for a notification (on
 * the wire through its stream converters, on disk on the user line and on the
 * `queued_command` attachment), `{kind: 'human'}` for a typed prompt. A frame
 * or line that carries an `origin` kind is decided by it alone. Only one
 * without (a pre-2.1.241 transcript or frame) falls back to the text: a
 * `<task-notification>` block that names a task AND a known status (the rule
 * the history loader always applied).
 */
export function isTaskNotificationDelivery(origin: unknown, text: string): boolean {
  const kind =
    origin && typeof origin === 'object' ? (origin as { kind?: unknown }).kind : undefined
  if (typeof kind === 'string') return kind === 'task-notification'
  return parseTaskNotificationXml(text)?.status !== undefined
}

const NOTE_TITLE_MAX = 120

/**
 * The agent note's TEXT for a notification seen as cli.js's
 * `system/task_notification` frame (the live signal: ClaudeUI passes no
 * `--replay-user-messages`, so the XML user message never reaches stdout —
 * docs/protocol-cc/03-inbound-messages.md §3.4). Synthesised from the frame's
 * own fields only, never model text beyond the summary; the history loader
 * shows the delivered XML itself.
 */
export function taskNotificationNoteText(fields: {
  taskId: string
  status: string
  summary: string
  usage?: TaskNotification['usage']
}): string {
  const lines = [`Task ${fields.taskId}: ${fields.status}`]
  if (fields.summary) lines.push(fields.summary)
  const u = fields.usage
  if (u) {
    lines.push(
      `Usage: ${u.totalTokens} tokens · ${u.toolUses} tool uses · ${Math.round(u.durationMs / 1000)}s`
    )
  }
  return lines.join('\n')
}

/**
 * The `<summary>` line cli.js itself writes into a delivered notification,
 * rebuilt for the LIVE note from what `task_started` told us — so the live
 * title matches the one the history loader reads from the XML. The live
 * `system/task_notification.summary` is NOT this line: for an agent it carries
 * the agent's result (model-authored), so it is never a title.
 *
 * cli.js 2.1.285 (find by the strings `vWt='Agent "'` and `Dbe="Background
 * command "` in vendor/claude-cli/cli.js):
 * - agent (`Not`): `Agent "<description>" ` + `finished` | `failed: <error>` |
 *   `was stopped by Claude` | `was stopped by user` | `was stopped…`;
 * - background shell: `Background command "<description>" ` + `completed
 *   (exit code N)` | `failed with exit code N` | `was stopped…`.
 * The live frame carries no error text, exit code or stopper, so those tails
 * are left off: a completed agent's title matches exactly, the others match up
 * to that tail. Null without a description (the caller falls back to a status
 * title).
 */
export function liveTaskNoteSummary(task: {
  taskType: string
  description: string
  status: TaskTerminalStatus
}): string | null {
  if (!task.description) return null
  if (task.taskType === 'local_bash') {
    const verb =
      task.status === 'completed'
        ? 'completed'
        : task.status === 'failed'
          ? 'failed'
          : 'was stopped'
    return `Background command "${task.description}" ${verb}`
  }
  const verb =
    task.status === 'completed' ? 'finished' : task.status === 'failed' ? 'failed' : 'was stopped'
  return `Agent "${task.description}" ${verb}`
}

/** cli.js's terminal status words → ClaudeUI's (`killed` reads `stopped`). */
export function taskTerminalStatus(raw: string | undefined): TaskTerminalStatus | undefined {
  return raw ? STATUS[raw] : undefined
}

/**
 * The agent note's title for a delivered notification (live and history use
 * the same one): the summary's first line, clipped; else the status; else a
 * generic title. Derives nothing beyond what {@link parseTaskNotificationXml}
 * already parsed.
 */
export function taskNotificationNoteTitle(parsed: ParsedTaskNotification | null): string {
  const first = parsed?.summary.split('\n')[0].trim() ?? ''
  if (first) return first.length > NOTE_TITLE_MAX ? `${first.slice(0, NOTE_TITLE_MAX - 1)}…` : first
  switch (parsed?.status) {
    case 'completed':
      return 'Agent completed'
    case 'failed':
      return 'Agent failed'
    case 'stopped':
      return 'Agent was stopped'
    default:
      return 'Agent notification'
  }
}

/**
 * The report fields of a `system/task_notification` whose subagent reported
 * through `SubagentHandback` (auto mode, cli.js 2.1.293+). Under a hand-back
 * cli.js's `summary` is only a pointer sentence ("This agent's report was
 * delivered to you as a message from NAME … it is not repeated here") and the
 * report lives in `handback_report.text`; its schema says to render that INSTEAD
 * of `summary`, with the `warning` above it.
 *
 * - `send` / `flagged` with a report → `summary` is the report, `warning` rides
 *   separately (flagged only);
 * - `withheld` → `summary` is {@link HANDBACK_WITHHELD_TEXT}, not cli.js's
 *   model-directed text;
 * - no hand-back, an unknown value, or `send` / `flagged` with no report text →
 *   `summary` is cli.js's own and nothing is claimed.
 */
export function handbackNotificationFields(
  msg: Pick<SystemMessage, 'handback' | 'handback_report' | 'summary'>
): Pick<TaskNotification, 'summary' | 'handback' | 'warning'> {
  const summary = msg.summary || ''
  const handback = msg.handback
  if (handback === 'withheld') return { summary: HANDBACK_WITHHELD_TEXT, handback }
  if (handback !== 'send' && handback !== 'flagged') return { summary }
  const text = msg.handback_report?.text
  if (typeof text !== 'string' || text === '') return { summary }
  const warning = msg.handback_report?.warning
  return {
    summary: text,
    handback,
    ...(handback === 'flagged' && typeof warning === 'string' && warning ? { warning } : {})
  }
}

/**
 * How a hand-back reads in a TRANSCRIPT (cli.js 2.1.293), where the live frame's
 * `handback` / `handback_report` do not exist. Two rows carry it:
 *
 * - the notification XML's `<result>`: under a hand-back that was delivered it holds
 *   cli.js's pointer sentence (`Nns`), NEVER the report — `This agent's report was
 *   delivered to you as a message from "NAME" (its SubagentHandback call)` plus `, under
 *   a SECURITY WARNING from auto mode — the warning above the report says why` when
 *   flagged, then `Read it there; it is not repeated here.`; a subagent that ended
 *   without delivering gets `The subagent ended without delivering a report through
 *   SubagentHandback, so no report was delivered.` (`GOn`, and ` Send the agent a
 *   message (SendMessage) ...` after it for a main-agent owner). A line of other
 *   harness text (`⚠ ...`, the max-turns note) can precede either;
 * - a `user` row, `isMeta`, `turnOrigin: 'peer'`, `origin: {kind: 'peer', from,
 *   senderTaskId, name, body, handback: true, flagged?: true}` — the report as the
 *   parent model read it (`origin.body`, see {@link parseNativeHandbackFrame}).
 *
 * `unavailable` review verdicts mark the report neither flagged nor unflagged in the
 * XML (the pointer is the plain one) and carry a note, not a warning, in the body.
 */
const HANDBACK_POINTER =
  /^This agent's report was delivered to you as a message from "[^\n]*" \(its SubagentHandback call\)(, under a SECURITY WARNING from auto mode \u2014 the warning above the report says why)?\. Read it there; it is not repeated here\.$/
const HANDBACK_WITHHELD_SENTENCE =
  /^The subagent ended without delivering a report through SubagentHandback, so no report was delivered\. Its unsent text is not shown\.(?: Send the agent a message \(SendMessage\) to ask it to deliver its report\.)?$/
/**
 * The harness's own lines that cli.js puts BEFORE its hand-back sentence in `<result>`
 * (`k6n`: the artifact note - in real transcripts an entity-escaped
 * `<artifact-content-authored-by-others/>` line and its sentence - the max-turns note, and
 * `\u26a0 <notice>`; the sentence is pushed after them and, with no report to follow,
 * last). Any other line is model text.
 */
const HANDBACK_NOTICE_LINE =
  /^(?:\u26a0 |.*-turn limit before finishing\.|(?:&lt;|<)artifact-content-authored-by-others\/(?:&gt;|>)|This agent read Artifact content written by people other than you)/

/** The fields of a `withheld` hand-back, as live ({@link handbackNotificationFields}). */
export const HANDBACK_WITHHELD_FIELDS: Pick<TaskNotification, 'summary' | 'handback'> = {
  summary: HANDBACK_WITHHELD_TEXT,
  handback: 'withheld'
}

/**
 * What a notification's `<result>` says about a hand-back: `send` / `flagged` for the
 * pointer sentence (the report is in the peer row), `withheld` for the "ended without
 * delivering" sentence, undefined for anything else (an ordinary result — also the
 * interim "has not reported yet" sentence, which claims nothing, as live).
 */
export function handbackFromNotificationResult(
  result: string | undefined
): TaskHandback | undefined {
  if (!result) return undefined
  // The sentence is the LAST line of the result, behind nothing but cli.js's own notice
  // lines. Where cli.js writes the result itself (the hand-back contract) that is exactly
  // its shape; a result that is a model's own text (no contract) can quote a sentence
  // anywhere in it, and a quoted one must not turn an ordinary result into a hand-back.
  const lines = result.split('\n')
  const last = lines[lines.length - 1].trim()
  const before = lines.slice(0, -1)
  if (!before.every((line) => line.trim() === '' || HANDBACK_NOTICE_LINE.test(line.trim()))) {
    return undefined
  }
  const pointer = HANDBACK_POINTER.exec(last)
  if (pointer) return pointer[1] ? 'flagged' : 'send'
  return HANDBACK_WITHHELD_SENTENCE.test(last) ? 'withheld' : undefined
}

/** The peer-row `origin` of a delivered hand-back; null for any other origin. */
export function handbackPeerOrigin(
  origin: unknown
): { taskId: string; flagged: boolean; body: string } | null {
  if (!origin || typeof origin !== 'object') return null
  const o = origin as {
    kind?: unknown
    handback?: unknown
    senderTaskId?: unknown
    flagged?: unknown
    body?: unknown
  }
  if (o.kind !== 'peer' || o.handback !== true) return null
  if (typeof o.senderTaskId !== 'string' || !o.senderTaskId) return null
  if (typeof o.body !== 'string') return null
  return { taskId: o.senderTaskId, flagged: o.flagged === true, body: o.body }
}

/** The hand-back frame's header line, up to the part that varies between cli.js versions. */
const HANDBACK_FRAME_HEADER_START = '[Subagent hand-back] The text below is the final report'
const HANDBACK_FRAME_HEADER_END = 'The report follows:'
/** The line cli.js prepends when the report matched a reportable pattern, and the blank line after it. */
const HANDBACK_MARKER =
  /^\[harness: subagent output matched instruction-shaped pattern\(s\): [^\n]*to you\.\]\n\n/
/** A report cli.js persisted to a file because it was too long: only a pointer is in the frame. */
const HANDBACK_PERSISTED_POINTER = /^<\\?(?:persisted|truncated)-output>/

/**
 * Read a delivered hand-back's `origin.body` back into the report and the warning
 * above it — the inverse of cli.js's frame (`bcr` / `fkt` in cli.js 2.1.293):
 *
 *     [indented warning lines]            ← only when auto mode flagged it (or a review note)
 *     [Subagent hand-back] The text below is the final report of a subagent ... The report follows:
 *       [harness: subagent output matched ...]   ← only when a reportable pattern matched
 *       <blank>
 *       <report line>                     ← EVERY line indented two spaces
 *
 * The report was sanitised (`<` -> `<\` on harness-markup look-alikes, `Human\:`) before
 * it was framed; that is what the live `handback_report.text` carries too, minus the
 * marker, which is removed here. `exact` is false when cli.js replaced a too-long
 * report with a pointer to a file, so the text is not the report. Null when the body is
 * not in this shape (another cli.js version, a line out of the indent), so the caller
 * never shows framed text as a report.
 */
export function parseNativeHandbackFrame(
  body: string
): { report: string; warning?: string; exact: boolean } | null {
  const lines = body.split('\n')
  const header = lines.findIndex(
    (line) =>
      line.startsWith(HANDBACK_FRAME_HEADER_START) && line.endsWith(HANDBACK_FRAME_HEADER_END)
  )
  if (header < 0 || header === lines.length - 1) return null
  const indented = (line: string): boolean => line.startsWith('  ')
  const before = lines.slice(0, header)
  const after = lines.slice(header + 1)
  if (!before.every(indented) || !after.every(indented)) return null
  const warning = before.map((line) => line.slice(2)).join('\n')
  const report = after
    .map((line) => line.slice(2))
    .join('\n')
    .replace(HANDBACK_MARKER, '')
  if (report.trim() === '') return null
  return {
    report,
    ...(warning ? { warning } : {}),
    exact: !HANDBACK_PERSISTED_POINTER.test(report)
  }
}

/**
 * The fields a reopened session gives a notification whose subagent reported through
 * `SubagentHandback` — the same ones the live frame gives it
 * ({@link handbackNotificationFields}): the report as `summary`, `handback`, and a
 * flagged report's `warning` (a generic one when the transcript kept no reason). A
 * `send` report keeps no warning, as live: a review that could not run is a note.
 */
export function handbackTranscriptFields(
  handback: 'send' | 'flagged',
  report: { text: string; warning?: string }
): Pick<TaskNotification, 'summary' | 'handback' | 'warning'> {
  return {
    summary: report.text,
    handback,
    ...(handback === 'flagged'
      ? { warning: report.warning || HANDBACK_FLAGGED_GENERIC_WARNING }
      : {})
  }
}

/**
 * cli.js's pointer `result` for a hand-back: after a `handbackPointer`
 * notification it emits `system/init` then a `result` with `num_turns: 0`,
 * `result: ''`, `duration_api_ms: 0` and `origin.kind: 'task-notification'` — the
 * notification never queries the model (the hand-back prompt already woke the
 * parent), so no turn ran and none ended. Verified on 2.1.293
 * (docs/protocol-cc/03-inbound-messages.md §3.7). A notification that DOES wake
 * the model (a background Bash) carries the same origin with `num_turns >= 1`.
 */
export function isHandbackPointerResult(
  msg: Pick<ResultMessage, 'num_turns' | 'origin' | 'subtype'>
): boolean {
  return (
    msg.num_turns === 0 &&
    msg.origin?.kind === 'task-notification' &&
    (msg.subtype === undefined || msg.subtype === 'success')
  )
}
