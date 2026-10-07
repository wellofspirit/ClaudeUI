/**
 * opencode-session-list.ts
 *
 * Builds the sidebar's opencode session list, and loads a session's transcript.
 *
 * Everything goes through opencode's own API (ADR-097 §6, S9). 2.x's
 * `GET /api/session` is GLOBAL — every directory the shared DB knows; the
 * `directory` query narrows it — so the list is one paged
 * `GET /api/session?parentID=null` (root sessions; children are a parent's
 * subagents). A DB created by 2.x has only `session_v2`, so the 1.x direct
 * SQLite read is gone.
 *
 * The API needs a running server, and the sidebar must never wait for one or
 * start one per render. So the list is served from the LAST listing, at once
 * (all server I/O runs asynchronously in main, off the render path), and
 * refreshed in the background ({@link refreshOpencodeSessionList}), one
 * refresh in flight at a time (concurrent triggers share it), at most every
 * {@link REFRESH_MIN_INTERVAL_MS}. A refresh that changed the list tells its
 * listeners (the canonical directory refresh), so the sidebar gets ONE update
 * when it lands.
 *
 * When a refresh may START a server — the `onInteraction` policy (owner
 * decision 2026-10-07): for the first listing of the process; afterwards only
 * on an INTERACTION (the sidebar opened, the app focused — the renderer's
 * `session:list-opencode` call) when the listing is older than
 * {@link STALE_LISTING_MS}. Every other refresh only rides a server that is
 * already running — ANY live one (the list routes are global), so a project
 * whose config differs never costs a second server. A failed start or read
 * backs off exponentially (from {@link REFRESH_MIN_INTERVAL_MS} up to
 * {@link MAX_BACKOFF_MS}). opencode not installed → [] and no server, ever.
 * Dispatch targets and ClaudeUI's throwaway sessions are not listed.
 *
 * Best-effort throughout: an error keeps the last listing; nothing here throws
 * to the IPC layer or breaks the Claude sidebar list.
 */

import { opencodeServerManager, type ServerConnection } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import type { Session_Info } from '../opencode/protocol-v2/openapi'
import { convertOpencodeHistory, readOpencodeHistory } from '../opencode/v2-history'
import { lastOpencodeV2Model, opencodeV2HistoryStatusLine } from '../opencode/history-status-line'
import { READ_LINGER_MS } from '../opencode/read-linger'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { dispatchedCostEntriesFor } from './dispatched-cost-entries'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { logger } from './logger'
import { cwdToProjectKey } from '../../shared/project-key'
import { HIDDEN_OPENCODE_SESSION_TITLES } from '../../shared/dispatch-session'
import type { EngineHistoryLoad, ModelRef, SessionInfo } from '../../shared/types'

/**
 * opencode stamps newly-created sessions with a default placeholder title
 * ("New session - <ISO>" / "Child session - <ISO>"; 2.x may also leave it
 * unset) and only replaces it once its async title generation completes.
 * Mirror opencode's own fallback test so the sidebar shows "Untitled" in that
 * window instead of the raw ISO string.
 */
const OPENCODE_DEFAULT_TITLE_RE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function displayTitle(raw: string | null | undefined): string {
  const t = raw?.trim()
  if (!t || OPENCODE_DEFAULT_TITLE_RE.test(t)) return 'Untitled'
  return t
}

/** Least time between two refreshes of the list. */
export const REFRESH_MIN_INTERVAL_MS = 20_000
/** An interaction may start a server only for a listing at least this old. */
export const STALE_LISTING_MS = 5 * 60_000
/** The longest a failing refresh waits before the next try. */
export const MAX_BACKOFF_MS = 30 * 60_000

/** What asked for a refresh. */
export type ListRefreshTrigger =
  /** A poll, a watcher tick: rides a running server, starts one only for the first listing. */
  | 'background'
  /** The sidebar opened or the app came to the front: may start a server for a stale listing. */
  | 'interaction'
  /** The usage reconciler: rides a running server only, never starts one. */
  | 'reconcile'

/** Where list/history/delete leases are taken (any directory works: the routes are global). */
const LIST_LEASE = { waitForHostedTools: false, lingerMs: READ_LINGER_MS } as const

/** ClaudeUI's own sessions — dispatch targets and throwaways — never listed. */
const HIDDEN_TITLES: ReadonlySet<string> = new Set(HIDDEN_OPENCODE_SESSION_TITLES)

/**
 * A read lease on any running server, else (a user-initiated read: history,
 * delete) one started for it.
 */
async function readLease(): Promise<ServerConnection> {
  return (
    (await opencodeServerManager.acquireIfRunning(PERSISTED_SESSIONS_DIR, {
      ...LIST_LEASE,
      anyConfig: true
    })) ?? (await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, LIST_LEASE))
  )
}

/** 2.x sessions → the sidebar's SessionInfo[] (archived ones left out), newest first. */
export function toOpencodeSessionInfos(sessions: readonly Session_Info[]): SessionInfo[] {
  const result: SessionInfo[] = []
  for (const session of sessions) {
    const cwd = session.location?.directory
    if (!cwd || session.time.archived !== undefined) continue
    if (session.title && HIDDEN_TITLES.has(session.title.trim())) continue
    const timestamp = session.time.updated ?? session.time.created ?? 0
    result.push({
      sessionId: session.id,
      cwd,
      projectKey: cwdToProjectKey(cwd),
      title: displayTitle(session.title),
      timestamp,
      lastActivityAt: timestamp,
      aiTitle: null,
      engineId: 'opencode'
    })
  }
  result.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return result
}

/**
 * Every root session the server knows (`GET /api/session?parentID=null`,
 * paged), or only those located in `directory`.
 */
export async function readOpencodeSessions(
  client: Pick<OpencodeClient, 'listSessions'>,
  directory?: string
): Promise<SessionInfo[]> {
  const sessions = await client.listSessions({
    parentID: 'null',
    ...(directory ? { directory } : {})
  })
  return toOpencodeSessionInfos(sessions)
}

// ── The cached listing ───────────────────────────────────────────────────────

let cache: { sessions: SessionInfo[]; at: number } | null = null
let refreshing: Promise<SessionInfo[] | null> | null = null
let lastAttemptAt = 0
let failures = 0
let backoffUntil = 0
const listeners = new Set<() => void>()

/** Be told when a refresh changed the list. Returns the unsubscribe. */
export function onOpencodeSessionListChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Replace the cached listing (read at `at`) and tell the listeners when it changed. */
function publish(sessions: SessionInfo[], at = Date.now()): void {
  const changed = JSON.stringify(cache?.sessions ?? []) !== JSON.stringify(sessions)
  cache = { sessions, at }
  if (!changed) return
  for (const cb of [...listeners]) {
    try {
      cb()
    } catch (err) {
      logger.warn('OpencodeSessionList', `list listener threw: ${String(err)}`)
    }
  }
}

/**
 * Refresh the cached listing: one at a time (a trigger while one is in flight
 * shares it), at most every {@link REFRESH_MIN_INTERVAL_MS} (the reconciler's
 * excepted), never inside a failure back-off. Resolves with the new listing,
 * or null when nothing was read (throttled, backing off, no server to ride,
 * not installed, an error — the last listing stays). Whether it may START a
 * server: see the file header.
 */
export function refreshOpencodeSessionList(
  trigger: ListRefreshTrigger = 'background'
): Promise<SessionInfo[] | null> {
  if (refreshing) return refreshing
  if (!opencodeServerManager.isBinaryAvailable()) {
    if (cache) publish([])
    cache = null
    return Promise.resolve(null)
  }
  const now = Date.now()
  if (now < backoffUntil) return Promise.resolve(null)
  if (trigger !== 'reconcile' && now - lastAttemptAt < REFRESH_MIN_INTERVAL_MS)
    return Promise.resolve(null)
  lastAttemptAt = now
  const mayStart =
    trigger !== 'reconcile' &&
    (!cache || (trigger === 'interaction' && now - cache.at >= STALE_LISTING_MS))
  const run = (async (): Promise<SessionInfo[] | null> => {
    let conn: ServerConnection | null = null
    try {
      conn = await opencodeServerManager.acquireIfRunning(PERSISTED_SESSIONS_DIR, {
        ...LIST_LEASE,
        anyConfig: true
      })
      if (!conn && mayStart)
        conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, LIST_LEASE)
      if (!conn) return null
      const sessions = await readOpencodeSessions(new OpencodeClient(conn))
      failures = 0
      backoffUntil = 0
      publish(sessions)
      return sessions
    } catch (err) {
      failures++
      backoffUntil = Date.now() + Math.min(REFRESH_MIN_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS)
      logger.debug(
        'OpencodeSessionList',
        `opencode session list not refreshed (keeping the last one; next try in ${Math.round((backoffUntil - Date.now()) / 1000)} s): ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    } finally {
      if (conn) opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
    }
  })()
  refreshing = run.finally(() => {
    refreshing = null
  })
  return refreshing
}

/**
 * The sidebar's list of ALL opencode sessions (every cwd): the last listing,
 * at once — never waits for a server, whatever the refresh does — with a
 * refresh kicked in the background. `interaction`: the caller is the sidebar
 * opening or the app coming to the front (may start a server for a stale
 * listing). [] until the first listing lands, and when opencode is not
 * installed.
 *
 * @returns Array of SessionInfo with engineId:'opencode', newest first.
 */
export async function listOpencodeSessionsGlobal(
  options: { interaction?: boolean } = {}
): Promise<SessionInfo[]> {
  if (!opencodeServerManager.isBinaryAvailable()) {
    cache = null
    return []
  }
  void refreshOpencodeSessionList(options.interaction ? 'interaction' : 'background')
  return cache?.sessions ?? []
}

/**
 * For the usage reconciler: the listing read now when a server is running,
 * else the last one — it never starts a server.
 */
export async function listOpencodeSessionsForReconcile(): Promise<SessionInfo[]> {
  if (!opencodeServerManager.isBinaryAvailable()) return []
  return (await refreshOpencodeSessionList('reconcile')) ?? cache?.sessions ?? []
}

/** Test seam: let the next refresh run now (the throttle forgotten, nothing else). */
export function __resetOpencodeSessionListThrottleForTests(): void {
  lastAttemptAt = 0
}

/** Test seam: forget the cached listing, the throttle and the listeners. */
export function __resetOpencodeSessionListForTests(): void {
  cache = null
  refreshing = null
  lastAttemptAt = 0
  failures = 0
  backoffUntil = 0
  listeners.clear()
}

/**
 * Load a persisted opencode session's transcript, so the chat view can paint
 * the prior conversation immediately when the user clicks the session in the
 * sidebar (parity with Claude's JSONL load — no waiting for the first new
 * prompt), AND the status line that goes with it: the same stored messages
 * carry the cost, tokens, duration and context the top bar reports (S1d).
 *
 * Read-only: a lingering read lease (any directory works — the message routes
 * are global by session id), so a burst of history loads reuses one server.
 *
 * Reuses `convertOpencodeHistory` (the 2.x cold converter, held to parity with
 * the live mapper — ADR-097 S4) so there's a single rendering path, children's
 * transcripts included (`subagentMessages`, `taskNotifications`), and
 * `opencodeV2HistoryStatusLine` (the same reconstruction the session's own
 * resume seeding runs) so the cold figure and the live one agree.
 *
 * Best-effort: returns no messages and a null status line on any error.
 */
export async function loadOpencodeSessionHistory(sessionId: string): Promise<EngineHistoryLoad> {
  let conn: ServerConnection | null = null
  try {
    // A read — no turn, so no wait for the hosted MCP tools; the server lingers
    // for the next read.
    conn = await readLease()
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
    if (conn) opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
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
  let conn: ServerConnection | null = null
  try {
    conn = await readLease()
    await new OpencodeClient(conn).deleteSession(sessionId)
    // Gone from the sidebar at once, not at the next refresh.
    if (cache?.sessions.some((session) => session.sessionId === sessionId))
      publish(
        cache.sessions.filter((session) => session.sessionId !== sessionId),
        cache.at
      )
  } catch (err) {
    logger.debug(
      'OpencodeSessionList',
      `deleteOpencodeSession(${sessionId}) skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    if (conn) opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
  }
}
