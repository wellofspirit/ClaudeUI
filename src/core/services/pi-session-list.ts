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
import type { ChatMessage, ContentBlock, ForkAnchorResult, SessionInfo } from '../../shared/types'
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
import { findPiForkAnchorEntryId } from './fork-anchor'
import { logger } from './logger'

/** `~/.pi/agent` — pi's own data root. */
export function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

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
      blocks.push({ type: 'image', mediaType: b.mimeType, base64Data: b.data })
    }
    // Unrecognised mime types are dropped — see IMAGE_MEDIA_TYPES.
  }
  return blocks
}

/**
 * Convert a whole active-branch entry list to ChatMessage[], in order.
 * Two passes: (1) index every toolResult message by toolCallId, (2) convert
 * `message`/`compaction` entries (everything else — model_change,
 * thinking_level_change, branch_summary, label, custom, custom_message — is
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
        content: [{ type: 'compact_separator', text: firstLine(e.summary) }],
        timestamp: Number.isFinite(ts) ? ts : Date.now()
      })
    }
  }
  return messages
}

/**
 * Load a persisted pi session's transcript as ChatMessage[], so the chat view
 * can paint the prior conversation immediately on sidebar click (parity with
 * Claude's JSONL load) and PiSession's resume replay can reuse the exact same
 * pipeline. Best-effort: returns [] on any error (file not found, corrupt, unreadable).
 */
export async function loadPiSessionHistory(sessionId: string): Promise<ChatMessage[]> {
  try {
    const filePath = findPiSessionFile(sessionId)
    if (!filePath) return []
    const parsed = readPiSessionFile(filePath)
    if (!parsed) return []
    const active = activeBranchEntries(parsed.entries)
    return convertPiSessionEntries(active)
  } catch (err) {
    logger.debug(
      'PiSessionList',
      `loadPiSessionHistory(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
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
 */
export async function deletePiSession(sessionId: string): Promise<void> {
  try {
    const filePath = findPiSessionFile(sessionId)
    if (!filePath) return
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
