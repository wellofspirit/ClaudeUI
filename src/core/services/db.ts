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
import type {
  EngineId,
  ModelRef,
  AccountInfo,
  DispatchedUsageSummary,
  RemoteAuthPolicy,
  StepUpTier
} from '../../shared/types'
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

/**
 * The production migration list. Exported so tests can replay a PREFIX of it and
 * assert the upgrade path (e.g. that v8's ALTER TABLEs preserve a v7 row) rather
 * than only the end state of a fresh DB.
 */
export const MIGRATIONS: Migration[] = [
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
  },
  {
    // v7 — Remote-server persisted config + password credential (Phase 1 of
    // remote auth). Single-row table (id fixed to 1 via CHECK) mirrors the
    // singleton nature of "the" remote server config — no per-profile config
    // exists yet. NEVER expose password_salt/password_hash/kdf_params over
    // IPC (see remote:get-config in main/index.ts) — this table is the one
    // place those bytes live; UISettings must never carry them (a remote
    // client can read/write UISettings via config:save-settings).
    //
    // tls_mode is a placeholder column (wired in Phase 3) so a later
    // migration doesn't need to ALTER TABLE just to add it.
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS remote_config (
          id                  INTEGER PRIMARY KEY CHECK (id = 1),
          port                INTEGER NOT NULL DEFAULT 0,
          bind_host           TEXT,
          autostart           INTEGER NOT NULL DEFAULT 0,
          tls_mode            INTEGER NOT NULL DEFAULT 0,
          password_salt       TEXT,
          password_hash       TEXT,
          kdf_params          TEXT,
          password_updated_at INTEGER,
          updated_at          INTEGER NOT NULL
        );
      `)
    }
  },
  {
    // v8 — ADR-042: the Tailscale HTTPS port is PINNED config, not a candidate
    // walk, plus the persisted cleanup record the startup reconciliation reads.
    //
    // `tls_https_port` defaults to 443 (bare `https://<node>.ts.net`, the whole
    // point of the mode: a bookmarkable URL). Any uint16 is legal — `tailscale
    // serve` accepts any port; 443/8443/10000 is only the Funnel-compatible
    // triple.
    //
    // `last_serve_https_port` / `last_serve_local_port` record the serve entry
    // we last confirmed: `{httpsPort, localPort}`. On the next startup an entry
    // on that HTTPS port proxying to `http://127.0.0.1:<localPort>` is PROVABLY
    // ours (the loopback port is random per run), so it can be removed even
    // after a force-kill. Nullable: no record means nothing to reconcile.
    version: 8,
    up(db) {
      db.exec(`
        ALTER TABLE remote_config ADD COLUMN tls_https_port INTEGER NOT NULL DEFAULT 443;
        ALTER TABLE remote_config ADD COLUMN last_serve_https_port INTEGER;
        ALTER TABLE remote_config ADD COLUMN last_serve_local_port INTEGER;
      `)
    }
  },
  {
    // v9 — SyncCore phase 1 (ADR-051/052): append-only command audit log.
    //
    // One row per dispatched COMMAND (queries are not audited), from either
    // transport, carrying the per-connection identity that issued it. This is
    // the durable half of the SyncCore persistence story — the event log stays
    // memory-only, the audit log does not (sync-core.md §Persistence).
    //
    // Append-only is enforced at the REPOSITORY surface (only append/list are
    // exported below), not by SQLite triggers: the operational DB is the
    // owner's own file, so a trigger would be theater against an attacker who
    // already has it, while the repo boundary is what stops our own code from
    // quietly rewriting history.
    //
    // Index on ts alone: every read is "the most recent N, optionally before T".
    version: 9,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts            INTEGER NOT NULL,
          connection_id TEXT NOT NULL,
          method        TEXT NOT NULL,
          label         TEXT NOT NULL,
          capability    TEXT NOT NULL,
          kind          TEXT NOT NULL,
          channel       TEXT NOT NULL,
          session_id    TEXT,
          outcome       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
      `)
    }
  },
  {
    // v10 — SyncCore phase 2 (ADR-052 decision 6): remote-terminal posture.
    //
    // `allow_terminal` is the desktop-side master switch for the `shell`
    // capability, OFF by default. It lives HERE and not in settings.json
    // because `config:save-settings` is remotely reachable (capability
    // `config`) — a settings-blob flag would let a remote client self-grant
    // shell. This table is only ever written through the desktop-only
    // `remote:set-config` IPC (pinned `admin`, never registered remote).
    //
    // `shell_grant_idle_minutes` is the decay window for a stepped-up `shell`
    // grant (security.md §"Grant decay"; default 10).
    version: 10,
    up(db) {
      db.exec(`
        ALTER TABLE remote_config ADD COLUMN allow_terminal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE remote_config ADD COLUMN shell_grant_idle_minutes INTEGER NOT NULL DEFAULT 10;
      `)
    }
  },
  {
    // v11 — passkeys (ADR-052 decision 1-3 / security.md §"Identity &
    // authentication methods"): the WebAuthn credential table and the three
    // policy columns.
    //
    // A stolen DB leaks PUBLIC keys only — `public_key` is the COSE public key
    // the authenticator handed us at registration; the private half never
    // leaves the device's enclave. `sign_count` is RECORDED BUT NEVER ENFORCED:
    // synced passkeys (iCloud Keychain / Google Password Manager) legitimately
    // report 0 forever, so a counter-regression rejection would lock out
    // exactly the credentials the design is built around.
    //
    // `cred_id` is base64url TEXT (what the wire and @simplewebauthn both speak)
    // rather than a BLOB, so lookups need no encoding dance; `transports` is a
    // JSON array or NULL because it is opaque metadata we only ever hand back to
    // the browser verbatim.
    //
    // `auth_policy` is NULLABLE ON PURPOSE: NULL means AUTO — ≥1 credential
    // resolves to `passkey-always`, otherwise `legacy`. That is how "default
    // once a credential is enrolled" stays true without a migration having to
    // guess, while an explicit value still wins forever after. The column lives
    // in `remote_config` (not settings.json) for the same reason
    // `allow_terminal` does: `config:save-settings` is remotely reachable, and a
    // remotely writable policy column would let a client downgrade its own
    // authentication.
    //
    // `password_break_glass` defaults to 1 (owner decision: break-glass ON by
    // default; the `passkey-only` toggle clears it). `passkey_tailnet_exempt`
    // defaults to 0 — under `passkey-always` a tailnet identity does NOT skip
    // the ceremony (device theft is the threat ambient identity does not cover).
    version: 11,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webauthn_credential (
          cred_id        TEXT PRIMARY KEY,
          public_key     BLOB NOT NULL,
          transports     TEXT,
          nickname       TEXT,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER,
          backed_up      INTEGER NOT NULL DEFAULT 0,
          aaguid         TEXT,
          sign_count     INTEGER NOT NULL DEFAULT 0
        );
        ALTER TABLE remote_config ADD COLUMN auth_policy TEXT;
        ALTER TABLE remote_config ADD COLUMN password_break_glass INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE remote_config ADD COLUMN passkey_tailnet_exempt INTEGER NOT NULL DEFAULT 0;
      `)
    }
  },
  {
    // v12 — step-up policy TIERS (ADR-054): the second axis, audit intent, and
    // audit retention.
    //
    // `step_up_tier` is NOT NULL DEFAULT 'medium' — unlike `auth_policy`, which
    // is nullable because AUTO is a real third state resolved per connection.
    // There is no AUTO for freshness: `medium` IS the default posture, and a
    // nullable column would only invite a second "what does null mean here"
    // rule. An unrecognised value reads as `medium` (see `parseStepUpTier`);
    // failing to `off` would silently disable step-up on a hand-edited typo.
    //
    // `audit_retention_days` is clamped to its 30-day floor at READ, never at
    // write: a row hand-edited to 5 must degrade to the floor rather than
    // silently start deleting a month of trail, and clamping at write would
    // leave the bad value in place for anything reading the column directly.
    //
    // `detail` on `audit_log` is NULLABLE and stays NULL for command rows — it
    // carries the INTENT of an auth-event row ("passkey login accepted;
    // conferred admin+enroll"), which the `capability` column can only imply.
    // Same single writer (`appendAuditLog`); no index (it is never a predicate).
    //
    // The DATA migration retires `passkey-for-grants` (ADR-054 supersedes
    // ADR-052 decision 3): it was "legacy login + medium step-up tier" written
    // as one knob. `legacy` plus this migration's default `medium` tier is the
    // same behavior, expressed on the two axes that actually exist. Rows on any
    // other policy are untouched — least of all `off`, which no migration may
    // ever set OR clear.
    version: 12,
    up(db) {
      db.exec(`
        ALTER TABLE remote_config ADD COLUMN step_up_tier TEXT NOT NULL DEFAULT 'medium';
        ALTER TABLE remote_config ADD COLUMN step_up_mutation_idle_minutes INTEGER NOT NULL DEFAULT 60;
        ALTER TABLE remote_config ADD COLUMN session_max_age_hours INTEGER NOT NULL DEFAULT 4;
        ALTER TABLE remote_config ADD COLUMN audit_retention_days INTEGER NOT NULL DEFAULT 365;
        ALTER TABLE audit_log ADD COLUMN detail TEXT;
        UPDATE remote_config SET auth_policy = 'legacy' WHERE auth_policy = 'passkey-for-grants';
      `)
    }
  },
  {
    // v13 — the ADR-056 admission model: `legacy` retires, and the LAN channel
    // gets a PERSISTENT key.
    //
    // The DATA migration rewrites stored `legacy` to NULL, i.e. back to AUTO.
    // That is a real restoration rather than a downgrade: `legacy` named "the
    // as-built ADR-039 stack", whose token and ambient-tailnet admission are
    // both gone, so what it selected for was exactly the two states AUTO already
    // resolves between — `passkey-always` with a credential enrolled, `password`
    // without one. Rows on any other policy are untouched, least of all `off`,
    // which no migration may ever set OR clear.
    //
    // `lan_e2e_key` is NULLABLE and stays NULL until the first start that serves
    // a non-loopback bind — generating it here would mint a channel secret for
    // every install that will only ever use `tailscale serve`. It is a SECRET
    // and is deliberately absent from `sanitizedRemoteConfig` / `authcfg:get`;
    // the only readers are the handshake and the two session-gated link verbs.
    //
    // `passkey_tailnet_exempt` is NOT dropped. Its MEANING is retired (ambient
    // tailnet grants are gone), so nothing reads or writes it any more, but a
    // dead column costs nothing while `ALTER TABLE ... DROP COLUMN` would brick
    // an older build that still names it in its INSERT — and the downgrade guard
    // above is explicitly a "proceed read-forward" path, not a refusal.
    version: 13,
    up(db) {
      db.exec(`
        ALTER TABLE remote_config ADD COLUMN lan_e2e_key TEXT;
        UPDATE remote_config SET auth_policy = NULL WHERE auth_policy = 'legacy';
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
/** Periodic audit-retention sweep (ADR-054 decision 5); cleared by {@link closeDb}. */
let _auditPruneTimer: ReturnType<typeof setInterval> | null = null

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

  // Audit retention (ADR-054 decision 5), same shape and the same best-effort
  // contract. Unlike the usage tables this one ALSO gets a timer: a desktop app
  // can stay open for weeks, and a retention window that only advances when the
  // process restarts is not a retention window.
  //
  // `unref()` so the interval can never hold the process (or a test runner)
  // alive by itself — this is housekeeping, not work anyone waits on.
  try {
    pruneAuditLog()
  } catch (err) {
    logger.warn('DB', `audit-log prune on open failed (non-fatal): ${err}`)
  }
  if (!_auditPruneTimer) {
    _auditPruneTimer = setInterval(() => {
      try {
        pruneAuditLog()
      } catch (err) {
        logger.warn('DB', `periodic audit-log prune failed (non-fatal): ${err}`)
      }
    }, AUDIT_PRUNE_INTERVAL_MS)
    _auditPruneTimer.unref?.()
  }

  return _db
}

/**
 * Close the DB and reset the singleton. Primarily for test teardown.
 */
export function closeDb(): void {
  // Before the handle goes: a surviving timer would call getDb() on a closed
  // singleton and silently re-open the file every 24 h (and, in tests, keep a
  // handle on a DB the next case expects to be fresh).
  if (_auditPruneTimer) {
    clearInterval(_auditPruneTimer)
    _auditPruneTimer = null
  }
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

// ---------------------------------------------------------------------------
// Remote-server config repository (Phase 1 — persisted remote-server config)
// Single-row table (id fixed to 1). password_salt/password_hash/kdf_params
// NEVER cross IPC (see remote:get-config in main/index.ts) — they're read
// here only by remote-auth.ts (credential verification) and the accessors
// below. setRemoteConfig/setRemotePassword each preserve the columns owned
// by the OTHER accessor (read-modify-write against the current row).
// ---------------------------------------------------------------------------

/**
 * Default pinned `tailscale serve` HTTPS port (ADR-042) — mirrors the v8 column
 * default. 443 is what makes the URL a bare `https://<node>.ts.net`.
 */
export const DEFAULT_TLS_HTTPS_PORT = 443

/**
 * Default idle window for a stepped-up `shell` grant, in minutes (ADR-052
 * decision 5 / security.md §"Grant decay"). Mirrors the v10 column default.
 */
export const DEFAULT_SHELL_GRANT_IDLE_MINUTES = 10

/**
 * Defaults for the ADR-054 step-up columns. Mirrors of the v12 column defaults,
 * used by the in-code COALESCE for rows written before that migration.
 */
export const DEFAULT_STEP_UP_TIER: StepUpTier = 'medium'
export const DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES = 60
export const DEFAULT_SESSION_MAX_AGE_HOURS = 4

/**
 * The closed vocabulary of STORABLE policy values, as a runtime value — the IPC
 * validator and the row mapper both need to test membership, and duplicating the
 * literals is how a mode would end up accepted in one place and rejected in the
 * other.
 *
 * `password` is deliberately ABSENT even though it is a legal
 * {@link RemoteAuthPolicy}: it is what AUTO resolves to with nothing enrolled,
 * never something an operator pins. Pinning it would mean "keep accepting a
 * password after I enrol a passkey", which is what `passwordBreakGlass` already
 * says, on a knob that already exists.
 *
 * `passkey-for-grants` was removed by ADR-054 and `legacy` by ADR-056 (migrations
 * v12 and v13 rewrite the stored rows); neither is accepted on the write path any
 * more, which is what stops a client re-creating a value the code no longer
 * branches on.
 */
export const REMOTE_AUTH_POLICIES: readonly RemoteAuthPolicy[] = ['passkey-always', 'off']

/** The closed step-up tier vocabulary, same single-source reasoning. */
export const STEP_UP_TIERS: readonly StepUpTier[] = ['strong', 'medium', 'off']

/**
 * Parse `remote_config.auth_policy`. Fails to AUTO (`null`), never to `off`:
 * the master switch must only ever be reachable by an explicit, audited write.
 */
export function parseAuthPolicy(raw: string | null | undefined): RemoteAuthPolicy | null {
  if (raw == null) return null
  return (REMOTE_AUTH_POLICIES as readonly string[]).includes(raw)
    ? (raw as RemoteAuthPolicy)
    : null
}

/**
 * Parse `remote_config.step_up_tier`. Fails CLOSED-ish to `medium`, never to
 * `off`: a corrupt or hand-edited value must land on the default posture rather
 * than silently disable every freshness check. There is no AUTO here — unlike
 * the auth policy, the tier has a real default rather than a resolved one.
 */
export function parseStepUpTier(raw: string | null | undefined): StepUpTier {
  if (raw == null) return DEFAULT_STEP_UP_TIER
  return (STEP_UP_TIERS as readonly string[]).includes(raw)
    ? (raw as StepUpTier)
    : DEFAULT_STEP_UP_TIER
}

interface RemoteConfigDbRow {
  id: number
  port: number
  bind_host: string | null
  autostart: number
  tls_mode: number
  tls_https_port: number
  last_serve_https_port: number | null
  last_serve_local_port: number | null
  allow_terminal: number
  shell_grant_idle_minutes: number
  auth_policy: string | null
  password_break_glass: number
  /**
   * DEAD since migration v13 (ADR-056 retired the ambient tailnet grant the
   * exemption named). Still SELECTed by `SELECT *` and still written by its
   * column default, never read or set by any code path. Declared optional so the
   * mapper stays honest about the fact that nothing depends on it.
   */
  passkey_tailnet_exempt?: number
  /**
   * Persistent LAN channel key, 32 bytes hex, or NULL until the first start that
   * serves a non-loopback bind (ADR-056 item C). A SECRET — it never reaches
   * `sanitizedRemoteConfig` / `authcfg:get`.
   */
  lan_e2e_key: string | null
  step_up_tier: string | null
  step_up_mutation_idle_minutes: number
  session_max_age_hours: number
  audit_retention_days: number
  password_salt: string | null
  password_hash: string | null
  kdf_params: string | null
  password_updated_at: number | null
  updated_at: number
}

export interface RemoteConfigRow {
  port: number
  bindHost: string | null
  autostart: boolean
  tlsMode: number
  /** Pinned `tailscale serve` HTTPS port (ADR-042). Default 443. */
  tlsHttpsPort: number
  /** HTTPS port of the last CONFIRMED serve entry we created, or null. */
  lastServeHttpsPort: number | null
  /** Loopback port that entry proxied to — the proof it is ours. */
  lastServeLocalPort: number | null
  /** Desktop-side master switch for remote terminals (ADR-052). Default OFF. */
  allowTerminal: boolean
  /** Idle decay window for a stepped-up `shell` grant, in minutes. */
  shellGrantIdleMinutes: number
  /**
   * Stored auth policy (ADR-052 decision 3), or `null` for AUTO. An
   * unrecognised string in the column reads as `null` — a corrupt/hand-edited
   * row must fall back to AUTO, never to `off`.
   */
  authPolicy: RemoteAuthPolicy | null
  /** Break-glass password accepted under the passkey modes. Default ON. */
  passwordBreakGlass: boolean
  /**
   * Persistent LAN E2E channel key (32-byte hex), or null before the first
   * non-loopback start. A SECRET: read by the handshake and by the two
   * session-gated link verbs, and never by the config sanitizer.
   */
  lanE2eKey: string | null
  /**
   * Stored step-up tier (ADR-054 decision 1). Never null — an unrecognised
   * column value reads as `medium`. This is the RAW setting; auth-mode `off`
   * forces the EFFECTIVE tier to `off` (`resolveStepUpTier`), which is a
   * decision the policy layer makes, not the repository.
   */
  stepUpTier: StepUpTier
  /** Strong-tier idle window for NON-shell mutations, in minutes. Default 60. */
  stepUpMutationIdleMinutes: number
  /** Strong-tier absolute session lifetime, in hours. Default 4. */
  sessionMaxAgeHours: number
  /**
   * Audit retention in days, ALREADY CLAMPED to the 30-day floor. Clamping
   * happens here (at read) rather than at write so a hand-edited column that
   * says 5 degrades to 30 instead of quietly purging a month of trail.
   */
  auditRetentionDays: number
  passwordSalt: string | null
  passwordHash: string | null
  kdfParams: string | null
  passwordUpdatedAt: number | null
  updatedAt: number
}

function rowToRemoteConfig(row: RemoteConfigDbRow): RemoteConfigRow {
  return {
    port: row.port,
    bindHost: row.bind_host,
    autostart: row.autostart === 1,
    tlsMode: row.tls_mode,
    // COALESCE in code rather than SQL: a DB written by a build that predates
    // v8 and re-opened by an even newer build still reads through this mapper.
    tlsHttpsPort: row.tls_https_port ?? DEFAULT_TLS_HTTPS_PORT,
    lastServeHttpsPort: row.last_serve_https_port ?? null,
    lastServeLocalPort: row.last_serve_local_port ?? null,
    // Same in-code COALESCE reasoning as tlsHttpsPort: a row written by a build
    // that predates v10 must read as "terminal off, default decay", never as
    // `undefined` (which would be falsy for the toggle but NaN-ish for the window).
    allowTerminal: row.allow_terminal === 1,
    shellGrantIdleMinutes: row.shell_grant_idle_minutes ?? DEFAULT_SHELL_GRANT_IDLE_MINUTES,
    // Same in-code COALESCE reasoning again for the v11 columns. `auth_policy`
    // additionally VALIDATES: anything outside the closed set (including a
    // hand-edited row) reads as AUTO, so a typo can never silently mean `off`.
    authPolicy: parseAuthPolicy(row.auth_policy),
    passwordBreakGlass: (row.password_break_glass ?? 1) === 1,
    // v13 (ADR-056). Null until the first non-loopback start generates one.
    lanE2eKey: row.lan_e2e_key ?? null,
    // v12 (ADR-054). Same in-code COALESCE reasoning once more, plus the
    // retention CLAMP — see `RemoteConfigRow.auditRetentionDays`.
    stepUpTier: parseStepUpTier(row.step_up_tier),
    stepUpMutationIdleMinutes:
      row.step_up_mutation_idle_minutes ?? DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES,
    sessionMaxAgeHours: row.session_max_age_hours ?? DEFAULT_SESSION_MAX_AGE_HOURS,
    auditRetentionDays: clampAuditRetentionDays(row.audit_retention_days),
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    kdfParams: row.kdf_params,
    passwordUpdatedAt: row.password_updated_at,
    updatedAt: row.updated_at
  }
}

function getRemoteConfigDbRow(db: Db): RemoteConfigDbRow | undefined {
  return db.prepare('SELECT * FROM remote_config WHERE id = 1').get() as
    | RemoteConfigDbRow
    | undefined
}

/** Read the singleton remote-server config row, or null if never written. */
export function getRemoteConfig(): RemoteConfigRow | null {
  const db = getDb()
  const row = getRemoteConfigDbRow(db)
  return row ? rowToRemoteConfig(row) : null
}

/**
 * Upsert the singleton remote-server config row. Only touches
 * port/bind_host/autostart/tls_mode/tls_https_port — password columns AND the
 * last-serve record are left untouched on an existing row (SQLite
 * `INSERT ... ON CONFLICT DO UPDATE` only reassigns the columns named in the
 * SET clause) and take their column default on first insert. Fields omitted
 * from `partial` keep their current value (or the column default if the row
 * doesn't exist yet).
 */
export function setRemoteConfig(partial: {
  port?: number
  bindHost?: string | null
  autostart?: boolean
  tlsMode?: number
  tlsHttpsPort?: number
  allowTerminal?: boolean
  shellGrantIdleMinutes?: number
  /** `null` is a MEANINGFUL value here (restore AUTO), so it is distinguished
   *  from `undefined` (leave alone) — same convention as `bindHost`. */
  authPolicy?: RemoteAuthPolicy | null
  passwordBreakGlass?: boolean
  stepUpTier?: StepUpTier
  stepUpMutationIdleMinutes?: number
  sessionMaxAgeHours?: number
  auditRetentionDays?: number
}): void {
  const db = getDb()
  const existing = getRemoteConfigDbRow(db)
  const port = partial.port ?? existing?.port ?? 0
  const bindHost = partial.bindHost !== undefined ? partial.bindHost : (existing?.bind_host ?? null)
  const autostart =
    partial.autostart !== undefined ? (partial.autostart ? 1 : 0) : (existing?.autostart ?? 0)
  const tlsMode = partial.tlsMode ?? existing?.tls_mode ?? 0
  const tlsHttpsPort = partial.tlsHttpsPort ?? existing?.tls_https_port ?? DEFAULT_TLS_HTTPS_PORT
  const allowTerminal =
    partial.allowTerminal !== undefined
      ? partial.allowTerminal
        ? 1
        : 0
      : (existing?.allow_terminal ?? 0)
  const shellGrantIdleMinutes =
    partial.shellGrantIdleMinutes ??
    existing?.shell_grant_idle_minutes ??
    DEFAULT_SHELL_GRANT_IDLE_MINUTES
  const authPolicy =
    partial.authPolicy !== undefined ? partial.authPolicy : (existing?.auth_policy ?? null)
  const passwordBreakGlass =
    partial.passwordBreakGlass !== undefined
      ? partial.passwordBreakGlass
        ? 1
        : 0
      : (existing?.password_break_glass ?? 1)
  const stepUpTier =
    partial.stepUpTier ?? parseStepUpTier(existing?.step_up_tier ?? DEFAULT_STEP_UP_TIER)
  const stepUpMutationIdleMinutes =
    partial.stepUpMutationIdleMinutes ??
    existing?.step_up_mutation_idle_minutes ??
    DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES
  const sessionMaxAgeHours =
    partial.sessionMaxAgeHours ?? existing?.session_max_age_hours ?? DEFAULT_SESSION_MAX_AGE_HOURS
  // Stored verbatim (no clamp): the floor is applied on READ so a value written
  // by a hand-edit or an older build degrades safely rather than being rewritten
  // underneath whoever put it there.
  const auditRetentionDays =
    partial.auditRetentionDays ?? existing?.audit_retention_days ?? DEFAULT_AUDIT_RETENTION_DAYS

  db.prepare(
    `INSERT INTO remote_config (
       id, port, bind_host, autostart, tls_mode, tls_https_port,
       allow_terminal, shell_grant_idle_minutes,
       auth_policy, password_break_glass,
       step_up_tier, step_up_mutation_idle_minutes, session_max_age_hours,
       audit_retention_days, updated_at
     )
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       port                          = excluded.port,
       bind_host                     = excluded.bind_host,
       autostart                     = excluded.autostart,
       tls_mode                      = excluded.tls_mode,
       tls_https_port                = excluded.tls_https_port,
       allow_terminal                = excluded.allow_terminal,
       shell_grant_idle_minutes      = excluded.shell_grant_idle_minutes,
       auth_policy                   = excluded.auth_policy,
       password_break_glass          = excluded.password_break_glass,
       step_up_tier                  = excluded.step_up_tier,
       step_up_mutation_idle_minutes = excluded.step_up_mutation_idle_minutes,
       session_max_age_hours         = excluded.session_max_age_hours,
       audit_retention_days          = excluded.audit_retention_days,
       updated_at                    = excluded.updated_at`
  ).run(
    port,
    bindHost,
    autostart,
    tlsMode,
    tlsHttpsPort,
    allowTerminal,
    shellGrantIdleMinutes,
    authPolicy,
    passwordBreakGlass,
    stepUpTier,
    stepUpMutationIdleMinutes,
    sessionMaxAgeHours,
    auditRetentionDays,
    Date.now()
  )
}

/**
 * Persist the LAN E2E channel key (ADR-056 item C).
 *
 * Deliberately NARROW — it names ONLY `lan_e2e_key` in both the INSERT and the
 * SET clause, exactly like {@link setLastServeRecord} and for the same reason: a
 * lazy key generation happens during `start()` and a rotation happens from the
 * settings editor, either of which can race a Settings write, and neither may
 * clobber the config or password columns.
 *
 * `setRemoteConfig` deliberately does NOT carry this field: a channel key is not
 * a config field, on the same reasoning that keeps `authcfg:set-password` out of
 * `authcfg:apply`'s batch.
 */
export function setLanE2eKey(keyHex: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO remote_config (id, lan_e2e_key, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       lan_e2e_key = excluded.lan_e2e_key,
       updated_at  = excluded.updated_at`
  ).run(keyHex, Date.now())
}

/**
 * Record the serve entry we just confirmed (ADR-042 decision 3): the HTTPS port
 * and the loopback port it proxies to. Deliberately narrow — it names ONLY the
 * two last-serve columns in both the INSERT and the SET clause, so it can never
 * clobber the config or password columns (a serve success can land at any time,
 * including concurrently with a Settings write).
 */
export function setLastServeRecord(httpsPort: number, localPort: number): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO remote_config (id, last_serve_https_port, last_serve_local_port, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_serve_https_port = excluded.last_serve_https_port,
       last_serve_local_port = excluded.last_serve_local_port,
       updated_at            = excluded.updated_at`
  ).run(httpsPort, localPort, Date.now())
}

/**
 * NULL out the last-serve record — called after a CONFIRMED `disableServe`, or
 * when reconciliation finds the live config no longer matches the record.
 * No-op when no row exists (nothing to clear).
 */
export function clearLastServeRecord(): void {
  const db = getDb()
  const existing = getRemoteConfigDbRow(db)
  if (!existing) return
  db.prepare(
    `UPDATE remote_config SET
       last_serve_https_port = NULL,
       last_serve_local_port = NULL,
       updated_at = ?
     WHERE id = 1`
  ).run(Date.now())
}

/**
 * Upsert the password credential columns, preserving the config columns
 * (port/bindHost/autostart/tlsMode) untouched on an existing row. `salt` and
 * `hash` are lowercase hex; `kdfParams` is the JSON blob from
 * remote-auth.ts's computeStoredCredential.
 */
export function setRemotePassword(salt: string, hash: string, kdfParams: string): void {
  const db = getDb()
  const existing = getRemoteConfigDbRow(db)
  const now = Date.now()

  db.prepare(
    `INSERT INTO remote_config (
       id, port, bind_host, autostart, tls_mode,
       password_salt, password_hash, kdf_params, password_updated_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       password_salt       = excluded.password_salt,
       password_hash       = excluded.password_hash,
       kdf_params          = excluded.kdf_params,
       password_updated_at = excluded.password_updated_at,
       updated_at          = excluded.updated_at`
  ).run(
    existing?.port ?? 0,
    existing?.bind_host ?? null,
    existing?.autostart ?? 0,
    existing?.tls_mode ?? 0,
    salt,
    hash,
    kdfParams,
    now,
    now
  )
}

/**
 * NULL out the password credential columns (salt/hash/kdf_params/updated_at).
 * No-op if the row doesn't exist yet (nothing to clear).
 */
export function clearRemotePassword(): void {
  const db = getDb()
  const existing = getRemoteConfigDbRow(db)
  if (!existing) return
  db.prepare(
    `UPDATE remote_config SET
       password_salt = NULL,
       password_hash = NULL,
       kdf_params = NULL,
       password_updated_at = NULL,
       updated_at = ?
     WHERE id = 1`
  ).run(Date.now())
}

// ---------------------------------------------------------------------------
// WebAuthn credential repository (ADR-052 decision 1 / security.md §Passkeys)
//
// Public keys only. `publicKey` is the COSE-encoded PUBLIC half handed over at
// registration; the private key never leaves the authenticator's enclave, so a
// stolen operational.db leaks nothing that can authenticate. Nothing here is
// ever exposed verbatim over a wire — the management verbs project a
// deliberately narrower row (see `webauthn:credentials`).
// ---------------------------------------------------------------------------

/** One enrolled passkey. `credId` is base64url — the id the wire speaks. */
export interface WebauthnCredentialRow {
  credId: string
  /** COSE public key bytes. NEVER leaves the main process. */
  publicKey: Buffer
  /** Authenticator transports (`['internal','hybrid']`, …), or null. */
  transports: string[] | null
  nickname: string | null
  createdAt: number
  lastUsedAt: number | null
  /** Synced/multi-device credential (iCloud Keychain, Google PM, …). */
  backedUp: boolean
  aaguid: string | null
  /** Recorded, NEVER enforced — synced passkeys legitimately report 0. */
  signCount: number
}

interface WebauthnCredentialDbRow {
  cred_id: string
  public_key: Buffer | Uint8Array
  transports: string | null
  nickname: string | null
  created_at: number
  last_used_at: number | null
  backed_up: number
  aaguid: string | null
  sign_count: number
}

function rowToWebauthnCredential(row: WebauthnCredentialDbRow): WebauthnCredentialRow {
  let transports: string[] | null = null
  if (row.transports) {
    try {
      const parsed: unknown = JSON.parse(row.transports)
      // A hand-edited / corrupt column must not crash the auth path; it is
      // opaque metadata we only ever echo back to the browser.
      if (Array.isArray(parsed)) transports = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      transports = null
    }
  }
  return {
    credId: row.cred_id,
    // node:sqlite (the vitest shim) hands back a Uint8Array where
    // better-sqlite3 hands back a Buffer; normalize so callers see one type.
    publicKey: Buffer.isBuffer(row.public_key) ? row.public_key : Buffer.from(row.public_key),
    transports,
    nickname: row.nickname,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    backedUp: row.backed_up === 1,
    aaguid: row.aaguid,
    signCount: row.sign_count
  }
}

/** Insert a freshly verified credential. Throws on a duplicate `credId`
 *  (the PRIMARY KEY) — which is exactly what `excludeCredentials` prevents. */
export function insertWebauthnCredential(cred: {
  credId: string
  publicKey: Uint8Array
  transports?: string[] | null
  nickname?: string | null
  createdAt?: number
  backedUp?: boolean
  aaguid?: string | null
  signCount?: number
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO webauthn_credential (
       cred_id, public_key, transports, nickname, created_at, last_used_at,
       backed_up, aaguid, sign_count
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  ).run(
    cred.credId,
    Buffer.from(cred.publicKey),
    cred.transports && cred.transports.length > 0 ? JSON.stringify(cred.transports) : null,
    cred.nickname ?? null,
    cred.createdAt ?? Date.now(),
    cred.backedUp ? 1 : 0,
    cred.aaguid ?? null,
    cred.signCount ?? 0
  )
}

/** Every enrolled credential, oldest first (enrollment order is the useful one). */
export function listWebauthnCredentials(): WebauthnCredentialRow[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM webauthn_credential ORDER BY created_at ASC, cred_id ASC')
    .all() as WebauthnCredentialDbRow[]
  return rows.map(rowToWebauthnCredential)
}

/** One credential by base64url id, or null. */
export function getWebauthnCredential(credId: string): WebauthnCredentialRow | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM webauthn_credential WHERE cred_id = ?').get(credId) as
    | WebauthnCredentialDbRow
    | undefined
  return row ? rowToWebauthnCredential(row) : null
}

/**
 * How many credentials are enrolled. This is what AUTO policy resolution reads,
 * so it is a COUNT rather than `listWebauthnCredentials().length` — it runs on
 * every connection and must not deserialize every public key to answer.
 */
export function countWebauthnCredentials(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) AS n FROM webauthn_credential').get() as
    | { n: number }
    | undefined
  return Number(row?.n ?? 0)
}

/** Delete one credential. Returns false when nothing matched. */
export function deleteWebauthnCredential(credId: string): boolean {
  const db = getDb()
  return db.prepare('DELETE FROM webauthn_credential WHERE cred_id = ?').run(credId).changes > 0
}

/**
 * Record the post-assertion facts: last use, the authenticator's sign counter
 * (stored, never compared) and the current backup state — a credential the user
 * later syncs to iCloud flips `backedUp` on a subsequent assertion, and the
 * management UI shows that flag.
 */
export function touchWebauthnCredential(
  credId: string,
  update: { lastUsedAt: number; signCount: number; backedUp: boolean }
): void {
  const db = getDb()
  db.prepare(
    `UPDATE webauthn_credential SET
       last_used_at = ?,
       sign_count   = ?,
       backed_up    = ?
     WHERE cred_id = ?`
  ).run(update.lastUsedAt, update.signCount, update.backedUp ? 1 : 0, credId)
}

/** Rename one credential (`null` clears the nickname). False when no such row. */
export function renameWebauthnCredential(credId: string, nickname: string | null): boolean {
  const db = getDb()
  return (
    db
      .prepare('UPDATE webauthn_credential SET nickname = ? WHERE cred_id = ?')
      .run(nickname, credId).changes > 0
  )
}

// ---------------------------------------------------------------------------
// Audit log repository (SyncCore phase 1 — ADR-051/052, security.md §Audit)
//
// APPEND-ONLY BY CONSTRUCTION, with exactly ONE sanctioned deletion path.
// This module exports `appendAuditLog`, `listAuditLog` and — as of ADR-054
// decision 5 — `pruneAuditLog`. There is still no UPDATE and no row-targeted
// delete: the prune is a MOVING WINDOW keyed on `ts` alone, so it can drop old
// history but can never be aimed at a particular event, which is the property
// that matters for a trail. Retention is uniform (auth rows purge on the same
// window as command rows — the owner considered and declined an auth-forever
// exception) and floors at 30 days.
// ---------------------------------------------------------------------------

/** One audited command dispatch. `kind` is always 'command' today — queries aren't audited. */
export interface AuditLogRow {
  id: number
  ts: number
  /** Per-connection uuid (one per authenticated socket / per desktop app run). */
  connectionId: string
  /** 'token' | 'password' | 'tailnet-identity' | 'desktop'. */
  method: string
  /** Tailnet login when known, else the method name. */
  label: string
  capability: string
  kind: string
  channel: string
  sessionId: string | null
  outcome: 'ok' | 'error'
  /**
   * Explicit INTENT for auth-event rows (ADR-054 decision 5): "passkey login
   * accepted; conferred admin+enroll", "step-up tier medium→strong", "session
   * expired (max-age 4h)". NULL on ordinary command rows, whose channel and
   * capability already say everything there is to say.
   *
   * It exists because `capability` on an `auth:*` row carries a convention a
   * reader has to know (it names what the event is ABOUT, not what the
   * connection held); `detail` removes the need to know it.
   */
  detail: string | null
}

interface AuditLogDbRow {
  id: number
  ts: number
  connection_id: string
  method: string
  label: string
  capability: string
  kind: string
  channel: string
  session_id: string | null
  outcome: string
  detail: string | null
}

function rowToAuditLog(row: AuditLogDbRow): AuditLogRow {
  return {
    id: row.id,
    ts: row.ts,
    connectionId: row.connection_id,
    method: row.method,
    label: row.label,
    capability: row.capability,
    kind: row.kind,
    channel: row.channel,
    sessionId: row.session_id,
    outcome: row.outcome === 'error' ? 'error' : 'ok',
    // In-code COALESCE for a row written before v12.
    detail: row.detail ?? null
  }
}

/**
 * Append one audit row (`id` auto-assigned). The ONLY write path for audit_log.
 *
 * `detail` is optional at the call site so every existing command-path caller
 * keeps compiling unchanged and lands a NULL, which is exactly the value a
 * command row should carry.
 */
export function appendAuditLog(entry: Omit<AuditLogRow, 'id' | 'detail'> & { detail?: string | null }): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO audit_log (
       ts, connection_id, method, label, capability, kind, channel, session_id, outcome, detail
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.ts,
    entry.connectionId,
    entry.method,
    entry.label,
    entry.capability,
    entry.kind,
    entry.channel,
    entry.sessionId ?? null,
    entry.outcome,
    entry.detail ?? null
  )
}

/**
 * Read audit rows newest-first. `before` is an EXCLUSIVE `ts` upper bound, so
 * paging is `before = oldestReturned.ts` (ties at the same millisecond are
 * broken by the descending id, and a page boundary landing inside a tie group
 * is why paging should carry the id once a UI needs it — not yet).
 */
export function listAuditLog(opts: { limit?: number; before?: number } = {}): AuditLogRow[] {
  const db = getDb()
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
  const rows = (
    opts.before === undefined
      ? db.prepare('SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?').all(limit)
      : db
          .prepare('SELECT * FROM audit_log WHERE ts < ? ORDER BY ts DESC, id DESC LIMIT ?')
          .all(opts.before, limit)
  ) as AuditLogDbRow[]
  return rows.map(rowToAuditLog)
}

/**
 * Audit retention (ADR-054 decision 5): a uniform moving purge, default 365
 * days, configurable with a hard 30-day FLOOR.
 *
 * The floor is not decoration. Retention is settable from a web client now
 * (`authcfg:apply`), so "0 days" would otherwise be a one-call erase of
 * the trail that records the erasure — a stepped-up but stolen session must not
 * be able to do that. 30 days is short enough to be a real privacy knob and long
 * enough that an incident is still reconstructable.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365
export const MIN_AUDIT_RETENTION_DAYS = 30

/** Apply the floor (and reject nonsense) to a raw retention value. */
export function clampAuditRetentionDays(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_AUDIT_RETENTION_DAYS
  return Math.max(MIN_AUDIT_RETENTION_DAYS, Math.trunc(raw))
}

/**
 * How often the periodic audit sweep runs. Retention is measured in DAYS, so
 * the cadence only has to be well inside a day for the window to hold on a
 * long-lived desktop session; the sweep also runs once on DB open.
 */
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Delete audit rows older than the configured retention window. Bounded,
 * best-effort, and idempotent (a second call on the same clock deletes nothing)
 * — the M-DB3 usage-prune pattern, applied to the one table ADR-054 gave a
 * retention policy.
 *
 * Reads the window from `remote_config` when the caller does not name one, and
 * ALWAYS through {@link clampAuditRetentionDays}, so no call path can purge
 * below the floor. A config read failure falls back to the default rather than
 * to something aggressive: the failure mode of a wedged config read must be
 * "keep more", never "delete more".
 */
export function pruneAuditLog(now: number = Date.now(), retentionDays?: number): number {
  const db = getDb()
  let days: number
  if (retentionDays !== undefined) {
    days = clampAuditRetentionDays(retentionDays)
  } else {
    try {
      days = getRemoteConfig()?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS
    } catch {
      days = DEFAULT_AUDIT_RETENTION_DAYS
    }
  }
  const cutoff = now - days * MS_PER_DAY
  return db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes
}
