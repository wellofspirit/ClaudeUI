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
 */

import os from 'os'
import path from 'path'
import fs from 'fs'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { convertOpencodeHistory, readOpencodeHistory } from '../opencode/v2-history'
import { lastOpencodeV2Model, opencodeV2HistoryStatusLine } from '../opencode/history-status-line'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { dispatchedCostEntriesFor } from './dispatched-cost-entries'
import { readOpencodeSessionRows } from './db'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { logger } from './logger'
import { cwdToProjectKey } from '../../shared/project-key'
import type { EngineHistoryLoad, ModelRef, SessionInfo } from '../../shared/types'

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
 * opencode stamps newly-created sessions with a default placeholder title
 * ("New session - <ISO>" / "Child session - <ISO>") and only replaces it once its
 * async LLM title generation completes (SessionPrompt.ensureTitle). Mirror
 * opencode's own `isDefaultTitle` so we can hide that placeholder in the sidebar
 * during the brief window before a real title lands — otherwise the raw ISO
 * string would flash in the session list.
 */
const OPENCODE_DEFAULT_TITLE_RE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function displayTitle(raw: string | null | undefined): string {
  const t = raw?.trim()
  if (!t || OPENCODE_DEFAULT_TITLE_RE.test(t)) return 'Untitled'
  return t
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
  // TODO(S9): a DB created by opencode 2.x has no `session` table (only
  // `session_v2`), and a migrated 1.x DB keeps a stale v1 copy. ADR-093 §6
  // moves this to the API: `OpencodeClient.listSessions({ parentID: 'null' })`
  // (GET /api/session is GLOBAL in 2.x, unlike 1.x's project scope) — S9 owns
  // the switch and when the sidebar may start a server for it.
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
      title: displayTitle(row.title),
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
 * Load a persisted opencode session's transcript, so the chat view can paint
 * the prior conversation immediately when the user clicks the session in the
 * sidebar (parity with Claude's JSONL load — no waiting for the first new
 * prompt), AND the status line that goes with it: the same stored messages
 * carry the cost, tokens, duration and context the top bar reports (S1d).
 *
 * Read-only: uses the shared server at PERSISTED_SESSIONS_DIR. opencode's message
 * store is keyed by session id globally (the query filters by session_id, not
 * directory), so the shared server can read any session's messages regardless of
 * its cwd — no per-cwd spawn needed.
 *
 * Reuses `convertOpencodeHistory` (the 2.x cold converter, held to parity with
 * the live mapper — ADR-093 S4) so there's a single rendering path, children's
 * transcripts included (`subagentMessages`, `taskNotifications`), and
 * `opencodeV2HistoryStatusLine` (the same reconstruction the session's own
 * resume seeding runs) so the cold figure and the live one agree.
 *
 * Best-effort: returns no messages and a null status line on any error.
 */
export async function loadOpencodeSessionHistory(sessionId: string): Promise<EngineHistoryLoad> {
  let acquired = false
  try {
    // A read — no turn, so no wait for the hosted MCP tools.
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, {
      waitForHostedTools: false
    })
    acquired = true
    const client = new OpencodeClient(conn)
    const { rows: stored, children } = await readOpencodeHistory(
      (id) => client.listMessages(id),
      sessionId
    )
    const history = convertOpencodeHistory(stored, children)
    // The billing type decides what this history was WORTH (ADR-071 §2) and it
    // comes from the auth probe's cache, which is empty in a process that has
    // not opened an opencode session yet. Warm it FIRST, and never let a probe
    // failure cost the user their transcript — an unwarmed vendor simply reads
    // as `unknown`, which prices the history at its list-price equivalent.
    await opencodeAuthProvider.warmCache().catch(() => {})
    const last = lastOpencodeV2Model(stored)
    // The session's cumulative carries what no row does (title generation); a
    // failed read just leaves that remainder out.
    const session = await Promise.resolve()
      .then(() => client.getSession(sessionId))
      .catch(() => null)
    const statusLine =
      stored.length > 0
        ? opencodeV2HistoryStatusLine(stored, last, dispatchedCostEntriesFor(sessionId), {
            children: children.values(),
            ...(session ? { sessionTotals: { cost: session.cost, tokens: session.tokens } } : {})
          })
        : null
    // The same last-assistant model the pricing uses, in ModelRef form: a
    // session opencode created on its own has no model persisted here, and the
    // transcript is the only place it is written down. Either id empty means
    // there is nothing to seed — the picker value is `vendorId/modelId`, and a
    // half-formed one would name no model at all.
    const lastModel: ModelRef | null =
      last.providerID && last.modelID
        ? { engineId: 'opencode', vendorId: last.providerID, modelId: last.modelID }
        : null
    return {
      messages: history.messages,
      statusLine,
      lastModel,
      ...(Object.keys(history.subagentMessages).length > 0
        ? { subagentMessages: history.subagentMessages }
        : {}),
      ...(history.taskNotifications.length > 0
        ? { taskNotifications: history.taskNotifications }
        : {})
    }
  } catch (err) {
    logger.debug(
      'OpencodeSessionList',
      `loadOpencodeSessionHistory(${sessionId}) skipped: ${err instanceof Error ? err.message : String(err)}`
    )
    return { messages: [], statusLine: null }
  } finally {
    if (acquired) {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }
}

/**
 * Delete an opencode session via the shared HTTP server
 * (`DELETE /api/session/{id}`).
 *
 * The delete endpoint is global-by-id — the sessionId is sufficient, no cwd
 * needed (the request's directory is the shared server's own lease, which
 * does not scope it). Mirrors the acquire/release pattern of
 * loadOpencodeSessionHistory.
 *
 * Best-effort: logs + swallows on any error (server may be down). Never throws
 * to the IPC layer.
 */
export async function deleteOpencodeSession(sessionId: string): Promise<void> {
  let acquired = false
  try {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, {
      waitForHostedTools: false
    })
    acquired = true
    await new OpencodeClient(conn).deleteSession(sessionId)
  } catch (err) {
    logger.debug(
      'OpencodeSessionList',
      `deleteOpencodeSession(${sessionId}) skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    if (acquired) {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }
}
