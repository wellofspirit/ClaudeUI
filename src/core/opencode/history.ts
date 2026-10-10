/**
 * Cold history for opencode 2.x (ADR-097 S4): the stored `Session.Message`
 * rows of `GET /api/session/:id/message` → the same engine-neutral transcript
 * the live mapper (`event-mapper.ts`) streams, so a reopened chat reads
 * exactly as it did live. Parity is pinned by recorded 2.0.24 sequences
 * (`__tests__/history-parity.test.ts`) and a contract case against the real
 * engine.
 *
 * Shape decisions that make the two paths equal:
 * - one ChatMessage per `assistant` row (= one step), id and timestamp from
 *   the row; text/thinking/tool_use in content order, EMPTY text/thinking
 *   dropped (the live mapper never places them); the step's `tool_result`
 *   blocks after its other blocks, in call order (where the reducer's
 *   append puts them live);
 * - `user` rows of the OWN session become user rows (id = inbox id); a child's
 *   (the subagent prompt) is skipped, as live;
 * - a completed compaction is a separator row with opencode's summary;
 * - `synthetic`, `system`, `skill`, `shell`, `idle` and the switch markers
 *   carry nothing a transcript row shows (an interrupted turn keeps its
 *   partial blocks; ADR-090 adds no stop row);
 * - a subagent call's child transcript goes under `subagentMessages[callID]`
 *   (grandchildren under the child's own call), with one terminal
 *   `TaskNotification` per call.
 *
 * Not reproduced: the host's own denial blocks and auth rows — opencode does
 * not store them (as in 1.x).
 */
import type { ChatMessage, ContentBlock, TaskNotification } from '../../shared/types'
import type {
  Session_Message_Assistant,
  Session_Message_Info,
  Session_Message_Assistant_Tool
} from './protocol-v2/openapi'
import {
  compactionChatMessage,
  subagentBackgrounded,
  subagentChildSession,
  SUBAGENT_TOOL_NAMES,
  toolFailureResult,
  toolInputRecord,
  toolSuccessResult,
  userChatMessage,
  type OpencodeToolResult
} from './content'

export interface OpencodeHistory {
  messages: ChatMessage[]
  /** Child transcripts by the subagent call that ran them (the `session:subagent-message` key). */
  subagentMessages: Record<string, ChatMessage[]>
  taskNotifications: TaskNotification[]
}

/** Stored rows of a session's children (and theirs), by child session id. */
export type OpencodeChildRows = ReadonlyMap<string, readonly Session_Message_Info[]>

function toolResult(tool: Session_Message_Assistant_Tool): OpencodeToolResult | null {
  const state = tool.state
  if (state.status === 'completed')
    return toolSuccessResult(tool.id, tool.name, state.content, state.metadata)
  if (state.status === 'error')
    return toolFailureResult(tool.id, state.error, state.content, state.metadata)
  return null
}

/** One step as the transcript row the live mapper builds; null when it shows nothing. */
export function assistantChatMessage(row: Session_Message_Assistant): ChatMessage | null {
  const content: ContentBlock[] = []
  const results: ContentBlock[] = []
  for (const part of row.content) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'text', text: part.text })
    } else if (part.type === 'reasoning') {
      if (!part.text) continue
      const done = part.time?.completed
      content.push({
        type: 'thinking',
        text: part.text,
        ...(part.time && done !== undefined
          ? { durationMs: Math.max(0, done - part.time.created) }
          : {})
      })
    } else {
      content.push({
        type: 'tool_use',
        toolUseId: part.id,
        toolName: part.name,
        toolInput: toolInputRecord(part.state.input)
      })
      const result = toolResult(part)
      if (result)
        results.push({
          type: 'tool_result',
          toolUseId: result.toolUseId,
          toolResult: result.result,
          isError: result.isError,
          ...(result.fileDiffs ? { fileDiffs: result.fileDiffs } : {}),
          ...(result.images ? { images: result.images } : {})
        })
    }
  }
  if (content.length === 0) return null
  return {
    id: row.id,
    role: 'assistant',
    content: [...content, ...results],
    timestamp: row.time.created
  }
}

/** The outcome a background child's stored rows end on, as a task status. */
function childOutcome(
  rows: readonly Session_Message_Info[] | undefined
): TaskNotification['status'] {
  const idle = rows?.findLast((row) => row.type === 'idle')
  if (idle?.type !== 'idle') return 'unfinished'
  return idle.outcome === 'succeeded'
    ? 'completed'
    : idle.outcome === 'failed'
      ? 'failed'
      : 'stopped'
}

/**
 * Convert a session's stored rows. `children` holds the rows of every child
 * session the subagent calls name (`loadOpencodeHistory` reads them); a child
 * missing from it still gets its call's notification, just no transcript.
 *
 * A child RESUMED by a later call (`subagent {sessionID}`) holds every run in
 * one session. Live, each run streams under the call that started it (the
 * mapper re-links the child at that call's progress), so here a child's rows
 * are split the same way: each call owns the rows from its own start (the
 * call's `time.ran`, i.e. its `tool.called`) up to the next call's.
 */
export function convertOpencodeHistory(
  rows: readonly Session_Message_Info[],
  children: OpencodeChildRows = new Map()
): OpencodeHistory {
  const history: OpencodeHistory = { messages: [], subagentMessages: {}, taskNotifications: [] }
  const calls = callsByChild([rows, ...children.values()])
  convertInto(history, rows, { children, calls, path: new Set() }, null)
  return history
}

interface ChildCall {
  readonly toolId: string
  /** When the call started (ms), if the row says. */
  readonly start: number | undefined
}

interface Walk {
  readonly children: OpencodeChildRows
  readonly calls: ReadonlyMap<string, readonly ChildCall[]>
  /** Child sessions being converted on the current path (a cycle guard). */
  readonly path: Set<string>
}

function childOfCall(tool: Session_Message_Assistant_Tool): string | undefined {
  const state = tool.state
  if (state.status === 'streaming') return undefined
  const text =
    state.status === 'error' ? state.error.message : (toolResult(tool)?.result ?? undefined)
  return subagentChildSession(tool.name, state.metadata, text)
}

/** Every subagent call per child session, in the order they started. */
function callsByChild(
  sessions: Iterable<readonly Session_Message_Info[]>
): Map<string, ChildCall[]> {
  const calls = new Map<string, ChildCall[]>()
  for (const rows of sessions)
    for (const row of rows) {
      if (row.type !== 'assistant') continue
      for (const part of row.content) {
        if (part.type !== 'tool' || !SUBAGENT_TOOL_NAMES.has(part.name)) continue
        const childID = childOfCall(part)
        if (!childID) continue
        const list = calls.get(childID) ?? []
        if (!list.some((call) => call.toolId === part.id))
          list.push({ toolId: part.id, start: part.time?.ran ?? part.time?.created })
        calls.set(childID, list)
      }
    }
  for (const list of calls.values())
    if (list.every((call) => call.start !== undefined))
      list.sort((a, b) => (a.start as number) - (b.start as number))
  return calls
}

/**
 * The rows of `childID` that ran under `toolId`. By start time when every
 * call has one; otherwise each subagent prompt (a child `user` row) opens the
 * next call's run.
 */
function segmentOf(
  rows: readonly Session_Message_Info[],
  calls: readonly ChildCall[],
  toolId: string
): readonly Session_Message_Info[] {
  const index = calls.findIndex((call) => call.toolId === toolId)
  if (calls.length <= 1 || index < 0) return rows
  if (calls.every((call) => call.start !== undefined)) {
    const from = index === 0 ? -Infinity : (calls[index].start as number)
    const to = index === calls.length - 1 ? Infinity : (calls[index + 1].start as number)
    return rows.filter((row) => row.time.created >= from && row.time.created < to)
  }
  let run = -1
  const out: Session_Message_Info[] = []
  for (const row of rows) {
    if (row.type === 'user') run = Math.min(run + 1, calls.length - 1)
    if (Math.max(run, 0) === index) out.push(row)
  }
  return out
}

function convertInto(
  history: OpencodeHistory,
  rows: readonly Session_Message_Info[],
  walk: Walk,
  owner: string | null
): void {
  const sink = owner === null ? history.messages : (history.subagentMessages[owner] ??= [])
  for (const row of rows) {
    if (row.type === 'user') {
      if (owner !== null) continue
      const message = userChatMessage(row.id, row, row.time.created)
      if (message) sink.push(message)
    } else if (row.type === 'compaction') {
      if (owner === null && row.status === 'completed')
        sink.push(compactionChatMessage(row.id, row.summary, row.time.created))
    } else if (row.type === 'assistant') {
      const message = assistantChatMessage(row)
      if (message) sink.push(message)
      for (const part of row.content)
        if (part.type === 'tool' && SUBAGENT_TOOL_NAMES.has(part.name))
          convertChild(history, part, walk)
    }
  }
  if (owner !== null && sink.length === 0) delete history.subagentMessages[owner]
}

function convertChild(
  history: OpencodeHistory,
  tool: Session_Message_Assistant_Tool,
  walk: Walk
): void {
  const state = tool.state
  const childID = childOfCall(tool)
  if (!childID || state.status === 'streaming') return
  const all = walk.children.get(childID)
  const rows = all ? segmentOf(all, walk.calls.get(childID) ?? [], tool.id) : undefined
  if (rows && !walk.path.has(childID)) {
    walk.path.add(childID)
    convertInto(history, rows, walk, tool.id)
    walk.path.delete(childID)
  }
  if (state.status === 'running') return
  const status: TaskNotification['status'] =
    state.status === 'error'
      ? state.error.type === 'aborted'
        ? 'stopped'
        : 'failed'
      : subagentBackgrounded(state.metadata)
        ? childOutcome(rows)
        : 'completed'
  history.taskNotifications.push({
    taskId: childID,
    toolUseId: tool.id,
    status,
    outputFile: '',
    summary: ''
  })
}

/** The child sessions a session's subagent calls ran (to read before converting). */
export function childSessionsOf(rows: readonly Session_Message_Info[]): string[] {
  return [...callsByChild([rows]).keys()]
}

/** Children read per history load, at most (nested ones included). */
export const MAX_HISTORY_CHILDREN = 200

/**
 * Child reads in flight at once. Siblings are independent, so one level is read
 * in parallel — one at a time made every child a full round trip (a session
 * with 9-15 children took ~250 ms against ~80 ms without) — but the server is
 * shared with live sessions, so a wide level does not get one request per child.
 */
export const HISTORY_READ_CONCURRENCY = 8

/**
 * Read a session's rows and, breadth-first, those of every child its
 * subagent calls ran (bounded). Each level is read in parallel and kept in
 * call order, so the result does not depend on which read answers first. A
 * child that cannot be read is skipped: its call still renders, with its
 * notification and without a transcript.
 */
export async function readOpencodeHistory(
  listMessages: (sessionID: string) => Promise<Session_Message_Info[]>,
  sessionID: string
): Promise<{ rows: Session_Message_Info[]; children: Map<string, Session_Message_Info[]> }> {
  const rows = await listMessages(sessionID)
  const children = new Map<string, Session_Message_Info[]>()
  const seen = new Set([sessionID])
  let level = childSessionsOf(rows)
  while (level.length > 0 && children.size < MAX_HISTORY_CHILDREN) {
    const ids = [...new Set(level)]
      .filter((id) => !seen.has(id))
      .slice(0, MAX_HISTORY_CHILDREN - children.size)
    for (const id of ids) seen.add(id)
    const read: (Session_Message_Info[] | null)[] = []
    for (let i = 0; i < ids.length; i += HISTORY_READ_CONCURRENCY) {
      const batch = ids.slice(i, i + HISTORY_READ_CONCURRENCY)
      read.push(...(await Promise.all(batch.map((id) => listMessages(id).catch(() => null)))))
    }
    level = []
    ids.forEach((id, i) => {
      const childRows = read[i]
      if (!childRows) return
      children.set(id, childRows)
      level.push(...childSessionsOf(childRows))
    })
  }
  return { rows, children }
}
