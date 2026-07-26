/**
 * Operational SQLite database — Phase 3a.
 *
 * Single per-OS-user DB at ~/.claude/ui/operational.db.
 * This is the ONLY file in the codebase that imports better-sqlite3.
 * All callers must go through the typed repository API below — never the raw db.
 *
 * Isolation: vitest aliases better-sqlite3 to a node:sqlite-backed shim so
 * tests never load the Electron-ABI native .node binary.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import BetterSqlite3 from 'better-sqlite3'
import type { EngineId, ModelRef, AccountInfo, DispatchedUsageSummary } from '../../shared/types'
import { engineMeta } from '../../shared/engine-meta'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Metering types (Phase 7 — Pass 1)
// ---------------------------------------------------------------------------

/** One recorded usage turn. source 'live' = recorded as it happened; 'backfill' = reconciler. */
export interface UsageEventRow {
  id: string
  ts: number
  engineId: string
  vendorId: string
  accountId: string | null
  accountUuid: string | null
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  equivCostUsd: number | null
  engineCostUsd: number | null
  sessionId: string | null
  messageId: string
  source: 'live' | 'backfill'
}

/** One window-utilization sample (feeds WLS apiPercent series + block alignment). */
export interface WindowSampleRow {
  id: string
  ts: number
  accountUuid: string
  usedPercent: number
  canonicalEnd: number
}

/** One per-day per-model usage rollup row (the durable 30-day-chart store). */
export interface DailyUsageRow {
  date: string
  engineId: string
  vendorId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUsd: number
  requestCount: number
  peakApiPercent: number
  source: 'rollup' | 'seed'
}

// Infer the Database instance type from the constructor return so we don't
// need the `BetterSqlite3.Database` namespace (not available with `export =`).
export type Db = ReturnType<typeof BetterSqlite3>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  engineId: EngineId
  model?: ModelRef
}

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'ui')
const DB_PATH = path.join(CONFIG_DIR, 'operational.db')

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** A schema migration: an ordered `up` step applied when its version exceeds user_version. */
export interface Migration {
  version: number
  up: (db: Db) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          session_id TEXT PRIMARY KEY,
          engine_id  TEXT NOT NULL,
          vendor_id  TEXT,
          model_id   TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // v2 — Phase 4: account metadata (AccountInfo) migrated from accounts.json.
    // Credentials NEVER enter the DB (ADR-015). enabled/activeId pointer stays
    // in accounts.json (simplest: avoids a DB query on every spawn-env resolve).
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS account (
          id                TEXT PRIMARY KEY,
          email             TEXT,
          subscription_type TEXT,
          organization      TEXT,
          created_at        INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // v3 — Phase 7 Pass 1: live usage_event recorder.
    //
    // UNIQUE(message_id) is the dedup key — INSERT … ON CONFLICT DO NOTHING
    // ensures live turns and the Pass-2 reconciler never double-count the same
    // turn even when both paths observe it.
    //
    // Indexes:
    //   (ts, engine_id) — time-range queries per engine (dashboard blocks)
    //   (session_id)    — per-session aggregation (MeteringSnapshot in Pass 2)
    //   (account_uuid, ts) — per-account window queries (WLS + blocks)
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_event (
          id                   TEXT PRIMARY KEY,
          ts                   INTEGER NOT NULL,
          engine_id            TEXT NOT NULL,
          vendor_id            TEXT NOT NULL,
          account_id           TEXT,
          account_uuid         TEXT,
          model_id             TEXT NOT NULL,
          input_tokens         INTEGER NOT NULL DEFAULT 0,
          output_tokens        INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
          equiv_cost_usd       REAL,
          engine_cost_usd      REAL,
          session_id           TEXT,
          message_id           TEXT NOT NULL,
          source               TEXT NOT NULL DEFAULT 'live',
          UNIQUE(message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_event_ts_engine
          ON usage_event(ts, engine_id);
        CREATE INDEX IF NOT EXISTS idx_usage_event_session
          ON usage_event(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_event_account_ts
          ON usage_event(account_uuid, ts);
      `)
    }
  },
  {
    // v4 — Phase 7 Pass 1: window-utilization samples for WLS / block alignment.
    // Each sample is one observation of a 5h rate-limit window (account_uuid + ts +
    // used_percent + the canonical window end). Index on (account_uuid, ts) for
    // the WLS regression over the ring buffer.
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_window_sample (
          id            TEXT PRIMARY KEY,
          ts            INTEGER NOT NULL,
          account_uuid  TEXT NOT NULL,
          used_percent  REAL NOT NULL,
          canonical_end INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_window_sample_account_ts
          ON usage_window_sample(account_uuid, ts);
      `)
    }
  },
  {
    // v5 — Phase 7 Pass 2 (Full SQL): per-day usage rollup for the 30-day chart.
    //
    // The daily chart's history must survive past the 7-day usage_event window
    // (usage_event only holds ~7d of reconciled JSONL + live turns), so daily_usage
    // is a durable rollup keyed by (date, engine_id, vendor_id, model_id). Recent
    // days are recomputed from usage_event on each reconcile (REPLACE); older days
    // are seeded once from the legacy daily JSON files and never recomputed (their
    // JSONL is gone). peak_api_percent + request_count are carried for the chart.
    //
    // `cost_usd` stores block-usage's calculateCostFromTokens value (engine cost)
    // so the daily chart's $ matches the historical entry-derived totals exactly.
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_usage (
          date              TEXT NOT NULL,
          engine_id         TEXT NOT NULL,
          vendor_id         TEXT NOT NULL,
          model_id          TEXT NOT NULL,
          input_tokens      INTEGER NOT NULL DEFAULT 0,
          output_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd          REAL NOT NULL DEFAULT 0,
          request_count     INTEGER NOT NULL DEFAULT 0,
          peak_api_percent  REAL NOT NULL DEFAULT 0,
          source            TEXT NOT NULL DEFAULT 'rollup',
          PRIMARY KEY (date, engine_id, vendor_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
      `)
    }
  },
  {
    // v6 — ADR-033 M4-B: one row per completed/failed dispatched-agent turn,
    // attributed to the DISPATCHING session (from_routing_id). Dispatched
    // turns never flow through a normal persisted session (Claude targets run
    // persistSession:false — no transcript; opencode targets are throwaway
    // sessions deleted after use), so ADR-011's JSONL-scanning analytics
    // (block-usage.ts) can never see them — this table is the explicit,
    // additive capture the plan calls for. No FK to session_meta: the
    // dispatching session may be a headless/remote routingId not otherwise
    // tracked, and dispatched_usage must outlive session deletion.
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatched_usage (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ts              INTEGER NOT NULL,
          from_routing_id TEXT NOT NULL,
          from_engine     TEXT NOT NULL,
          target_engine   TEXT NOT NULL,
          target_model    TEXT NOT NULL,
          target_session_id TEXT,
          tool_use_id     TEXT,
          total_tokens    INTEGER,
          cost_usd        REAL,
          duration_ms     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_dispatched_usage_ts
          ON dispatched_usage(ts);
        CREATE INDEX IF NOT EXISTS idx_dispatched_usage_from_routing
          ON dispatched_usage(from_routing_id);
      `)
    }
  }
]

/**
 * Apply all migrations above the DB's current `user_version`, in version order,
 * bumping `user_version` after each. Re-running is a no-op once the DB is at the
 * latest version. Pure in `(db, migrations)` — exported so the version guard can
 * be tested directly against a controlled migration list.
 */
export function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): void {
  // user_version is an integer stored in the SQLite header (no table needed).
  const currentVersion = (db.pragma('user_version', { simple: true }) as number | null) ?? 0

  // Downgrade guard: an OLDER binary opening a DB that a NEWER build already
  // migrated forward sees a user_version above everything it knows about. Do NOT
  // run or rewind anything — warn and proceed read-forward. SQLite tolerates
  // unknown extra tables/columns, so most reads still work; forcing a rewind (or
  // throwing) would brick the app for a user who merely downgraded.
  const latestVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0)
  if (currentVersion > latestVersion) {
    logger.warn(
      'DB',
      `operational.db user_version ${currentVersion} is newer than this build supports ` +
        `(max ${latestVersion}); it was likely created by a newer ClaudeUI. Proceeding ` +
        `without migrating — schema mismatches may cause errors.`
    )
    return
  }

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version)
  if (pending.length === 0) return

  // Each migration's `up` + its user_version bump run inside ONE transaction so a
  // mid-migration failure (e.g. a future ALTER TABLE that half-applies) rolls
  // back BOTH the partial DDL and the version bump. The DB then reopens at the
  // last good version and retries, instead of being left at a half-applied
  // schema that is permanently unopenable. SQLite DDL and `PRAGMA user_version`
  // are both transactional (rolled back on ROLLBACK). Manual BEGIN/COMMIT (not
  // db.transaction()) matches the existing bulk-write pattern in this file and
  // the node:sqlite test stub, which does not implement db.transaction().
  for (const migration of pending) {
    db.prepare('BEGIN').run()
    try {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
      db.prepare('COMMIT').run()
    } catch (err) {
      db.prepare('ROLLBACK').run()
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Db | null = null

/**
 * Open (or return the cached) operational DB.
 * Creates ~/.claude/ui/ if it doesn't exist.
 * Sets WAL mode + foreign keys, then runs any pending migrations.
 */
function getDb(): Db {
  if (_db) return _db

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }

  const db = new BetterSqlite3(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  // Publish the singleton BEFORE pruning so pruneUsageTables()'s own getDb()
  // resolves to this instance (no re-open / recursion).
  _db = db

  // Bounded periodic prune (M-DB3): once per process open, off the hot insert
  // path. Best-effort — a prune failure must never prevent the DB from opening.
  try {
    pruneUsageTables()
  } catch (err) {
    logger.warn('DB', `usage-table prune on open failed (non-fatal): ${err}`)
  }

  return _db
}

/**
 * Close the DB and reset the singleton. Primarily for test teardown.
 */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ---------------------------------------------------------------------------
// Foreign read: opencode's own session DB
// ---------------------------------------------------------------------------
//
// opencode persists every session (across all cwds) in a single global SQLite DB
// (~/.local/share/opencode/opencode.db). Its HTTP `GET /session` is PROJECT-scoped
// (only the serve-cwd's git-root), so to enumerate ALL opencode sessions for the
// sidebar we read that DB directly — one cheap query, every cwd. opencode runs it
// in WAL mode, so a read-only connection never blocks opencode's writes and sees a
// consistent snapshot. We open read-only, never write. This lives in db.ts to keep
// better-sqlite3 to a single importer (ADR-020 / the native-ABI invariant).

/** A top-level opencode session row (the subset the sidebar needs). */
export interface OpencodeSessionRow {
  id: string
  directory: string
  title: string
  timeCreated: number | null
  timeUpdated: number | null
}

/**
 * Read top-level, non-archived opencode sessions from opencode's own DB.
 * Best-effort + read-only: returns [] if the file is absent or any error occurs
 * (e.g. opencode not installed, schema drift on an opencode upgrade) — never throws.
 */
export function readOpencodeSessionRows(opencodeDbPath: string): OpencodeSessionRow[] {
  let foreign: Db | null = null
  try {
    foreign = new BetterSqlite3(opencodeDbPath, { readonly: true, fileMustExist: true })
    foreign.pragma('busy_timeout = 3000')
    const rows = foreign
      .prepare(
        `SELECT id, directory, title, time_created AS timeCreated, time_updated AS timeUpdated
         FROM session
         WHERE parent_id IS NULL AND time_archived IS NULL
         ORDER BY time_updated DESC`
      )
      .all() as OpencodeSessionRow[]
    return rows
  } catch {
    // Absent file / locked / schema drift → degrade to empty (sidebar shows none).
    return []
  } finally {
    try {
      foreign?.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Row ↔ SessionMeta mapping
// ---------------------------------------------------------------------------

interface SessionMetaRow {
  session_id: string
  engine_id: string
  vendor_id: string | null
  model_id: string | null
  updated_at: number
}

function rowToMeta(row: SessionMetaRow): SessionMeta {
  const engineId: EngineId =
    row.engine_id === 'opencode' || row.engine_id === 'pi' ? row.engine_id : 'claude'
  if (row.model_id != null) {
    return {
      engineId,
      model: {
        engineId,
        // Legacy-row hydration fallback: rows written before vendor_id tracking
        // have no persisted vendor, so fall back to the engine's historical default.
        vendorId: row.vendor_id ?? engineMeta(engineId).defaultVendorId,
        modelId: row.model_id
      }
    }
  }
  return { engineId }
}

// ---------------------------------------------------------------------------
// Repository API
// ---------------------------------------------------------------------------

/**
 * Retrieve session metadata for a single session ID.
 * Returns undefined if no entry exists.
 */
export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(sessionId) as
    | SessionMetaRow
    | undefined
  return row ? rowToMeta(row) : undefined
}

/**
 * Insert or replace session metadata for a session ID.
 */
export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       engine_id  = excluded.engine_id,
       vendor_id  = excluded.vendor_id,
       model_id   = excluded.model_id,
       updated_at = excluded.updated_at`
  ).run(
    sessionId,
    meta.engineId,
    meta.model?.vendorId ?? null,
    meta.model?.modelId ?? null,
    Date.now()
  )
}

/**
 * Delete session metadata for a session ID (no-op if absent).
 */
export function deleteSessionMeta(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId)
}

/**
 * Return all session metadata as a Record mapping sessionId → SessionMeta.
 * Mirrors the shape of UISessionConfig.sessionEngines.
 */
export function allSessionMeta(): Record<string, SessionMeta> {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM session_meta').all() as SessionMetaRow[]
  const result: Record<string, SessionMeta> = {}
  for (const row of rows) {
    result[row.session_id] = rowToMeta(row)
  }
  return result
}

/**
 * Carry session metadata from oldId to newId (used on session rekey).
 * If oldId has no entry, a default 'claude' entry is written for newId.
 */
export function renameSessionMeta(oldId: string, newId: string, fallback?: SessionMeta): void {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(oldId) as
    | SessionMetaRow
    | undefined

  if (existing) {
    db.prepare(
      `INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         engine_id  = excluded.engine_id,
         vendor_id  = excluded.vendor_id,
         model_id   = excluded.model_id,
         updated_at = excluded.updated_at`
    ).run(newId, existing.engine_id, existing.vendor_id, existing.model_id, Date.now())
    db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(oldId)
  } else if (fallback) {
    setSessionMeta(newId, fallback)
  } else {
    setSessionMeta(newId, { engineId: 'claude' })
  }
}

// ---------------------------------------------------------------------------
// One-time import from sessions.json
// ---------------------------------------------------------------------------

/**
 * Import session metadata from a legacy sessionEngines record (from sessions.json).
 * Only runs if the session_meta table is empty — ensures a one-time migration.
 * Codex/unknown engineIds are clamped to 'claude', matching the Phase-1 clamp.
 *
 * Call this after the first DB open, before any reads.
 */
export function importSessionEnginesOnce(
  sessionEngines: Record<string, { engineId: string; model?: ModelRef }>
): void {
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) as n FROM session_meta').get() as { n: number }).n
  if (count > 0) return // already populated — skip

  const entries = Object.entries(sessionEngines)
  if (entries.length === 0) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )

  for (const [sessionId, entry] of entries) {
    // Clamp unknown/codex engineIds to 'claude'
    const engineId: EngineId =
      entry.engineId === 'claude' || entry.engineId === 'opencode' || entry.engineId === 'pi'
        ? (entry.engineId as EngineId)
        : 'claude'

    insert.run(
      sessionId,
      engineId,
      entry.model?.vendorId ?? null,
      entry.model?.modelId ?? null,
      Date.now()
    )
  }
}

// ---------------------------------------------------------------------------
// Account repository (Phase 4 — ADR-021)
// Stores AccountInfo metadata only. Credentials stay file-based (ADR-015).
// enabled / activeId pointer stays in accounts.json (simpler; no DB query
// needed on every spawn-env resolve in the hot path).
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string
  email: string | null
  subscription_type: string | null
  organization: string | null
  created_at: number
}

function rowToAccountInfo(row: AccountRow): AccountInfo {
  return {
    id: row.id,
    email: row.email,
    subscriptionType: row.subscription_type,
    organization: row.organization,
    createdAt: row.created_at
  }
}

/** Return all accounts from the DB, ordered by created_at ascending. */
export function getAllAccounts(): AccountInfo[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM account ORDER BY created_at ASC').all() as AccountRow[]
  return rows.map(rowToAccountInfo)
}

/** Insert or replace account metadata. Does NOT touch credentials. */
export function upsertAccount(info: AccountInfo): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO account (id, email, subscription_type, organization, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email             = excluded.email,
       subscription_type = excluded.subscription_type,
       organization      = excluded.organization`
  ).run(info.id, info.email, info.subscriptionType, info.organization, info.createdAt)
}

/** Delete account metadata row. Credentials directory removal is handled by AccountManager. */
export function deleteAccountRow(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM account WHERE id = ?').run(id)
}

/**
 * One-time import from accounts.json AccountInfo array.
 * Only runs if the account table is empty (idempotent).
 * Call this at app start after the DB is open.
 */
export function importAccountsOnce(accounts: AccountInfo[]): void {
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) as n FROM account').get() as { n: number }).n
  if (count > 0) return // already populated — skip

  if (accounts.length === 0) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO account (id, email, subscription_type, organization, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (const acc of accounts) {
    insert.run(acc.id, acc.email, acc.subscriptionType, acc.organization, acc.createdAt)
  }
}

// ---------------------------------------------------------------------------
// Usage event repository (Phase 7 — Pass 1)
// Records one usage_event per turn from either engine. message_id is the dedup
// key — ON CONFLICT DO NOTHING ensures live + reconciler paths converge safely.
// ---------------------------------------------------------------------------

interface UsageEventDbRow {
  id: string
  ts: number
  engine_id: string
  vendor_id: string
  account_id: string | null
  account_uuid: string | null
  model_id: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_write_1h_tokens: number
  cache_read_tokens: number
  equiv_cost_usd: number | null
  engine_cost_usd: number | null
  session_id: string | null
  message_id: string
  source: string
}

function rowToUsageEvent(row: UsageEventDbRow): UsageEventRow {
  return {
    id: row.id,
    ts: row.ts,
    engineId: row.engine_id,
    vendorId: row.vendor_id,
    accountId: row.account_id,
    accountUuid: row.account_uuid,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    cacheReadTokens: row.cache_read_tokens,
    equivCostUsd: row.equiv_cost_usd,
    engineCostUsd: row.engine_cost_usd,
    sessionId: row.session_id,
    messageId: row.message_id,
    source: row.source as 'live' | 'backfill'
  }
}

const INSERT_USAGE_EVENT_SQL = `
  INSERT INTO usage_event (
    id, ts, engine_id, vendor_id, account_id, account_uuid,
    model_id, input_tokens, output_tokens,
    cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
    equiv_cost_usd, engine_cost_usd,
    session_id, message_id, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(message_id) DO NOTHING
`

/**
 * Insert a single usage event. Idempotent on message_id — duplicate inserts
 * (live turn + reconciler for the same turn) are silently dropped.
 */
export function insertUsageEvent(event: UsageEventRow): void {
  const db = getDb()
  db.prepare(INSERT_USAGE_EVENT_SQL).run(
    event.id,
    event.ts,
    event.engineId,
    event.vendorId,
    event.accountId ?? null,
    event.accountUuid ?? null,
    event.modelId,
    event.inputTokens,
    event.outputTokens,
    event.cacheWriteTokens,
    event.cacheWrite1hTokens,
    event.cacheReadTokens,
    event.equivCostUsd ?? null,
    event.engineCostUsd ?? null,
    event.sessionId ?? null,
    event.messageId,
    event.source
  )
}

/**
 * Batch-insert usage events. Each event is inserted idempotently; the batch
 * runs in a single transaction for efficiency.
 */
export function insertUsageEvents(events: UsageEventRow[]): void {
  if (events.length === 0) return
  const db = getDb()
  const stmt = db.prepare(INSERT_USAGE_EVENT_SQL)
  const insertOne = (event: UsageEventRow): void => {
    stmt.run(
      event.id,
      event.ts,
      event.engineId,
      event.vendorId,
      event.accountId ?? null,
      event.accountUuid ?? null,
      event.modelId,
      event.inputTokens,
      event.outputTokens,
      event.cacheWriteTokens,
      event.cacheWrite1hTokens,
      event.cacheReadTokens,
      event.equivCostUsd ?? null,
      event.engineCostUsd ?? null,
      event.sessionId ?? null,
      event.messageId,
      event.source
    )
  }
  // Wrap in a manual BEGIN/COMMIT for bulk efficiency. This is the same pattern
  // the reconciler will use in Pass 2 (bulk JSONL backfill).
  db.prepare('BEGIN').run()
  try {
    for (const event of events) insertOne(event)
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

/** Retrieve a single usage event by message_id (used in tests). */
export function getUsageEventByMessageId(messageId: string): UsageEventRow | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM usage_event WHERE message_id = ?').get(messageId) as
    | UsageEventDbRow
    | undefined
  return row ? rowToUsageEvent(row) : undefined
}

/**
 * Retrieve all usage events with ts >= cutoff, ordered by ts ascending.
 * This is the source for the SQL-backed dashboard aggregation (Pass 2): the
 * block-grouping walk consumes a chronologically-sorted list, exactly like the
 * old JSONL scan did. Optionally filter by engineId.
 */
export function getUsageEventsSince(cutoffTs: number, engineId?: string): UsageEventRow[] {
  const db = getDb()
  const rows = engineId
    ? (db
        .prepare('SELECT * FROM usage_event WHERE ts >= ? AND engine_id = ? ORDER BY ts ASC')
        .all(cutoffTs, engineId) as UsageEventDbRow[])
    : (db
        .prepare('SELECT * FROM usage_event WHERE ts >= ? ORDER BY ts ASC')
        .all(cutoffTs) as UsageEventDbRow[])
  return rows.map(rowToUsageEvent)
}

/** Count usage events (used in tests + reconciler diagnostics). */
export function countUsageEvents(): number {
  const db = getDb()
  return (db.prepare('SELECT COUNT(*) as n FROM usage_event').get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// Window sample repository (Phase 7 — Pass 1)
// One row per usage-window observation (account_uuid + ts + used_percent +
// canonical_end). Used in Pass 2 for the WLS regression and block alignment.
// ---------------------------------------------------------------------------

interface WindowSampleDbRow {
  id: string
  ts: number
  account_uuid: string
  used_percent: number
  canonical_end: number
}

function rowToWindowSample(row: WindowSampleDbRow): WindowSampleRow {
  return {
    id: row.id,
    ts: row.ts,
    accountUuid: row.account_uuid,
    usedPercent: row.used_percent,
    canonicalEnd: row.canonical_end
  }
}

/**
 * Record a window-utilization sample. Each row captures one observation of
 * account_uuid + used_percent + canonical_end at timestamp ts.
 * No dedup key — multiple samples per window are normal (one per poll cycle).
 */
export function recordWindowSample(sample: WindowSampleRow): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO usage_window_sample (id, ts, account_uuid, used_percent, canonical_end)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sample.id, sample.ts, sample.accountUuid, sample.usedPercent, sample.canonicalEnd)
}

/**
 * Retrieve the MOST RECENT `limit` window samples for an account, returned in
 * ascending ts order (used in tests + Pass 2 WLS).
 *
 * M-DB2: this selects DESC + reverses (rather than `ORDER BY ts ASC LIMIT`).
 * usage_window_sample is never pruned per-window and accumulates one row per
 * poll cycle, so past `limit` lifetime samples an ASC LIMIT returns the OLDEST
 * rows and the ACTIVE window's samples (needed by buildDbProjectionSamples,
 * which filters on `canonicalEnd === currentWindowEnd`) never appear — the WLS
 * projection then silently falls back to the in-memory ring forever. Taking the
 * newest `limit` guarantees the current window is always represented; reversing
 * restores the ascending contract callers expect.
 */
export function getWindowSamples(accountUuid: string, limit = 100): WindowSampleRow[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM usage_window_sample WHERE account_uuid = ? ORDER BY ts DESC LIMIT ?')
    .all(accountUuid, limit) as WindowSampleDbRow[]
  // Reverse the DESC page back to ascending ts for consumers.
  return rows.reverse().map(rowToWindowSample)
}

// ---------------------------------------------------------------------------
// Usage-table pruning (M-DB3)
// usage_event and usage_window_sample were never pruned in production and grew
// without bound. Both are only ever READ over recent horizons, so we sweep the
// rest on a bounded, once-per-open cadence (see getDb) — never per-insert.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000
// usage_event is read only at a 7-day lookback (block-usage's getUsageEventsSince
// callers) and older days live durably in daily_usage, so 90d is a very
// conservative floor that keeps well over a week of margin for the reconciler.
const USAGE_EVENT_RETENTION_DAYS = 90
// usage_window_sample is read as the newest-N per account for the ACTIVE (a few
// hours old) window, so 30d never risks the current window while capping growth.
const WINDOW_SAMPLE_RETENTION_DAYS = 30

/**
 * Prune the unbounded usage tables (M-DB3). Deletes usage_event rows older than
 * `usageEventDays` (default 90) and usage_window_sample rows older than
 * `windowSampleDays` (default 30). Both retentions far exceed every read path,
 * so the current 5h window's samples (M-DB2) and the 7d event scan window always
 * survive. A bounded periodic sweep — run once per DB open, never per-insert.
 * Returns the delete counts for diagnostics/tests. Idempotent (a second call
 * with the same clock deletes nothing).
 */
export function pruneUsageTables(
  now: number = Date.now(),
  retention: { usageEventDays?: number; windowSampleDays?: number } = {}
): { usageEventsDeleted: number; windowSamplesDeleted: number } {
  const db = getDb()
  const eventCutoff = now - (retention.usageEventDays ?? USAGE_EVENT_RETENTION_DAYS) * MS_PER_DAY
  const wsCutoff = now - (retention.windowSampleDays ?? WINDOW_SAMPLE_RETENTION_DAYS) * MS_PER_DAY
  const e = db.prepare('DELETE FROM usage_event WHERE ts < ?').run(eventCutoff)
  const w = db.prepare('DELETE FROM usage_window_sample WHERE ts < ?').run(wsCutoff)
  return { usageEventsDeleted: e.changes, windowSamplesDeleted: w.changes }
}

// ---------------------------------------------------------------------------
// Daily usage rollup repository (Phase 7 Pass 2 — Full SQL)
// Durable per-(date, engine, vendor, model) rollup for the 30-day chart. Recent
// days are recomputed from usage_event (source 'rollup', REPLACE); older days
// are seeded once from the legacy daily JSON files (source 'seed', never
// recomputed — their JSONL is gone). NEVER expose the raw db.
// ---------------------------------------------------------------------------

interface DailyUsageDbRow {
  date: string
  engine_id: string
  vendor_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  cost_usd: number
  request_count: number
  peak_api_percent: number
  source: string
}

function rowToDailyUsage(row: DailyUsageDbRow): DailyUsageRow {
  return {
    date: row.date,
    engineId: row.engine_id,
    vendorId: row.vendor_id,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    costUsd: row.cost_usd,
    requestCount: row.request_count,
    peakApiPercent: row.peak_api_percent,
    source: row.source as 'rollup' | 'seed'
  }
}

const UPSERT_DAILY_USAGE_SQL = `
  INSERT INTO daily_usage (
    date, engine_id, vendor_id, model_id,
    input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
    cost_usd, request_count, peak_api_percent, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, engine_id, vendor_id, model_id) DO UPDATE SET
    input_tokens      = excluded.input_tokens,
    output_tokens     = excluded.output_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cost_usd          = excluded.cost_usd,
    request_count     = excluded.request_count,
    peak_api_percent  = excluded.peak_api_percent,
    source            = excluded.source
`

/** Upsert (replace) a set of daily_usage rows in one transaction. */
export function upsertDailyUsage(rows: DailyUsageRow[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(UPSERT_DAILY_USAGE_SQL)
  db.prepare('BEGIN').run()
  try {
    for (const r of rows) {
      stmt.run(
        r.date,
        r.engineId,
        r.vendorId,
        r.modelId,
        r.inputTokens,
        r.outputTokens,
        r.cacheWriteTokens,
        r.cacheReadTokens,
        r.costUsd,
        r.requestCount,
        r.peakApiPercent,
        r.source
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

/**
 * Seed daily_usage rows ONLY for (date, engine, vendor, model) keys not already
 * present (idempotent). Used by the one-time JSON-file import — never clobbers a
 * rollup row. INSERT OR IGNORE on the composite PK.
 */
export function seedDailyUsageIfAbsent(rows: DailyUsageRow[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO daily_usage (
      date, engine_id, vendor_id, model_id,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      cost_usd, request_count, peak_api_percent, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  db.prepare('BEGIN').run()
  try {
    for (const r of rows) {
      stmt.run(
        r.date,
        r.engineId,
        r.vendorId,
        r.modelId,
        r.inputTokens,
        r.outputTokens,
        r.cacheWriteTokens,
        r.cacheReadTokens,
        r.costUsd,
        r.requestCount,
        r.peakApiPercent,
        r.source
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

/** Delete all daily_usage rows for a given date (used before re-rolling a day). */
export function deleteDailyUsageForDate(date: string): void {
  const db = getDb()
  db.prepare('DELETE FROM daily_usage WHERE date = ?').run(date)
}

/** All daily_usage rows ordered by date asc (the chart's source). */
export function getAllDailyUsage(): DailyUsageRow[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM daily_usage ORDER BY date ASC').all() as DailyUsageDbRow[]
  return rows.map(rowToDailyUsage)
}

/** Whether the daily_usage table has any rows (gates the one-time seed). */
export function hasDailyUsage(): boolean {
  const db = getDb()
  return (db.prepare('SELECT COUNT(*) as n FROM daily_usage').get() as { n: number }).n > 0
}

// ---------------------------------------------------------------------------
// Dispatched-usage repository (ADR-033 M4-B — cross-engine dispatch)
// One row per completed/failed dispatched-agent turn, attributed to the
// DISPATCHING session. See the v6 migration comment above for why this table
// exists (dispatched turns are invisible to ADR-011's JSONL scan).
// ---------------------------------------------------------------------------

/** One recorded dispatched-agent turn. */
export interface DispatchedUsageRow {
  id: number
  ts: number
  fromRoutingId: string
  fromEngine: string
  targetEngine: string
  targetModel: string
  targetSessionId: string | null
  toolUseId: string | null
  totalTokens: number | null
  costUsd: number | null
  durationMs: number | null
}

interface DispatchedUsageDbRow {
  id: number
  ts: number
  from_routing_id: string
  from_engine: string
  target_engine: string
  target_model: string
  target_session_id: string | null
  tool_use_id: string | null
  total_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
}

function rowToDispatchedUsage(row: DispatchedUsageDbRow): DispatchedUsageRow {
  return {
    id: row.id,
    ts: row.ts,
    fromRoutingId: row.from_routing_id,
    fromEngine: row.from_engine,
    targetEngine: row.target_engine,
    targetModel: row.target_model,
    targetSessionId: row.target_session_id,
    toolUseId: row.tool_use_id,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms
  }
}

/** Insert one dispatched-usage row (`id` is auto-assigned by SQLite). */
export function insertDispatchedUsage(row: Omit<DispatchedUsageRow, 'id'>): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO dispatched_usage (
       ts, from_routing_id, from_engine, target_engine, target_model,
       target_session_id, tool_use_id, total_tokens, cost_usd, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.ts,
    row.fromRoutingId,
    row.fromEngine,
    row.targetEngine,
    row.targetModel,
    row.targetSessionId ?? null,
    row.toolUseId ?? null,
    row.totalTokens ?? null,
    row.costUsd ?? null,
    row.durationMs ?? null
  )
}

/** All dispatched-usage rows since `sinceTs` (default: all-time), newest first. Test/debug use. */
export function getDispatchedUsageSince(sinceTs = 0): DispatchedUsageRow[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM dispatched_usage WHERE ts >= ? ORDER BY ts DESC')
    .all(sinceTs) as DispatchedUsageDbRow[]
  return rows.map(rowToDispatchedUsage)
}

interface DispatchedUsageSummaryDbRow {
  target_engine: string
  target_model: string
  dispatches: number
  totalTokens: number | null
  costUsd: number | null
}

/**
 * Aggregate dispatched_usage by (target_engine, target_model) since `sinceTs`
 * (default: all-time). NULL total_tokens/cost_usd (best-effort captures, e.g.
 * a timed-out turn) coalesce to 0 so a single unknown-usage row never poisons
 * the whole aggregate.
 */
export function dispatchedUsageSummary(sinceTs = 0): DispatchedUsageSummary[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT
         target_engine,
         target_model,
         COUNT(*) as dispatches,
         SUM(COALESCE(total_tokens, 0)) as totalTokens,
         SUM(COALESCE(cost_usd, 0)) as costUsd
       FROM dispatched_usage
       WHERE ts >= ?
       GROUP BY target_engine, target_model
       ORDER BY costUsd DESC`
    )
    .all(sinceTs) as DispatchedUsageSummaryDbRow[]
  return rows.map((r) => ({
    targetEngine: r.target_engine,
    targetModel: r.target_model,
    dispatches: r.dispatches,
    totalTokens: r.totalTokens ?? 0,
    costUsd: r.costUsd ?? 0
  }))
}

// ---------------------------------------------------------------------------
// Slice C — cross-engine dispatched cost in the dispatching session's own
// cost breakdown (TopBar tooltip). Distinct from dispatchedUsageSummary above
// (a GLOBAL all-sessions rollup, e.g. for a future usage dashboard) — this is
// scoped to ONE dispatching session, for BaseSession.seedDispatchedCosts()'s
// durability-across-reloads seed.
// ---------------------------------------------------------------------------

interface DispatchedCostByRoutingDbRow {
  target_engine: string
  target_model: string
  costUsd: number | null
}

/**
 * Per-(targetEngine, targetModel) cost totals for ONE dispatching session,
 * NULL-cost rows excluded (a timed-out/errored turn recorded no real spend —
 * see the v6 migration comment; including it would just add a spurious $0
 * row group). Feeds BaseSession.seedDispatchedCosts() on session construction/
 * resume so a reloaded session's dispatched-cost breakdown survives instead of
 * resetting to zero (parity with Slice B's costBaseUsd seeding).
 */
export function dispatchedCostsByRouting(
  fromRoutingId: string
): Array<{ targetEngine: string; targetModel: string; costUsd: number }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT
         target_engine,
         target_model,
         SUM(cost_usd) as costUsd
       FROM dispatched_usage
       WHERE from_routing_id = ? AND cost_usd IS NOT NULL
       GROUP BY target_engine, target_model`
    )
    .all(fromRoutingId) as DispatchedCostByRoutingDbRow[]
  return rows.map((r) => ({
    targetEngine: r.target_engine,
    targetModel: r.target_model,
    costUsd: r.costUsd ?? 0
  }))
}

/**
 * Carry dispatched_usage rows from oldRoutingId to newRoutingId (used on
 * session rekey — SessionManager.rekey() — mirroring renameSessionMeta's
 * role for session_meta). Without this, a dispatch recorded under a
 * pre-rekey routingId (e.g. a fresh session's temporary id, before the sdk
 * session UUID arrives) becomes unreachable from seedDispatchedCosts() on a
 * later resume, which looks up by the STABLE post-rekey id. No-op (not an
 * error) when oldRoutingId has no rows — most rekeys happen before any
 * dispatch occurs.
 */
export function renameDispatchedUsage(oldRoutingId: string, newRoutingId: string): void {
  const db = getDb()
  db.prepare('UPDATE dispatched_usage SET from_routing_id = ? WHERE from_routing_id = ?').run(
    newRoutingId,
    oldRoutingId
  )
}
