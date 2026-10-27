/**
 * A Claude subagent's hand-back, read back from a transcript (S6 showed it live; this is
 * the reload). The live frame carries `handback` / `handback_report`; the transcript
 * carries the same facts in two other rows (task-notification-xml.ts documents them):
 * the notification's `<result>` (a pointer sentence, or the "ended without delivering"
 * sentence) and the peer row holding the report as the parent read it.
 *
 * {@link applyHandbacks} runs once the whole transcript is read, because the peer row
 * and its notification arrive in either order. For each notification:
 *
 *  - pointer sentence (`send` / `flagged`): the report comes from the paired peer row
 *    (same `senderTaskId`, in order, and not beyond the task's next notification), unframed
 *    exactly; when the body cannot be unframed exactly it comes from the subagent's own
 *    `SubagentHandback` call IN THIS RUN (its row lies after the task's previous
 *    notification and at or before this one) in its sidechain, neutralised as the live text
 *    is (untrusted, shown the same way) - never the framed text, never another run's call.
 *    A flagged notification, or a flagged peer, is flagged;
 *  - "ended without delivering" sentence (`withheld`): the withheld line;
 *  - anything else: untouched.
 *
 * The paired peer row is dropped from the conversation (it has no live counterpart: ClaudeUI
 * does not ask cli.js to replay user messages), and the notification's agent note carries the
 * report, as the live note does. A peer with no notification, or a notification whose report
 * cannot be had, keeps today's rows.
 */
import * as fs from 'fs'
import type { ChatMessage, TaskNotification } from '../../shared/types'
import { sanitizeReport } from '../../shared/handback-frame'
import { agentNoteMessage } from './agent-note'
import {
  HANDBACK_WITHHELD_FIELDS,
  handbackFromNotificationResult,
  handbackTranscriptFields,
  parseNativeHandbackFrame,
  taskNotificationNoteText,
  type ParsedTaskNotification
} from './task-notification-xml'

/**
 * A hand-back peer row (`origin.handback`): a `user` row, with the note the loader made for
 * it, or a `queued_command` attachment (a hand-back absorbed mid-turn), which is no row and
 * has no note.
 */
export interface HandbackPeerRow {
  taskId: string
  flagged: boolean
  /** `origin.body`: the framed report. */
  body: string
  note?: ChatMessage
  /** The row's `timestamp` (ms); absent when it carries none. */
  timestamp?: number
}

/** A notification the loader recorded, in transcript order, with its delivered agent note when it had one. */
export interface HandbackNotice {
  entry: TaskNotification
  parsed: ParsedTaskNotification
  note?: ChatMessage
  /** When the notification first appeared in the transcript (ms): the run it ends finished by then. */
  timestamp?: number
}

/** One `SubagentHandback` call of a subagent transcript. */
export interface SidechainCall {
  /** The row's `timestamp` (ms). */
  timestamp: number
  message: string
}

/** Every `SubagentHandback` call of a subagent transcript, in order (a resumed agent makes one per run). */
export async function readSidechainHandbackCalls(filePath: string): Promise<SidechainCall[]> {
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return []
  }
  const calls: SidechainCall[] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('SubagentHandback')) continue
    try {
      const row = JSON.parse(line)
      const timestamp = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
      if (!Number.isFinite(timestamp) || !Array.isArray(row?.message?.content)) continue
      for (const block of row.message.content) {
        const message =
          block?.type === 'tool_use' && block.name === 'SubagentHandback' && block.input?.message
        if (typeof message === 'string' && message.trim() !== '') calls.push({ timestamp, message })
      }
    } catch {
      // a half-written last line: the calls before it stand
    }
  }
  return calls
}

/** The note rebuilt with the hand-back's fields, titled as it was. */
function noteWithReport(note: ChatMessage, entry: TaskNotification): ChatMessage {
  const block = note.content[0]
  if (block?.type !== 'context_note') return note
  const summary = entry.warning
    ? `Security warning: ${entry.warning}\n\n${entry.summary}`
    : entry.summary
  return agentNoteMessage({
    id: note.id,
    title: block.title,
    text: taskNotificationNoteText({
      taskId: entry.taskId,
      status: entry.status,
      summary,
      ...(entry.usage ? { usage: entry.usage } : {})
    }),
    timestamp: note.timestamp
  })
}

export async function applyHandbacks(input: {
  notices: readonly HandbackNotice[]
  peers: readonly HandbackPeerRow[]
  /** Rewritten in place: paired peer rows dropped, delivered notes reworded. */
  messages: ChatMessage[]
  /** The subagent's `SubagentHandback` calls for a task id (read once per task here). */
  sidechainCalls: (taskId: string) => Promise<SidechainCall[]>
}): Promise<void> {
  const unclaimed = new Map<string, HandbackPeerRow[]>()
  for (const peer of input.peers) {
    const list = unclaimed.get(peer.taskId)
    if (list) list.push(peer)
    else unclaimed.set(peer.taskId, [peer])
  }
  // The task's notifications in transcript order: each run is bounded by its neighbours.
  const runsOf = new Map<string, HandbackNotice[]>()
  for (const notice of input.notices) {
    const list = runsOf.get(notice.entry.taskId)
    if (list) list.push(notice)
    else runsOf.set(notice.entry.taskId, [notice])
  }
  const sidechains = new Map<string, Promise<SidechainCall[]>>()
  const callsOf = (taskId: string): Promise<SidechainCall[]> => {
    let calls = sidechains.get(taskId)
    if (!calls) {
      calls = input.sidechainCalls(taskId)
      sidechains.set(taskId, calls)
    }
    return calls
  }
  const dropped = new Set<ChatMessage>()
  const rewordedNotes = new Map<ChatMessage, ChatMessage>()

  for (const notice of input.notices) {
    const { entry, parsed, note } = notice
    const handback = handbackFromNotificationResult(parsed.result)
    if (!handback) continue
    if (handback === 'withheld') {
      Object.assign(entry, HANDBACK_WITHHELD_FIELDS)
    } else {
      const runs = runsOf.get(entry.taskId) ?? []
      const at = runs.indexOf(notice)
      const previous = at > 0 ? runs[at - 1].timestamp : undefined
      const next = runs[at + 1]?.timestamp
      // A peer row belongs to the run whose notification it follows: not to an earlier run
      // that had none (the row lies beyond the next notification of the task), and a row
      // once taken is that run's, readable or not.
      const eligible = unclaimed.get(entry.taskId)
      const index =
        eligible?.findIndex(
          (p) => next === undefined || p.timestamp === undefined || p.timestamp < next
        ) ?? -1
      const peer = index >= 0 ? eligible![index] : undefined
      if (peer) eligible!.splice(index, 1)
      const frame = peer ? parseNativeHandbackFrame(peer.body) : null
      const text = frame?.exact
        ? frame.report
        : runsOwnCall(await callsOf(entry.taskId), previous, notice.timestamp)
      if (text === null) continue // no report to show: the notification and its peer row stay as they are
      // The warning is auto mode's, kept only for a flagged report: a `send` whose
      // review could not run carries a note in the frame, not a warning (as live).
      const flagged = handback === 'flagged' || peer?.flagged === true
      Object.assign(
        entry,
        handbackTranscriptFields(flagged ? 'flagged' : 'send', {
          text,
          ...(frame?.warning ? { warning: frame.warning } : {})
        })
      )
      if (peer?.note) dropped.add(peer.note)
    }
    if (note) rewordedNotes.set(note, noteWithReport(note, entry))
  }

  if (dropped.size === 0 && rewordedNotes.size === 0) return
  const kept = input.messages
    .filter((message) => !dropped.has(message))
    .map((message) => rewordedNotes.get(message) ?? message)
  input.messages.length = 0
  input.messages.push(...kept)
}

/**
 * The text of the call that ended THIS run: the last one whose row lies after the task's
 * previous notification and at or before this one. Null when none does (or a time is
 * unknown): another run's report must never stand in for it, least of all a flagged one
 * under a `send`. Neutralised as the live `handback_report.text` is.
 */
function runsOwnCall(
  calls: readonly SidechainCall[],
  previous: number | undefined,
  end: number | undefined
): string | null {
  if (end === undefined) return null
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]
    if (call.timestamp <= end && (previous === undefined || call.timestamp > previous)) {
      return sanitizeReport(call.message).text
    }
  }
  return null
}
