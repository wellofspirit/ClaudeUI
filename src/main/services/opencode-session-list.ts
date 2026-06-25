/**
 * opencode-session-list.ts
 *
 * Builds the sidebar's opencode session list, and loads a session's transcript.
 *
 * opencode persists every session (all cwds) in one global SQLite DB
 * (~/.local/share/opencode/opencode.db). Its HTTP `GET /session` is PROJECT-scoped
 * (only the serve-cwd's git-root — verified), so we enumerate the LIST by reading
 * that DB directly, read-only (it's in WAL mode → no contention with opencode's
 * writes; see db.ts `readOpencodeSessionRows`). HISTORY (on resume / sidebar click)
 * uses opencode's HTTP API, which IS global-by-id.
 *
 * Best-effort throughout: any error (opencode not installed, DB absent, server down)
 * returns an empty array — it NEVER throws and NEVER breaks the Claude sidebar list.
 *
 * Spec: docs/v2/followup-opencode-session-persistence.md §3b (revised: direct-DB list)
 */

import os from 'os'
import path from 'path'
import fs from 'fs'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { convertStoredMessage } from '../opencode/event-mapper'
import { readOpencodeSessionRows } from './db'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { logger } from './logger'
import type { ChatMessage, SessionInfo } from '../../shared/types'

/**
 * Resolve the path to opencode's global session DB. Mirrors opencode's own
 * resolution (packages/core/src/global.ts + database/database.ts): the data dir
 * is `$XDG_DATA_HOME/opencode` (falling back to `~/.local/share/opencode` — opencode
 * uses XDG paths even on Windows), and the file is `opencode.db` for the default/prod
 * channel (or `opencode-<channel>.db` otherwise). `OPENCODE_DB` overrides the filename
 * (absolute path used as-is). We pick `opencode.db` first, then the most-recent
 * `opencode*.db` as a channel fallback.
 */
function resolveOpencodeDbPath(): string {
  const flag = process.env.OPENCODE_DB
  if (flag && (path.isAbsolute(flag) || flag === ':memory:')) return flag
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const dir = path.join(dataHome, 'opencode')
  const preferred = path.join(dir, flag || 'opencode.db')
  if (fs.existsSync(preferred)) return preferred
  // Channel fallback: newest opencode*.db in the data dir.
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => /^opencode.*\.db$/.test(f))
      .map((f) => path.join(dir, f))
    if (candidates.length > 0) {
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      return candidates[0]
    }
  } catch {
    /* dir missing → opencode not installed */
  }
  return preferred
}

/**
 * Derive a projectKey from a cwd path — same heuristic as Claude JSONL
 * (encodes the path so it's safe as a filesystem key). We use the cwd
 * itself as the key for opencode sessions since there are no project dirs.
 */
function cwdToProjectKey(cwd: string): string {
  // Mirror Claude's session-history.ts normalization: use the cwd as-is,
  // forward-slashing so the renderer's cwd-based grouping is cross-platform.
  return cwd.replace(/\\/g, '/')
}

/**
 * List ALL opencode sessions (across every cwd) for the sidebar, mapped to
 * SessionInfo[].
 *
 * Sourced by a direct READ-ONLY query on opencode's own global session DB. We do
 * NOT use opencode's HTTP `GET /session` here because it is PROJECT-scoped (it
 * returns only the serve-cwd's git-root sessions), so a single shared server can't
 * enumerate every cwd. opencode runs the DB in WAL mode, so our read-only snapshot
 * never blocks opencode's writes. No server spawn needed. (History replay on resume
 * still uses the HTTP API — `loadOpencodeSessionHistory` — which IS global-by-id.)
 *
 * Best-effort: any error (opencode not installed, file absent, schema drift) → [].
 *
 * @returns Array of SessionInfo with engineId:'opencode', newest first.
 */
export async function listOpencodeSessionsGlobal(): Promise<SessionInfo[]> {
  // Async signature kept for the IPC contract (and future-proofing); the read is sync.
  const rows = readOpencodeSessionRows(resolveOpencodeDbPath())
  const result: SessionInfo[] = []
  for (const row of rows) {
    const cwd = row.directory
    if (!cwd) continue
    const timestamp = row.timeUpdated ?? row.timeCreated ?? 0
    result.push({
      sessionId: row.id,
      cwd,
      projectKey: cwdToProjectKey(cwd),
      title: row.title?.trim() || 'Untitled',
      timestamp,
      lastActivityAt: timestamp,
      aiTitle: null,
      engineId: 'opencode'
    })
  }
  // Newest first (the query already orders DESC, but re-sort defensively).
  result.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return result
}

/**
 * Load a persisted opencode session's transcript as ChatMessage[], so the chat
 * view can paint the prior conversation immediately when the user clicks the
 * session in the sidebar (parity with Claude's JSONL load — no waiting for the
 * first new prompt).
 *
 * Read-only: uses the shared server at PERSISTED_SESSIONS_DIR. opencode's message
 * store is keyed by session id globally (the query filters by session_id, not
 * directory), so the shared server can read any session's messages regardless of
 * its cwd — no per-cwd spawn needed.
 *
 * Reuses `convertStoredMessage` (the same part→block mapping as live turns and the
 * OpencodeSession resume replay) so there's a single rendering path.
 *
 * Best-effort: returns [] on any error.
 */
export async function loadOpencodeSessionHistory(sessionId: string): Promise<ChatMessage[]> {
  let acquired = false
  try {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    acquired = true
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    const stored = await client.listMessages(sessionId)
    const messages: ChatMessage[] = []
    for (const s of stored) {
      const msg = convertStoredMessage(s)
      if (msg) messages.push(msg)
    }
    return messages
  } catch (err) {
    logger.debug(
      'OpencodeSessionList',
      `loadOpencodeSessionHistory(${sessionId}) skipped: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  } finally {
    if (acquired) {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }
}
