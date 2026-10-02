/**
 * pi-session-list.ts
 *
 * Builds the sidebar's pi session list, and loads a session's transcript.
 *
 * Unlike opencode (one global SQLite DB, HTTP API for history), pi persists
 * each session as its own JSONL file under
 * `~/.pi/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<uuid>.jsonl` (verified —
 * docs/protocol-pi/README.md "Sessions on disk"). Everything here is a
 * pure-fs, READ-ONLY walk of that tree (product code never writes to
 * `~/.pi/**` — pi itself owns writes; delete is the one sanctioned exception,
 * mirroring Claude's own JSONL delete).
 *
 * Best-effort throughout: any error (pi never run, corrupt file, permission
 * denied) degrades to an empty/no-op result — this NEVER throws and NEVER
 * breaks the Claude/opencode sidebar.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  ChatMessage,
  ContentBlock,
  EngineHistoryLoad,
  ForkAnchorResult,
  SessionInfo,
  TaskNotification,
  TaskTerminalStatus
} from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type {
  PiAgentMessage,
  PiImageContent,
  PiSessionEntry,
  PiSessionHeader,
  PiTextContent,
  PiToolResultMessage,
  PiUserMessage
} from '../pi/pi-protocol'
import { cwdToProjectKey } from '../../shared/project-key'
import { piToolResultImages, piToolResultText } from '../pi/event-mapper'
import { piCustomMessageToChat } from '../pi/pi-custom-message'
import { piAgentDeliveryDetails } from '../pi/pi-delivery'
import { piHistoryStatusLine, piLastModelRef } from '../pi/history-status-line'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { dispatchedCostEntriesFor } from './dispatched-cost-entries'
import { findPiForkAnchorEntryId } from './fork-anchor'
import { logger } from './logger'
import { blobStore } from './blob-store'
import {
  childSessionFile,
  collectAgentIds,
  collectAgentLinkRecords,
  deleteChildSession,
  type PiAgentLinkRecord
} from '../pi/pi-subagent-store'

/** `~/.pi/agent` — pi's own data root. */
export function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

/**
 * The tree the sidebar lists and `findPiSessionFile` walks. Host-run subagent
 * children live under `~/.claude/ui/pi-subagents` instead, by design (ADR-089):
 * they are never listed or resumed as sessions of their own.
 */
function piSessionsDir(): string {
  return path.join(piAgentDir(), 'sessions')
}

interface ParsedPiSessionFile {
  header: PiSessionHeader
  /** Append order (file order) — NOT necessarily the active branch; walk via parentId for that. */
  entries: PiSessionEntry[]
}

/** Best-effort read+parse of one session .jsonl file. Returns null on any failure. */
function readPiSessionFile(filePath: string): ParsedPiSessionFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return null

    const header = JSON.parse(lines[0]) as PiSessionHeader
    if (header?.type !== 'session') return null

    const entries: PiSessionEntry[] = []
    for (let i = 1; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]) as PiSessionEntry)
      } catch {
        // Skip a single corrupt line rather than discarding the whole file.
      }
    }
    return { header, entries }
  } catch {
    return null
  }
}

/** Every `sessions/--<mangled-cwd>--/*.jsonl` path, across all projects. Best-effort: [] if the dir tree is missing/unreadable. */
function walkAllSessionFiles(): string[] {
  const dir = piSessionsDir()
  let projectDirs: string[] = []
  try {
    projectDirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
  } catch {
    return [] // pi never run (no sessions dir yet), or unreadable — not an error worth surfacing.
  }

  const files: string[] = []
  for (const projectDir of projectDirs) {
    try {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith('.jsonl')) files.push(path.join(projectDir, f))
      }
    } catch {
      // Unreadable project dir — skip it, keep going.
    }
  }
  return files
}

/**
 * Walk from the LAST entry in the file up to root via parentId, then reverse
 * — the active branch (verified — docs/protocol-pi/README.md "Sessions on
 * disk"). Entries from an abandoned fork/branch are excluded automatically:
 * they simply aren't ancestors of the current leaf. A `seen` guard defends
 * against a malformed cyclic parentId chain (defensive; should never occur).
 */
function activeBranchEntries(entries: PiSessionEntry[]): PiSessionEntry[] {
  if (entries.length === 0) return []
  const byId = new Map(entries.map((e) => [e.id, e]))
  const leaf = entries[entries.length - 1]

  const chain: PiSessionEntry[] = []
  const seen = new Set<string>()
  let cur: PiSessionEntry | undefined = leaf
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return chain.reverse()
}

const TITLE_TEXT_CAP = 80

function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  return idx >= 0 ? text.slice(0, idx) : text
}

function textFromUserContent(content: PiUserMessage['content']): string {
  if (typeof content === 'string') return content
  const textBlock = content.find((b) => b.type === 'text')
  return textBlock && textBlock.type === 'text' ? textBlock.text : ''
}

/**
 * Title fallback chain: session_info name (last one wins — a session can be
 * renamed) → first user message's first line (trimmed, capped) → 'Untitled'.
 */
function resolveTitle(
  sessionInfoName: string | undefined,
  firstUserText: string | undefined
): string {
  const trimmedName = sessionInfoName?.trim()
  if (trimmedName) return trimmedName
  const trimmedText = firstUserText?.trim()
  if (trimmedText) {
    const line = firstLine(trimmedText)
    return line.length > TITLE_TEXT_CAP ? line.slice(0, TITLE_TEXT_CAP) : line
  }
  return 'Untitled'
}

/**
 * Header + title for ONE sidebar row WITHOUT the full-file parse
 * readPiSessionFile does. It reads the file but JSON-parses only the lines the
 * sidebar needs: the header (first line), any session_info rename (cheap
 * substring prefilter; last wins), and message lines up to the FIRST user
 * message. Large assistant/user image-bearing lines after that are scanned but
 * never parsed, so listing a directory of image-heavy sessions no longer
 * JSON.parses megabytes of base64 per row. Title semantics are identical to
 * readPiSessionFile + a whole-entry deriveTitle (guarded by the
 * listPiSessionsGlobal tests). Returns null on any failure (unreadable / no
 * header / non-session header) — same contract as readPiSessionFile.
 */
function readPiSessionListRow(filePath: string): { header: PiSessionHeader; title: string } | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
  const lines = raw.split('\n')

  // Header = first non-empty line, must be `type: 'session'`.
  let idx = 0
  let header: PiSessionHeader | null = null
  for (; idx < lines.length; idx++) {
    if (lines[idx].trim().length === 0) continue
    try {
      header = JSON.parse(lines[idx]) as PiSessionHeader
    } catch {
      return null
    }
    idx++
    break
  }
  if (header?.type !== 'session') return null

  let sessionInfoName: string | undefined
  let firstUserText: string | undefined
  for (; idx < lines.length; idx++) {
    const line = lines[idx]
    if (line.trim().length === 0) continue
    // Skip the parse for lines that can't affect the title: not a session_info
    // (last wins → must keep scanning ALL of these to end of file) and we
    // already have the first user message. The prefilter can only
    // FALSE-positive (a wasted parse), never false-negative — base64 image
    // payloads contain no quotes, so they can't spuriously match.
    const maybeSessionInfo = line.includes('"session_info"')
    if (!maybeSessionInfo && firstUserText !== undefined) continue
    let entry: PiSessionEntry
    try {
      entry = JSON.parse(line) as PiSessionEntry
    } catch {
      continue
    }
    if (entry.type === 'session_info') sessionInfoName = entry.name
    else if (
      firstUserText === undefined &&
      entry.type === 'message' &&
      entry.message.role === 'user'
    ) {
      firstUserText = textFromUserContent(entry.message.content)
    }
  }

  return { header, title: resolveTitle(sessionInfoName, firstUserText) }
}

/**
 * List ALL pi sessions (every cwd) for the sidebar. Pure-fs walk — no process
 * spawn needed (unlike opencode's DB read, there's no server/DB here at all).
 * Best-effort: any error → []. Sorted newest first by file mtime.
 */
export async function listPiSessionsGlobal(): Promise<SessionInfo[]> {
  // Async signature kept for the IPC contract (and parity with the opencode
  // sibling); the read itself is sync.
  const result: SessionInfo[] = []
  for (const filePath of walkAllSessionFiles()) {
    try {
      const row = readPiSessionListRow(filePath)
      if (!row || !row.header.cwd) continue
      const stat = fs.statSync(filePath)
      const headerTs = Date.parse(row.header.timestamp)
      result.push({
        sessionId: row.header.id,
        cwd: row.header.cwd,
        projectKey: cwdToProjectKey(row.header.cwd),
        title: row.title,
        timestamp: Number.isFinite(headerTs) ? headerTs : stat.mtimeMs,
        lastActivityAt: stat.mtimeMs,
        engineId: 'pi'
      })
    } catch (err) {
      logger.debug(
        'PiSessionList',
        `Skipping unreadable session file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  result.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return result
}

/** Scan session dirs for `*_<sessionId>.jsonl`. Returns the absolute path, or null if not found. */
export function findPiSessionFile(sessionId: string): string | null {
  const suffix = `_${sessionId}.jsonl`
  for (const filePath of walkAllSessionFiles()) {
    if (filePath.endsWith(suffix)) return filePath
  }
  return null
}

/**
 * Convert a single stored pi AgentMessage entry to a ChatMessage, or null if
 * it doesn't render as its own message. EXPORTED so PiSession's resume replay
 * reuses this EXACT conversion (single source of truth — mirrors opencode
 * event-mapper's `convertStoredMessage`).
 *
 * Mapping (same field conventions as the live mapper — src/main/pi/event-mapper.ts):
 *   user      → role 'user', string/array content → text/image blocks
 *   assistant → role 'assistant', text/thinking/toolCall → text/thinking/tool_use
 *               blocks; a completed toolCall ALSO gets a `tool_result` block
 *               immediately after it (looked up via `toolResultsByCallId`) —
 *               mirrors convertStoredMessage's tool_use+tool_result pairing
 *               (tool results live in the SAME message as their tool_use, not
 *               as their own message — unlike the live mapper's separate
 *               `session:tool-result` event, which pi-session-list.ts's caller
 *               (PiSession.replayStoredHistory) re-derives from these embedded
 *               blocks, exactly like OpencodeSession does).
 *   toolResult → null (folded into the preceding assistant message above,
 *               never its own ChatMessage — it has no independent entry here
 *               because pi's toolResult entries carry no displayable role of
 *               their own once merged).
 *   bashExecution → null (pi's RPC `bash` command output; no UI surface for
 *               it yet — out of M1 scope).
 *
 * M2: rich diff — pi's `edit` tool result carries a ready-made unified diff at
 * `details.patch`, and (unlike the live mapper) this function DOES have both
 * the toolCall's `arguments.path` and the toolResult's `details` in scope at
 * once. Deferred anyway, for consistency: pi's live and replayed tool cards
 * should render identically in M1, and the live path (event-mapper.ts) can't
 * do this without extra plumbing — see its identical note.
 */
export function convertPiEntryMessage(
  entryId: string,
  message: PiAgentMessage,
  toolResultsByCallId: ReadonlyMap<string, PiToolResultMessage>
): ChatMessage | null {
  if (message.role === 'user') {
    const content = convertPiTextOrImageContent(message.content)
    if (content.length === 0) return null
    return { id: entryId, role: 'user', content, timestamp: message.timestamp }
  }

  if (message.role === 'assistant') {
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', text: block.thinking })
      } else {
        content.push({
          type: 'tool_use',
          toolUseId: block.id,
          toolName: block.name,
          toolInput: block.arguments
        })
        const result = toolResultsByCallId.get(block.id)
        if (result) {
          // Shared with the live mapper (pi/event-mapper.ts) so a replayed
          // transcript produces byte-identical text + the same image set.
          const images = piToolResultImages(result.content)
          content.push({
            type: 'tool_result',
            toolUseId: block.id,
            toolResult: piToolResultText(result.content),
            isError: result.isError,
            ...(images ? { images } : {})
          })
        }
      }
    }
    if (content.length === 0) return null
    return { id: entryId, role: 'assistant', content, timestamp: message.timestamp }
  }

  // toolResult (folded above) / bashExecution (out of scope) — no own message.
  return null
}

function convertPiTextOrImageContent(
  content: string | Array<PiTextContent | PiImageContent>
): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  const blocks: ContentBlock[] = []
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) blocks.push({ type: 'text', text: b.text })
    } else if (isImageMediaType(b.mimeType)) {
      const ref = blobStore.put(b.mimeType, b.data)
      if (ref) blocks.push({ type: 'image', mediaType: b.mimeType, ...ref })
    }
    // Unrecognised mime types are dropped — see IMAGE_MEDIA_TYPES. So is a
    // payload the blob store refuses (ADR-087).
  }
  return blocks
}

/**
 * Convert a whole active-branch entry list to ChatMessage[], in order.
 * Two passes: (1) index every toolResult message by toolCallId, (2) convert
 * `message`/`compaction`/`custom_message` entries (everything else —
 * model_change, thinking_level_change, branch_summary, label, custom — is
 * skipped, matching convertStoredMessage's "silently skip unknown/irrelevant
 * types" precedent).
 */
export function convertPiSessionEntries(entries: PiSessionEntry[]): ChatMessage[] {
  const toolResultsByCallId = new Map<string, PiToolResultMessage>()
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'toolResult') {
      toolResultsByCallId.set(e.message.toolCallId, e.message)
    }
  }

  const messages: ChatMessage[] = []
  for (const e of entries) {
    if (e.type === 'message') {
      const msg = convertPiEntryMessage(e.id, e.message, toolResultsByCallId)
      if (msg) messages.push(msg)
    } else if (e.type === 'compaction') {
      const ts = Date.parse(e.timestamp)
      messages.push({
        id: e.id,
        role: 'system',
        // The WHOLE summary, not its first line (F20). `CompactSeparator`
        // renders a non-empty `text` as the expandable amber card and shows the
        // body only when the user opens it, so there was never a reason to
        // throw away the rest — and pi is the one harness that has one.
        content: [{ type: 'compact_separator', text: e.summary }],
        timestamp: Number.isFinite(ts) ? ts : Date.now()
      })
    } else if (e.type === 'custom_message' && e.display) {
      // An extension injected this into the model's context. It was dropped
      // entirely, so the transcript disagreed with what the model saw. Same row
      // Codex's hook fragments take, titled by the extension that wrote it, and
      // rendered VERBATIM — an extension's text is third-party text. The live
      // mapper uses the same converter (ADR-089 S3), and ClaudeUI's own agent
      // messages are recognised there by customType + details, never by text.
      const ts = Date.parse(e.timestamp)
      const msg = piCustomMessageToChat({
        id: e.id,
        customType: e.customType,
        content: e.content,
        display: e.display,
        details: e.details,
        timestamp: Number.isFinite(ts) ? ts : Date.now()
      })
      if (msg) messages.push(msg)
    }
  }
  return messages
}

/**
 * Load a persisted pi session's transcript, so the chat view can paint the
 * prior conversation immediately on sidebar click (parity with Claude's JSONL
 * load) and PiSession's resume replay can reuse the exact same pipeline, AND
 * the status line that goes with it: the same entries carry the per-message
 * `usage` the top bar's cost and token figures are made of (S1d).
 *
 * Best-effort: returns no messages and a null status line on any error (file
 * not found, corrupt, unreadable).
 */
export async function loadPiSessionHistory(sessionId: string): Promise<EngineHistoryLoad> {
  try {
    const filePath = findPiSessionFile(sessionId)
    if (!filePath) return { messages: [], statusLine: null }
    const parsed = readPiSessionFile(filePath)
    if (!parsed) return { messages: [], statusLine: null }
    const active = activeBranchEntries(parsed.entries)
    const messages = convertPiSessionEntries(active)
    const { messages: subagentMessages, childEntries } = loadSubagentMessages(active)
    const taskNotifications = collectPiTaskNotifications(active, childEntries)
    // The billing type decides what this history was WORTH (ADR-071 §2) and it
    // comes from the probe snapshot, which is empty in a process that has not
    // touched pi auth yet. Warm it FIRST (one small local file read), and never
    // let a probe failure cost the user their transcript — an unprobed vendor
    // reads as `unknown`, which prices the history at its list equivalent.
    await piAuthProvider.probe().catch(() => {})
    const statusLine =
      active.length > 0 ? piHistoryStatusLine(active, dispatchedCostEntriesFor(sessionId)) : null
    return {
      messages,
      statusLine,
      lastModel: piLastModelRef(active),
      ...(Object.keys(subagentMessages).length > 0 ? { subagentMessages } : {}),
      ...(taskNotifications.length > 0 ? { taskNotifications } : {})
    }
  } catch (err) {
    logger.debug(
      'PiSessionList',
      `loadPiSessionHistory(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return { messages: [], statusLine: null }
  }
}

/**
 * The depth-1 agent records a resumed PiSession rebuilds (ADR-089 S3b, G7),
 * from the parent's active branch. Best-effort: [] on any failure.
 */
export function loadPiAgentLinks(sessionId: string): PiAgentLinkRecord[] {
  try {
    const filePath = findPiSessionFile(sessionId)
    const parsed = filePath ? readPiSessionFile(filePath) : null
    return parsed ? collectAgentLinkRecords(activeBranchEntries(parsed.entries)) : []
  } catch {
    return []
  }
}

/** How deep a parent → child → grandchild chain is followed (the spawn cap, ADR-089 D4). */
const MAX_SUBAGENT_HISTORY_DEPTH = 3

/**
 * Host-run subagent transcripts for a parent's active branch (ADR-089), keyed
 * by the parent `agent` call id — the key `session:subagent-message` uses
 * live. Each child is read with the SAME `readPiSessionFile` →
 * `activeBranchEntries` → `convertPiSessionEntries` pipeline as the parent,
 * and its own `agent` calls are followed (depth ≤ 3, each child once). A
 * missing or corrupt child file is skipped; an invalid id never reaches a path
 * (pi-subagent-store's `isValidAgentId`).
 */
function loadSubagentMessages(parentEntries: PiSessionEntry[]): {
  messages: Record<string, ChatMessage[]>
  /** Each child's active branch, for the notifications a grandchild left in its spawner's file. */
  childEntries: PiSessionEntry[][]
} {
  const out: Record<string, ChatMessage[]> = {}
  const childEntries: PiSessionEntry[][] = []
  const visited = new Set<string>()
  const walk = (entries: PiSessionEntry[], depth: number): void => {
    if (depth > MAX_SUBAGENT_HISTORY_DEPTH) return
    for (const link of collectAgentIds(entries)) {
      if (visited.has(link.agentId)) continue
      visited.add(link.agentId)
      const file = childSessionFile(link.agentId)
      const parsed = file ? readPiSessionFile(file) : null
      if (!parsed) continue
      const childActive = activeBranchEntries(parsed.entries)
      out[link.toolUseId] = convertPiSessionEntries(childActive)
      childEntries.push(childActive)
      walk(childActive, depth + 1)
    }
  }
  walk(parentEntries, 1)
  return { messages: out, childEntries }
}

/** Same words as the Claude reader's (session-history.ts), for the same state. */
const PI_UNFINISHED_SUMMARY = 'The transcript ends before this agent reported back.'

const isTerminalStatus = (s: unknown): s is TaskTerminalStatus =>
  s === 'completed' || s === 'failed' || s === 'stopped'

/**
 * The host-run subagents' terminal events (ADR-089 S3), from every task
 * notification ClaudeUI delivered into these files (the parent's and each
 * child's — a grandchild's can land in its spawner's file). Read from the
 * stored `custom_message`'s customType + `details` ONLY, never from its text,
 * so a user message that merely looks like one counts for nothing. A
 * background launch (`cuiAgent.background`) with no notification at all reads
 * `unfinished` (ADR-073 §5): the transcript cannot tell a dead run from one
 * still going in another process.
 */
function collectPiTaskNotifications(
  parentEntries: PiSessionEntry[],
  childFiles: PiSessionEntry[][]
): TaskNotification[] {
  // Which (call id → agent id) pairs each file may speak for (review R3): the
  // parent's file for any agent of its tree (a root-owned notification can be
  // about a grandchild whose spawner had finished); a child's file only for
  // the agents that child itself launched. A child's word about any other
  // agent's terminal state counts for nothing.
  const linksOf = (entries: PiSessionEntry[]): Map<string, string> =>
    new Map(collectAgentIds(entries).map((l) => [l.toolUseId, l.agentId]))
  const tree = new Map<string, string>()
  for (const entries of [parentEntries, ...childFiles]) {
    for (const [toolUseId, agentId] of linksOf(entries)) tree.set(toolUseId, agentId)
  }
  const files = [
    { entries: parentEntries, trusted: tree },
    ...childFiles.map((entries) => ({ entries, trusted: linksOf(entries) }))
  ]
  const out: TaskNotification[] = []
  const notified = new Set<string>()
  const launches: Array<{ toolUseId: string; agentId: string }> = []
  for (const { entries, trusted } of files) {
    for (const e of entries) {
      if (e.type === 'custom_message') {
        const d = piAgentDeliveryDetails(e.customType, e.details)
        if (!d || d.kind !== 'task-notification') continue
        if (typeof d.agentId !== 'string' || typeof d.toolUseId !== 'string') continue
        if (trusted.get(d.toolUseId) !== d.agentId) continue
        if (!isTerminalStatus(d.status)) continue
        notified.add(d.toolUseId)
        out.push({
          taskId: d.agentId,
          toolUseId: d.toolUseId,
          status: d.status,
          outputFile: '',
          summary: typeof d.summary === 'string' ? d.summary : '',
          ...(d.usage ? { usage: d.usage } : {}),
          ...(typeof d.runIndex === 'number' ? { runIndex: d.runIndex } : {})
        })
      } else if (
        e.type === 'message' &&
        e.message.role === 'toolResult' &&
        e.message.toolName === 'agent'
      ) {
        const cui = (
          e.message.details as { cuiAgent?: { agentId?: unknown; background?: unknown } }
        )?.cuiAgent
        if (cui?.background === true && typeof cui.agentId === 'string') {
          launches.push({ toolUseId: e.message.toolCallId, agentId: cui.agentId })
        }
      }
    }
  }
  for (const launch of launches) {
    if (notified.has(launch.toolUseId)) continue
    out.push({
      taskId: launch.agentId,
      toolUseId: launch.toolUseId,
      status: 'unfinished',
      outputFile: '',
      summary: PI_UNFINISHED_SUMMARY,
      runIndex: 1
    })
  }
  return out
}

/** Every child id reachable from `entries` (all entries, every branch), children's children included. */
function reachableAgentIds(entries: PiSessionEntry[]): Set<string> {
  const ids = new Set<string>()
  const walk = (list: PiSessionEntry[], depth: number): void => {
    if (depth > MAX_SUBAGENT_HISTORY_DEPTH) return
    for (const link of collectAgentIds(list)) {
      if (ids.has(link.agentId)) continue
      ids.add(link.agentId)
      const file = childSessionFile(link.agentId)
      const parsed = file ? readPiSessionFile(file) : null
      if (parsed) walk(parsed.entries, depth + 1)
    }
  }
  walk(entries, 1)
  return ids
}

/**
 * Resolve the pi entryId (or clone-latest sentinel) to fork ("branch off")
 * from, given the fork message's INDEX in the store's `messages` array (the
 * store computes this — see session-store.ts's `forkFromMessage`). Pure-fs,
 * no live process needed (mirrors `loadPiSessionHistory`'s read path) —
 * reuses the EXACT same `activeBranchEntries` + `convertPiSessionEntries`
 * pipeline so the positional list here is guaranteed to be the same sequence
 * or the caller's `messages` array (both derived from the one converter).
 * Best-effort: any disk-read failure returns a null anchorUuid with a reason,
 * mirroring Claude's `resolveForkAnchor`'s failure contract.
 */
export function resolvePiForkAnchor(sessionId: string, messageIndex: number): ForkAnchorResult {
  const filePath = findPiSessionFile(sessionId)
  if (!filePath) return { anchorUuid: null, reason: 'transcript-not-found' }
  const parsed = readPiSessionFile(filePath)
  if (!parsed) return { anchorUuid: null, reason: 'read-failed' }
  const messages = convertPiSessionEntries(activeBranchEntries(parsed.entries))
  const anchorUuid = findPiForkAnchorEntryId(messages, messageIndex)
  return anchorUuid ? { anchorUuid } : { anchorUuid: null, reason: 'message-not-found' }
}

/**
 * Delete a pi session: unlink its .jsonl file and prune the parent
 * `--<mangled-cwd>--` dir if it's now empty. Best-effort: logs + swallows on
 * any error (mirrors deleteOpencodeSession) — never throws to the IPC layer.
 *
 * Its host-run subagent children (ADR-089) go with it — read from the parent
 * file FIRST, recursively through the child files — except a child another pi
 * session file still references (a fork or clone copies the parent's entries,
 * links included): those files are found by a substring prefilter on the ids,
 * then parsed to confirm, and everything they reach is kept.
 */
export async function deletePiSession(sessionId: string): Promise<void> {
  try {
    const filePath = findPiSessionFile(sessionId)
    if (!filePath) return
    const parsed = readPiSessionFile(filePath)
    const children = parsed ? reachableAgentIds(parsed.entries) : new Set<string>()
    if (children.size > 0) {
      const kept = new Set<string>()
      for (const other of walkAllSessionFiles()) {
        if (other === filePath) continue
        let raw: string
        try {
          raw = fs.readFileSync(other, 'utf-8')
        } catch {
          continue
        }
        if (![...children].some((id) => raw.includes(id))) continue
        const otherParsed = readPiSessionFile(other)
        if (!otherParsed) continue
        for (const id of reachableAgentIds(otherParsed.entries)) kept.add(id)
      }
      for (const id of children) {
        if (!kept.has(id)) await deleteChildSession(id)
      }
    }
    await fs.promises.unlink(filePath)
    const dir = path.dirname(filePath)
    try {
      const remaining = await fs.promises.readdir(dir)
      if (remaining.length === 0) await fs.promises.rmdir(dir)
    } catch {
      // Best-effort prune — a non-empty or already-gone dir is not an error.
    }
  } catch (err) {
    logger.debug(
      'PiSessionList',
      `deletePiSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
