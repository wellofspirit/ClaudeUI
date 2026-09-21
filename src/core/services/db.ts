/**
 * Operational SQLite database — Phase 3a.
 *
 * Single per-OS-user DB at ~/.claude/ui/operational.db.
 * All callers must go through the typed repository API below — never the raw db.
 *
 * ## Storage engine
 *
 * This file no longer names a SQLite implementation. It talks to the DRIVER
 * SEAM (`sqlite-driver.ts`), which the ENTRYPOINT installs: better-sqlite3 on
 * the Electron desktop (unchanged, native, byte-identical), `bun:sqlite` or
 * `node:sqlite` for `claudeui-server`. That indirection is what lets the
 * headless server exist at all — S3 stage 0 established that better-sqlite3
 * cannot run under bun (an uncatchable N-API panic), so a statically-imported
 * native addon here would have made every module that reads this DB — i.e. most
 * of `src/core` — unloadable under the server's runtime. See `sqlite-driver.ts`
 * for the evidence and the driver contract.
 *
 * Isolation: vitest installs a driver backed by an in-memory `node:sqlite`, so
 * tests never load a native .node binary and never touch the real DB file.
 */

import * as fs from 'fs'
import { parseCodexSettings } from '../codex/settings'
import * as path from 'path'
import * as os from 'os'
import { getSqliteDriver, setDbOpenProbe, type SqliteDatabase } from './sqlite-driver'
import type {
  BillingType,
  EngineId,
  ModelRef,
  AccountInfo,
  RemoteAuthPolicy,
  StepUpTier,
  UsageOrigin,
  UsageWindowRow
} from '../../shared/types'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { displayCostFromRow } from '../../shared/cost-rule'
import { ENGINE_META, engineMeta } from '../../shared/engine-meta'
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
  // -- ADR-071 §1, migration v18 ------------------------------------------
  /** Machine-independent account identity (ADR-071 §3). 'unknown' predates the ADR. */
  accountKey: string
  /** What a person calls the account. Display only. */
  accountLabel: string | null
  /** The billing type as it stood when the row was written. */
  billingType: BillingType
  /** Where the turn came from. */
  origin: UsageOrigin
  /** The dispatching or spawning session, for 'child' and 'dispatch' rows. */
  parentRoutingId: string | null
  /** Tokens at list price. Null when the model has no known price. */
  apiCostUsd: number | null
  /** Money that left a wallet. Null when we cannot know. */
  billedCostUsd: number | null
}

/**
 * What a WRITER has to supply. The seven ADR-071 columns are optional here and
 * only here, so that a row built against the pre-v18 shape still compiles down
 * onto its SQL defaults ('unknown' / 'session' / NULL).
 *
 * That is a concession to old test fixtures, NOT a licence for product code:
 * `recordUsageEvent` and the reconciler's row builders pass all seven
 * explicitly, every time, so a new call site cannot quietly skip attribution.
 */
export type UsageEventInsert = Omit<UsageEventRow, keyof UsageEventAttribution> &
  Partial<UsageEventAttribution>

/** The v18 columns, named once so the insert type can make exactly them optional. */
type UsageEventAttribution = Pick<
  UsageEventRow,
  | 'accountKey'
  | 'accountLabel'
  | 'billingType'
  | 'origin'
  | 'parentRoutingId'
  | 'apiCostUsd'
  | 'billedCostUsd'
>

/** One window-utilization sample (feeds WLS apiPercent series + block alignment). */
export interface WindowSampleRow {
  id: string
  ts: number
  /**
   * The Claude account uuid the sample was observed under, and the key the WLS
   * projection still reads by ({@link getWindowSamples}). A vendor with no such
   * uuid — a ChatGPT workspace — carries its `accountKey` here, so the column
   * stays NOT NULL without a second meaning of "none".
   */
  accountUuid: string
  usedPercent: number
  canonicalEnd: number
  /** ADR-071 §3's account key — what makes the reading comparable across machines. */
  accountKey: string
  /** The window's canonical id: `5h`, `7d`, `7d:<model>` (ADR-071 §6). */
  windowKind: string
}

/**
 * The database handle every repository function and every `Migration.up` sees.
 *
 * It used to be inferred from better-sqlite3's constructor; it is the seam's
 * neutral interface now, so a migration body cannot reach for an engine-specific
 * method that only one of the three drivers implements.
 */
export type Db = SqliteDatabase

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  engineId: EngineId
  model?: ModelRef
  /** Tokens the session's native context last held (v24). Codex only, so far:
   *  it is the one engine whose context meter cannot be recomputed from a
   *  history read. Absent on a write MERGES — see {@link setSessionMeta}. */
  contextUsed?: number | null
  /** The model's context window in tokens at that moment (v24), null/absent
   *  when the engine never reported one. */
  contextWindow?: number | null
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
  },
  {
    // v14 — ADR-064: the remote-IDE posture (VS Code `serve-web`, reverse-proxied
    // under `/vscode` behind the new `ide` capability).
    //
    // `allow_ide` is the host-side master switch for that capability, OFF by
    // default. It is the v10 rule verbatim, one capability over: it lives HERE
    // and not in settings.json because `config:save-settings` is remotely
    // reachable (capability `config`), so a settings-blob flag would let a remote
    // client arm its own IDE — which is shell-equivalent authority.
    //
    // `ide_cli_path` is the optional override for WHICH VS Code CLI to spawn, and
    // for it the same table choice is load-bearing in a NEW way. This column is a
    // path the host later EXECUTES. A remotely writable copy of it would not be a
    // policy downgrade, it would be remote code execution by config write — point
    // it at anything on disk and the next mint runs it. So it is written only
    // through the host-anchored `remote:set-config` (pinned `admin`, registered on
    // NEITHER transport), exactly like the toggle beside it, and reads fail closed
    // (`readIdePolicy`).
    //
    // NULLABLE, and null is the normal state: with no override the service
    // detects the CLI itself (PATH, then platform well-knowns), which is what
    // makes the desktop host and the headless `claudeui-server` the same
    // implementation.
    version: 14,
    up(db) {
      db.exec(`
        ALTER TABLE remote_config ADD COLUMN allow_ide INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE remote_config ADD COLUMN ide_cli_path TEXT;
      `)
    }
  },
  {
    version: 15,
    up(db) {
      db.exec(`CREATE TABLE codex_session_overrides (
        session_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
    }
  },
  {
    // v16 — the Codex FORK REGISTRY.
    //
    // `thread/list` never returns a forked thread, so the sidebar has to know
    // about a branch some other way. It used to derive them: every codex id in
    // `session_meta` that the native list omitted got a `thread/read` on every
    // refresh, which after a few deletions is mostly dead ids re-probed forever
    // (an unbounded-in-N sweep, ADR-066 open item). This table is the explicit
    // record instead — written once when `thread/fork` lands, read back as the
    // exact set of ids to probe, and pruned when the binary says the thread is
    // gone for good.
    //
    // `forked_from_id` is the source thread, kept for lineage/debugging (and
    // NULLABLE because the one-time adoption of pre-existing forks can only
    // learn it from the thread itself, which may not carry it).
    version: 16,
    up(db) {
      db.exec(`CREATE TABLE codex_forks (
        thread_id TEXT PRIMARY KEY,
        forked_from_id TEXT,
        created_at INTEGER NOT NULL
      )`)
    }
  },
  {
    // v17 — the fork registry becomes a LINEAGE CACHE.
    //
    // v16 recorded branches only, so a ROOT never earned a row and stayed a
    // candidate for a `thread/read` forever: every delete plan swept the
    // lineage of every codex `session_meta` id the table did not name, and the
    // sweep never shrank (~0.9 s with 25 sessions, ADR-066 open item 3). The
    // table now holds ONE ROW PER THREAD ClaudeUI has asked about, root or
    // branch, and having a row is what stops the next scan re-reading it.
    //
    //  - `forked_from_id` still means lineage, and NULL now means "a root, a
    //    thread with no learnable source, or an id the binary has twice said it
    //    cannot resolve" — the three cases that are alike in the only way any
    //    reader cares about: they are not a branch of anything.
    //  - `verified_at` is the NATIVE `updatedAt` (unix seconds) the lineage was
    //    read at. The launch scan re-reads a thread only when the listing shows
    //    a different one, so an unchanged thread costs nothing after its first
    //    read. NULL means "never verified": a v16 row, or a confirmed-gone id.
    //  - `lineage_checked_at` is the wall clock of that read, for diagnostics.
    //
    // The table KEEPS ITS NAME: `CodexSession` registers a branch it mints
    // through `registerCodexFork` and a rename would be churn in a file this
    // change does not otherwise touch. Existing rows migrate as they are, with
    // `verified_at` NULL so the first scan verifies each one exactly once.
    //
    // The DATA step drops the one-time adoption MARKER (`thread_id = ''`,
    // generation in `forked_from_id`). The cache replaces it: an id with a row
    // is not re-read, which is what the marker was for, without the "have I
    // swept yet" flag that finished wrongly twice.
    version: 17,
    up(db) {
      db.exec(`
        ALTER TABLE codex_forks ADD COLUMN verified_at INTEGER;
        ALTER TABLE codex_forks ADD COLUMN lineage_checked_at INTEGER;
        DELETE FROM codex_forks WHERE thread_id = '';
      `)
    }
  },
  {
    // v18 — ADR-071 §1: usage_event becomes THE ledger.
    //
    // Seven columns, in three groups:
    //
    //  - WHO. `account_key` is the machine-independent account identity (§3),
    //    so the same subscription is one account on every machine and in the
    //    hub; `account_label` is the display half. A row that predates this
    //    migration keeps `'unknown'` and still counts in totals (owner ruling,
    //    2026-09-20) — there is no way to learn after the fact which account
    //    ran it.
    //  - WHAT KIND. `billing_type` is captured AT WRITE TIME, because the
    //    answer changes: the same vendor can be a subscription this week and
    //    an API key the next, and a row priced under one rule must not be
    //    re-read under the other. `origin` and `parent_routing_id` say whether
    //    the turn was the session's own, a subagent's, or dispatched work, and
    //    from where.
    //  - HOW MUCH. `api_cost_usd` and `billed_cost_usd` are cost-rule.ts's two
    //    figures, derived ONCE at write time from `equiv_cost_usd` and
    //    `engine_cost_usd`, which stay exactly as they are: the raw inputs.
    //
    // The backfill fills `api_cost_usd` with the row's best LIST-PRICE figure.
    // For most engines that is `equiv_cost_usd`. For a CLAUDE row it is
    // `engine_cost_usd` when there is one: both of a Claude row's figures are
    // equivalents (cli.js reports an equivalent whatever the plan, ADR-034),
    // and the engine one is the precise of the two — it prices the 1h cache
    // tier, where the table figure treats every cache write as 5m. That is
    // also the figure `selectRowCostUsd` shows today, so switching the
    // dashboard to this column cannot move a historical total. The live Claude
    // row builders apply the same rule (usage-recorder's backfillAttribution).
    //
    // `billed_cost_usd` stays NULL on every migrated row: the billing type of
    // an old row is not known, and NULL is how this schema says unknown
    // (ADR-030). It is never summed as zero.
    version: 18,
    up(db) {
      db.exec(`
        ALTER TABLE usage_event ADD COLUMN account_key TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE usage_event ADD COLUMN account_label TEXT;
        ALTER TABLE usage_event ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE usage_event ADD COLUMN origin TEXT NOT NULL DEFAULT 'session';
        ALTER TABLE usage_event ADD COLUMN parent_routing_id TEXT;
        ALTER TABLE usage_event ADD COLUMN api_cost_usd REAL;
        ALTER TABLE usage_event ADD COLUMN billed_cost_usd REAL;
        CREATE INDEX IF NOT EXISTS idx_usage_event_account_key_ts
          ON usage_event(account_key, ts);
        UPDATE usage_event SET api_cost_usd = CASE
          WHEN engine_id = 'claude' AND engine_cost_usd IS NOT NULL AND engine_cost_usd > 0
            THEN engine_cost_usd
          ELSE equiv_cost_usd
        END;
      `)
    }
  },
  {
    // v19 — ADR-071 §1: the dispatched turns already on disk become ledger
    // rows, so the ledger is the whole history and not just what was recorded
    // after S2c shipped. One `usage_event` row per `dispatched_usage` row,
    // `origin = 'dispatch'`.
    //
    // `dispatched_usage` is NOT dropped and nothing stops writing it: its
    // readers (the session breakdown and the dashboard's Delegated section)
    // move in S2c2, which is also when this table goes.
    //
    // WHAT IS COPIED, and what deliberately is not:
    //
    //  - TOKENS STAY 0. The old table recorded one TOTAL and no split, and
    //    there is no honest column to put a total in — `input_tokens` would
    //    claim the whole turn was prompt. A gap is better than a lie, so the
    //    total is recorded nowhere. S2c2's readers must therefore NOT read a
    //    zero split as "this turn was free"; the cost columns are what these
    //    rows carry.
    //  - `api_cost_usd` takes `cost_usd`, which is what the dispatcher's own
    //    cost rule resolved for the turn (ADR-071 §2's display figure).
    //    `billed_cost_usd` stays NULL: the billing type of a dispatched turn
    //    was never recorded, and NULL is how this schema says unknown.
    //  - `equiv_cost_usd` and `engine_cost_usd` stay NULL. Both are RAW
    //    ENGINE INPUTS, and `cost_usd` is neither — it is already a resolved
    //    figure. Leaving them null also keeps `selectRowCostUsd` (which today
    //    reads exactly those two) returning 0 for these rows, so copying
    //    history cannot move a figure the dashboard shows before S2c2 moves
    //    its readers deliberately.
    //  - `account_key` and `billing_type` are `'unknown'`: which account ran a
    //    past dispatched turn cannot be learned after the fact (owner ruling,
    //    2026-09-20 — such rows still count in totals).
    //  - `parent_routing_id` takes `from_routing_id`, the column that means
    //    the same thing. `SessionManager.rekey()` already renames both.
    //
    // The vendor and the model come from `target_model` the way the dispatcher
    // parses it (`engineMeta(engine).decodeModelValue`): Claude and Codex
    // encode the bare model id under a fixed vendor; opencode and pi encode
    // `<vendor>/<model>` and split on the FIRST slash, falling back to the
    // engine's default vendor when there is none.
    //
    // `INSERT OR IGNORE` + the `message_id` UNIQUE make a second pass a no-op.
    version: 19,
    up(db) {
      // Every arm is keyed on the ENGINE first, mirroring `dispatchModelRef`:
      // only opencode and pi encode a vendor in the model string at all, so an
      // engine this build does not know is `unknown` whether or not its model
      // happens to contain a slash.
      const vendorSql = `CASE
        WHEN d.target_engine = 'claude' THEN 'anthropic'
        WHEN d.target_engine = 'codex' THEN 'openai'
        WHEN d.target_engine IN ('opencode', 'pi') AND instr(d.target_model, '/') > 0
          THEN substr(d.target_model, 1, instr(d.target_model, '/') - 1)
        WHEN d.target_engine = 'opencode' THEN 'opencode'
        WHEN d.target_engine = 'pi' THEN 'openai-codex'
        ELSE 'unknown'
      END`
      const modelSql = `CASE
        WHEN d.target_engine IN ('opencode', 'pi') AND instr(d.target_model, '/') > 0
          THEN substr(d.target_model, instr(d.target_model, '/') + 1)
        ELSE d.target_model
      END`
      db.exec(`
        INSERT OR IGNORE INTO usage_event (
          id, ts, engine_id, vendor_id, account_id, account_uuid, model_id,
          input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
          cache_read_tokens, equiv_cost_usd, engine_cost_usd,
          session_id, message_id, source,
          account_key, account_label, billing_type, origin, parent_routing_id,
          api_cost_usd, billed_cost_usd
        )
        SELECT
          'dispatched:' || d.id,
          d.ts,
          d.target_engine,
          ${vendorSql},
          NULL,
          NULL,
          ${modelSql},
          0, 0, 0, 0, 0,
          NULL,
          NULL,
          d.target_session_id,
          'dispatched:' || d.id,
          'backfill',
          'unknown',
          NULL,
          'unknown',
          'dispatch',
          d.from_routing_id,
          d.cost_usd,
          NULL
        FROM dispatched_usage d;
      `)
    }
  },
  {
    // v20 — ADR-071 §1: the ledger is the only STORE, and `usage_bucket`
    // replaces `daily_usage`.
    //
    // Three acts, in this order, because each needs the tables the next one
    // removes:
    //
    //  1. DELETE the reconciler's duplicates of dispatched opencode turns.
    //  2. CREATE `usage_bucket` and seed it from `daily_usage`.
    //  3. DROP `daily_usage` and `dispatched_usage`.
    //
    // 1. THE DUPLICATES. Until S2c the opencode reconciler imported the
    // throwaway sessions the DISPATCHER creates as if they were the user's
    // own, so every dispatched opencode turn older than that is in the ledger
    // twice: once as an `origin 'session'` row under opencode's own message
    // id, and once as v19's `dispatched:<id>` copy of the same turn (the two
    // even share a `session_id`). The old dashboard double counted them too —
    // once in the per-engine total, once in the Delegated section — and this
    // slice's readers, which count `dispatch` rows in the same totals, would
    // keep doing it. The `dispatched:` copy is the one kept: it carries
    // `parent_routing_id` (which session delegated the work) and the
    // dispatcher's own resolved cost; the reconciler's copy has neither.
    //
    // 2. THE BUCKETS. Hourly and in UTC so a reader in any timezone can group
    // them into local days and ADR-072's hub can hold the same table. `rev` is
    // the hub's pull cursor: every write stamps the rows it replaces with one
    // fresh, monotonically increasing number (see `nextUsageBucketRev`).
    // `unknown_api_cost_count` and `unknown_billed_cost_count` are how a sum
    // says what is MISSING from it rather than absorbing an unknown as zero
    // (ADR-030).
    //
    // `unbilled_api_cost_usd` is what makes an hour's display cost equal the
    // sum of its rows' display costs. The per-row rule under `apiKey` and
    // `unknown` is `billed ?? api`, so an hour mixing turns that reported a
    // charge with turns that did not cannot be resolved from two sums alone:
    // `billed_cost_usd` leaves the unbilled turns out and `api_cost_usd`
    // double counts the billed ones. This column carries exactly the `api`
    // half of that `??` — the API-equivalent of the rows with no known bill —
    // so `billed_cost_usd + unbilled_api_cost_usd` IS Σ(billed ?? api).
    //
    // Each `daily_usage` row becomes ONE bucket at 12:00 UTC of its date. The
    // old table recorded no account, no billing type and no origin, so those
    // are `unknown`/`unknown`/`session`, and its one cost is an API-equivalent
    // (`selectRowCostUsd`'s figure): `billed_cost_usd` is 0 with every request
    // counted as an unknown bill — never a claimed zero — and the whole figure
    // is `unbilled_api_cost_usd`, since not one of the day's bills is known.
    // `rev` 1 is the first revision — nothing has pulled these yet, and the
    // counter starts at 2.
    //
    // MIDDAY IS NOT ALWAYS THE RIGHT LOCAL DAY. 12:00 UTC falls inside the
    // local day the row was bucketed by from UTC-12 to UTC+12, and ADR-071 §1
    // chose it for that. At UTC+13/+14 (Chatham, Kiritimati, Samoa in summer)
    // it lands in the NEXT local day, so a migrated day shows up shifted by
    // one there, and a day the rollup rebuilds retires its neighbour's seed
    // rather than its own. Accepted: it affects migrated days only, the shift
    // is one day, and the alternative — a per-timezone seed instant — would
    // bake THIS machine's zone into a table ADR-072 shares between machines.
    //
    // A `date` SQLite cannot parse yields a NULL instant; such a row is
    // skipped rather than allowed to fail the whole migration, since its day
    // is unrecoverable either way.
    //
    // The two `usage_event` indexes come with the READERS this slice moves
    // here: the Delegated section scans by `origin`, and the per-session
    // dispatched-cost breakdown — which runs on every session construction —
    // looks a routing id up. `dispatched_usage` had an index for each; the
    // ledger needs the same two or both reads become full scans of a table
    // three orders of magnitude bigger.
    version: 20,
    up(db) {
      db.exec(`
        DELETE FROM usage_event
        WHERE origin = 'session'
          AND engine_id = 'opencode'
          AND session_id IN (
            SELECT DISTINCT target_session_id FROM dispatched_usage
            WHERE target_engine = 'opencode' AND target_session_id IS NOT NULL
          );

        CREATE TABLE IF NOT EXISTS usage_bucket (
          hour_utc                  INTEGER NOT NULL,
          account_key               TEXT NOT NULL,
          billing_type              TEXT NOT NULL,
          engine_id                 TEXT NOT NULL,
          vendor_id                 TEXT NOT NULL,
          model_id                  TEXT NOT NULL,
          origin                    TEXT NOT NULL,
          input_tokens              INTEGER NOT NULL DEFAULT 0,
          output_tokens             INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens        INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens         INTEGER NOT NULL DEFAULT 0,
          api_cost_usd              REAL NOT NULL DEFAULT 0,
          billed_cost_usd           REAL NOT NULL DEFAULT 0,
          unbilled_api_cost_usd     REAL NOT NULL DEFAULT 0,
          unknown_api_cost_count    INTEGER NOT NULL DEFAULT 0,
          unknown_billed_cost_count INTEGER NOT NULL DEFAULT 0,
          request_count             INTEGER NOT NULL DEFAULT 0,
          source                    TEXT NOT NULL DEFAULT 'rollup',
          rev                       INTEGER NOT NULL,
          PRIMARY KEY (hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_bucket_rev ON usage_bucket(rev);
        CREATE INDEX IF NOT EXISTS idx_usage_bucket_hour ON usage_bucket(hour_utc);

        CREATE TABLE IF NOT EXISTS usage_bucket_rev (
          id       INTEGER PRIMARY KEY CHECK (id = 1),
          next_rev INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO usage_bucket_rev (id, next_rev) VALUES (1, 2);

        CREATE INDEX IF NOT EXISTS idx_usage_event_origin_ts
          ON usage_event(origin, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_event_parent_routing
          ON usage_event(parent_routing_id);

        INSERT INTO usage_bucket (
          hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin,
          input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
          cache_read_tokens, api_cost_usd, billed_cost_usd, unbilled_api_cost_usd,
          unknown_api_cost_count, unknown_billed_cost_count,
          request_count, source, rev
        )
        SELECT
          CAST(strftime('%s', d.date || ' 12:00:00') AS INTEGER) * 1000,
          'unknown', 'unknown',
          d.engine_id, d.vendor_id, d.model_id, 'session',
          d.input_tokens, d.output_tokens, d.cache_write_tokens, 0, d.cache_read_tokens,
          d.cost_usd, 0, d.cost_usd,
          0, d.request_count,
          d.request_count, 'seed', 1
        FROM daily_usage d
        WHERE strftime('%s', d.date || ' 12:00:00') IS NOT NULL;

        DROP TABLE daily_usage;
        DROP TABLE dispatched_usage;
      `)
    }
  },
  {
    // v21 — ADR-071 §6: one limits provider per vendor, and the readings are kept.
    //
    // THE ACCOUNT'S IDENTITY. `~/.claude.json` describes the ACTIVE account and
    // nothing else, so an account the limits provider only holds credentials
    // for has nothing to key its reading by. The four columns are that identity,
    // learned while the account IS active (`UsageFetcher.trackActiveAccount`)
    // and kept for when it is not. They are nullable on purpose: an account that
    // has not been active since this shipped has never been observed, and a
    // guess would mint an account key that names the wrong subscription.
    //
    // THE READINGS. `usage_window_sample` stops being the active Claude
    // account's 5-hour series and becomes every account's series for every
    // window kind, so it needs both halves of that identity. Existing rows are
    // exactly what the column defaults say — the active account's 5-hour
    // samples — except for the account half, which SQL cannot recover: the key
    // lives in the account LOG (`account-log.jsonl`, resolved by
    // `claudeAccountAttribution` against each row's timestamp), not in any
    // table. They stay at `unknown` and stay usable, because the WLS projection
    // reads them by `account_uuid` and that column is untouched.
    //
    // The index is the `refresh: false` read: newest sample per window kind for
    // one account key, which is what an INACTIVE account's limits are answered
    // from when no token may be spent.
    version: 21,
    up(db) {
      db.exec(`
        ALTER TABLE account ADD COLUMN account_uuid TEXT;
        ALTER TABLE account ADD COLUMN organization_uuid TEXT;
        ALTER TABLE account ADD COLUMN organization_name TEXT;
        ALTER TABLE account ADD COLUMN billing_type TEXT;

        ALTER TABLE usage_window_sample ADD COLUMN account_key TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE usage_window_sample ADD COLUMN window_kind TEXT NOT NULL DEFAULT '5h';

        CREATE INDEX IF NOT EXISTS idx_window_sample_key_kind_ts
          ON usage_window_sample(account_key, window_kind, ts);
      `)
    }
  },
  {
    // v22 — ADR-071 §7: the window-value ledger.
    //
    // One row per `(account_key, window_kind, canonical_end)`: the highest
    // utilization the account ever reported for that window, beside what the
    // ledger saw the account spend INSIDE it. Dividing the two is how the
    // dashboard answers what a subscription is worth, and the ADR states the
    // bias up front — the percent is the account's GLOBAL utilization while the
    // dollars are only what this machine saw, so usage on another machine or in
    // claude.ai pushes the percent up without adding dollars and the implied
    // value reads low.
    //
    // NOT BUILT ON `usage_bucket`. The buckets are hourly; a canonical window
    // end is not hour-aligned (ends at :40 past the hour are ordinary — see
    // `usage-windows.ts`), so the bucket containing a boundary straddles it and
    // cannot be split. The numerator sums `usage_event` directly, which v18's
    // `(account_key, ts)` index serves.
    //
    // THE SEED. Every window the persisted samples already name gets a row with
    // its peak, OPEN and with zero sums: the first recompute fills the sums, and
    // closes only the windows whose end is more than `WINDOW_CLOSE_GRACE_MS`
    // past — turns arrive with historical timestamps. `unknown` is excluded — it is the
    // shared bucket every pre-v21 sample landed in, so a peak taken over it
    // would be the maximum across all accounts at once, and its ledger sum
    // would be everything nothing could attribute.
    //
    // `window_start` is restated as SQL here because a migration cannot call
    // into TypeScript. `windowDurationMs` in `usage-window-ledger.ts` is the one
    // statement of the rule, and every seeded row's start is rewritten from it
    // by the first recompute, since seeded rows are open.
    version: 22,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_window (
          account_key        TEXT    NOT NULL,
          window_kind        TEXT    NOT NULL,
          canonical_end      INTEGER NOT NULL,
          window_start       INTEGER NOT NULL,
          peak_percent       REAL    NOT NULL DEFAULT 0,
          api_cost_usd       REAL    NOT NULL DEFAULT 0,
          billed_cost_usd    REAL    NOT NULL DEFAULT 0,
          unknown_cost_count INTEGER NOT NULL DEFAULT 0,
          input_tokens       INTEGER NOT NULL DEFAULT 0,
          output_tokens      INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
          sample_count       INTEGER NOT NULL DEFAULT 0,
          closed             INTEGER NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_key, window_kind, canonical_end)
        );

        CREATE INDEX IF NOT EXISTS idx_usage_window_open
          ON usage_window(closed, canonical_end);
        CREATE INDEX IF NOT EXISTS idx_usage_window_end
          ON usage_window(canonical_end);

        INSERT OR IGNORE INTO usage_window (
          account_key, window_kind, canonical_end, window_start,
          peak_percent, sample_count, closed, updated_at
        )
        SELECT
          account_key,
          window_kind,
          canonical_end,
          canonical_end - CASE WHEN window_kind = '5h' THEN 18000000 ELSE 604800000 END,
          MAX(used_percent),
          COUNT(*),
          0,
          0
        FROM usage_window_sample
        WHERE account_key <> 'unknown'
        GROUP BY account_key, window_kind, canonical_end;
      `)
    }
  },
  {
    // v23 — S2e: the four identity columns were read off the WRONG file.
    //
    // `UsageFetcher` learned an account's uuid / organization / billing type
    // from `~/.claude.json` (v21) and stamped them onto whichever dir was
    // active. But that file is SHARED — one copy for every account dir and for
    // the terminal `claude` — and cli.js rewrites its `oauthAccount` only when
    // it refetches the profile, so the block names whichever cli.js process
    // refetched last. On a machine with two accounts the active dir routinely
    // carries the other account's identity, and the other dir carries NULLs.
    //
    // So none of the four is trustworthy on any row, and there is no way to
    // tell the right ones from the wrong ones. They are cleared. The ACTIVE dir
    // is re-stamped at the next boot from its OWN credential (through
    // `/api/oauth/profile`), and an inactive dir on the next refresh the user
    // asks for — never on a timer, because reading one spends a refresh grant
    // (ADR-071 §6). `identity_checked_at` is when that last succeeded, so a
    // credential file newer than it means a re-login and a re-read.
    //
    // `email`, `subscription_type` and `organization` are LEFT ALONE: those
    // come from cli.js's own login control response for that dir
    // (`AccountManager.noteLogin`), which was always per-account and correct.
    //
    // THE MARKER. Every Claude ledger row written since the stale attribution
    // began is keyed to the wrong subscription, and no row carries a dir id to
    // repair by — only a time-bounded re-key against the account log is
    // possible (`claude-account-identity.ts`). It runs once, at the first boot
    // that can resolve the active dir, and `meta` is where "once" is recorded:
    // a two-column key/value table, because a one-off marker does not deserve a
    // schema of its own and the next one will not either.
    version: 23,
    up(db) {
      db.exec(`
        ALTER TABLE account ADD COLUMN identity_checked_at INTEGER;

        UPDATE account SET
          account_uuid      = NULL,
          organization_uuid = NULL,
          organization_name = NULL,
          billing_type      = NULL;

        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO meta (key, value)
          VALUES ('claude_identity_repair', 'pending');
      `)
    }
  },
  {
    // v24 — ADR-071 §2: the context window a cold Codex line cannot recompute.
    //
    // Every other engine derives its context meter from something a history
    // read can see again: opencode and pi from the last stored turn's prompt
    // against a catalog window. Codex publishes neither half. The window size
    // arrives ONLY on `thread/tokenUsage/updated` (`modelContextWindow`) — the
    // model catalog carries none and `thread/read` returns no usage at all —
    // and the consumption is that frame's `last.totalTokens`, which is the
    // native context after compaction rather than a sum of the turns.
    //
    // So the two are RECORDED as they stream past, on the one row that already
    // exists per session. Nullable: a session that predates this, or one that
    // has never metered, simply has no reading, and `size 0` is how the status
    // line already spells an unknown window.
    version: 24,
    up(db) {
      db.exec(`
        ALTER TABLE session_meta ADD COLUMN context_used INTEGER;
        ALTER TABLE session_meta ADD COLUMN context_window INTEGER;
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

// Let the driver seam see whether a handle is live, so `setSqliteDriver` can
// refuse an engine swap under an open DB. A function reference rather than an
// import back into this module, so the two files stay acyclic.
setDbOpenProbe(() => _db !== null)

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

  const db = getSqliteDriver().open(DB_PATH)
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
// consistent snapshot. We open read-only, never write. This lives in db.ts so that
// SQLite access has one importer of the driver seam (ADR-020) — the foreign read
// then runs on whichever engine the entrypoint installed, like everything else.

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
    foreign = getSqliteDriver().open(opencodeDbPath, { readonly: true, fileMustExist: true })
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
  context_used: number | null
  context_window: number | null
  updated_at: number
}

function rowToMeta(row: SessionMetaRow): SessionMeta {
  const engineId: EngineId =
    row.engine_id === 'opencode' || row.engine_id === 'pi' || row.engine_id === 'codex'
      ? row.engine_id
      : 'claude'
  // Spread only when read: this map is also the renderer's `sessionEngines`
  // payload, and a session that never metered should not carry two null keys
  // into it (nor round-trip them back through `saveSessionConfig`).
  const context = {
    ...(row.context_used != null ? { contextUsed: row.context_used } : {}),
    ...(row.context_window != null ? { contextWindow: row.context_window } : {})
  }
  if (row.model_id != null) {
    return {
      engineId,
      model: {
        engineId,
        // Legacy-row hydration fallback: rows written before vendor_id tracking
        // have no persisted vendor, so fall back to the engine's historical default.
        vendorId: row.vendor_id ?? engineMeta(engineId).defaultVendorId,
        modelId: row.model_id
      },
      ...context
    }
  }
  return { engineId, ...context }
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
    SessionMetaRow | undefined
  return row ? rowToMeta(row) : undefined
}

/** Explicit accepted native choices, independent of client-projected session_meta deletion. */
export function getCodexSessionOverrides(sessionId: string, db: Db = getDb()): unknown {
  const row = db
    .prepare('SELECT settings_json FROM codex_session_overrides WHERE session_id = ?')
    .get(sessionId) as { settings_json: string } | undefined
  if (!row) return undefined
  try {
    return JSON.parse(row.settings_json)
  } catch {
    throw new Error('Saved Codex session overrides are invalid')
  }
}

export function setCodexSessionOverrides(
  sessionId: string,
  settings: import('../../shared/codex-types').CodexSettings,
  db: Db = getDb()
): void {
  const parsed = parseCodexSettings(settings)
  db.prepare(
    `INSERT INTO codex_session_overrides (session_id, settings_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
  ).run(sessionId, JSON.stringify(parsed), Date.now())
}

export function ensureCodexSessionOverrides(sessionId: string, db: Db = getDb()): void {
  db.prepare(
    'INSERT OR IGNORE INTO codex_session_overrides (session_id, settings_json, updated_at) VALUES (?, ?, ?)'
  ).run(sessionId, '{}', Date.now())
}

export function hasCodexSessionOverrides(sessionId: string, db: Db = getDb()): boolean {
  return (
    db.prepare('SELECT 1 FROM codex_session_overrides WHERE session_id = ?').get(sessionId) !==
    undefined
  )
}

export function deleteCodexSessionOverrides(sessionId: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM codex_session_overrides WHERE session_id = ?').run(sessionId)
}

// ---------------------------------------------------------------------------
// Codex lineage cache (v16 table, generalised in v17) — see that migration's
// comment for the why.
// ---------------------------------------------------------------------------

/** One registered branch: the forked thread and the thread it was cut from. */
export interface CodexFork {
  threadId: string
  forkedFromId: string | null
}

/**
 * One cached thread: its lineage, and the native `updatedAt` that lineage was
 * read at.
 *
 * `forkedFromId === null` is a root, a thread whose source cannot be learned,
 * or an id the binary has twice refused — see the v17 migration. `verifiedAt`
 * is what makes the launch scan incremental: a listed thread whose `updatedAt`
 * still equals it needs no `thread/read` at all. `null` means the row has never
 * been verified (a v16 row, or a confirmed-gone id).
 */
export interface CodexLineage extends CodexFork {
  verifiedAt: number | null
}

/**
 * Record a `thread/fork` result. First registration wins — a later resume of
 * the same branch must not rewrite its lineage or duplicate the row.
 *
 * The row it writes is UNVERIFIED (`verified_at` null): ClaudeUI learned this
 * lineage from the fork call, not from a `thread/read`, so the next scan reads
 * the thread once and fills in the `updatedAt` that stops it reading it again.
 */
export function registerCodexFork(
  threadId: string,
  forkedFromId: string | null,
  db: Db = getDb()
): void {
  if (!threadId) return
  db.prepare(
    'INSERT OR IGNORE INTO codex_forks (thread_id, forked_from_id, created_at) VALUES (?, ?, ?)'
  ).run(threadId, forkedFromId, Date.now())
}

/**
 * Record what a `thread/read` said about one thread — the LINEAGE SCAN's only
 * writer.
 *
 * Unlike {@link registerCodexFork} this REPLACES what the row held: the read is
 * the authority (a fork registered at mint time carries no `verifiedAt`, and a
 * thread the binary has twice refused becomes `(null, null)` — a tombstone that
 * is not a branch, is not listed, and is never read again unless the native
 * listing carries it once more).
 */
export function recordCodexLineage(
  threadId: string,
  forkedFromId: string | null,
  verifiedAt: number | null,
  db: Db = getDb()
): void {
  if (!threadId) return
  db.prepare(
    `INSERT INTO codex_forks (thread_id, forked_from_id, created_at, verified_at, lineage_checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       forked_from_id     = excluded.forked_from_id,
       verified_at        = excluded.verified_at,
       lineage_checked_at = excluded.lineage_checked_at`
  ).run(threadId, forkedFromId, Date.now(), verifiedAt, Date.now())
}

/**
 * Every cached BRANCH, oldest first: the rows the sidebar's unlisted-fork read
 * and every delete plan are built from.
 *
 * Rows with no lineage are excluded here rather than at the call sites, because
 * "not a branch of anything" is the one thing a root, an unknowable source and
 * a tombstone have in common, and no reader of this function wants any of them.
 */
export function listCodexForks(db: Db = getDb()): CodexFork[] {
  return (
    db
      .prepare(
        `SELECT thread_id, forked_from_id FROM codex_forks
         WHERE forked_from_id IS NOT NULL AND forked_from_id <> thread_id
         ORDER BY created_at, thread_id`
      )
      .all() as Array<{ thread_id: string; forked_from_id: string | null }>
  ).map((row) => ({ threadId: row.thread_id, forkedFromId: row.forked_from_id }))
}

/** Every cached thread, branch or not — the scan's "what do I already know?". */
export function listCodexLineage(db: Db = getDb()): CodexLineage[] {
  return (
    db
      .prepare(
        'SELECT thread_id, forked_from_id, verified_at FROM codex_forks ORDER BY created_at, thread_id'
      )
      .all() as Array<{
      thread_id: string
      forked_from_id: string | null
      verified_at: number | null
    }>
  ).map((row) => ({
    threadId: row.thread_id,
    forkedFromId: row.forked_from_id,
    verifiedAt: row.verified_at
  }))
}

/** Forget one thread entirely — for a thread ClaudeUI has just deleted. */
export function deleteCodexFork(threadId: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM codex_forks WHERE thread_id = ?').run(threadId)
}

/**
 * Insert or replace session metadata for a session ID.
 *
 * The engine and the model are REPLACED — the caller that writes them always
 * knows the whole answer. The two context columns (v24) are MERGED instead:
 * they are written by the metering path and by nothing else, so a model write
 * from the sidebar's adoption pass or from the renderer's config round-trip
 * must leave the session's last context reading where it is. The cost of that
 * is that a reading cannot be cleared back to NULL, which nothing needs.
 */
export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO session_meta
       (session_id, engine_id, vendor_id, model_id, context_used, context_window, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       engine_id      = excluded.engine_id,
       vendor_id      = excluded.vendor_id,
       model_id       = excluded.model_id,
       context_used   = COALESCE(excluded.context_used, session_meta.context_used),
       context_window = COALESCE(excluded.context_window, session_meta.context_window),
       updated_at     = excluded.updated_at`
  ).run(
    sessionId,
    meta.engineId,
    meta.model?.vendorId ?? null,
    meta.model?.modelId ?? null,
    meta.contextUsed ?? null,
    meta.contextWindow ?? null,
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
    SessionMetaRow | undefined

  if (existing) {
    db.prepare(
      `INSERT INTO session_meta
         (session_id, engine_id, vendor_id, model_id, context_used, context_window, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         engine_id      = excluded.engine_id,
         vendor_id      = excluded.vendor_id,
         model_id       = excluded.model_id,
         context_used   = COALESCE(excluded.context_used, session_meta.context_used),
         context_window = COALESCE(excluded.context_window, session_meta.context_window),
         updated_at     = excluded.updated_at`
      // The rekey CARRIES the context reading: it is the same session under a
      // new id, and dropping it would blank the meter of a session that has
      // already metered a turn.
    ).run(
      newId,
      existing.engine_id,
      existing.vendor_id,
      existing.model_id,
      existing.context_used,
      existing.context_window,
      Date.now()
    )
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
 * Recognized engine IDs are preserved. Unknown legacy IDs retain the existing clamp.
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
    // Do not infer recovery of previously clamped rows from model names.
    const engineId: EngineId =
      entry.engineId === 'claude' ||
      entry.engineId === 'opencode' ||
      entry.engineId === 'pi' ||
      entry.engineId === 'codex'
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
  account_uuid: string | null
  organization_uuid: string | null
  organization_name: string | null
  billing_type: string | null
  identity_checked_at: number | null
}

function rowToAccountInfo(row: AccountRow): AccountInfo {
  return {
    id: row.id,
    email: row.email,
    subscriptionType: row.subscription_type,
    organization: row.organization,
    createdAt: row.created_at,
    accountUuid: row.account_uuid,
    organizationUuid: row.organization_uuid,
    organizationName: row.organization_name,
    billingType: (row.billing_type as BillingType | null) ?? null,
    identityCheckedAt: row.identity_checked_at
  }
}

/** Return all accounts from the DB, ordered by created_at ascending. */
export function getAllAccounts(): AccountInfo[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM account ORDER BY created_at ASC').all() as AccountRow[]
  return rows.map(rowToAccountInfo)
}

/**
 * One account row by its local id, or null.
 *
 * A targeted read rather than a scan of {@link getAllAccounts}, because the
 * usage poll asks for the ACTIVE dir's row on every pass — it is where the
 * login-captured `organization` display name lives, and the profile endpoint
 * does not return one (S2e).
 */
export function getAccount(id: string): AccountInfo | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM account WHERE id = ?').get(id) as AccountRow | undefined
  return row ? rowToAccountInfo(row) : null
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

/**
 * Record what an account's credentials actually name (ADR-071 §6, S2e).
 *
 * The identity comes from a `/api/oauth/profile` read of THAT dir's own
 * credential — never from the shared `~/.claude.json`, which names whichever
 * cli.js process refetched last (migration v23 says what that cost). It is
 * written while the account is active, and on demand for a stored one, so the
 * limits provider can key a reading without making the account active.
 *
 * `identity_checked_at` is stamped with it: a credentials file newer than this
 * instant means a re-login, which is the one thing that invalidates the four.
 * A no-op when the id names no row: only a local multi-account dir has one.
 */
export function updateAccountIdentity(
  id: string,
  identity: {
    accountUuid: string
    organizationUuid?: string | undefined
    organizationName?: string | undefined
    billingType?: BillingType | undefined
  },
  checkedAt: number = Date.now()
): void {
  const db = getDb()
  db.prepare(
    `UPDATE account
        SET account_uuid        = ?,
            organization_uuid   = ?,
            organization_name   = ?,
            billing_type        = ?,
            identity_checked_at = ?
      WHERE id = ?`
  ).run(
    identity.accountUuid,
    identity.organizationUuid ?? null,
    identity.organizationName ?? null,
    identity.billingType ?? null,
    checkedAt,
    id
  )
}

// ---------------------------------------------------------------------------
// Key/value marker table (migration v23)
// ---------------------------------------------------------------------------

/** One durable marker, or null when it was never written. */
export function getMeta(key: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

/** Write (or overwrite) one durable marker. */
export function setMeta(key: string, value: string): void {
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}

/** Forget one durable marker. Nothing in production does; tests and repairs may. */
export function deleteMeta(key: string): void {
  const db = getDb()
  db.prepare('DELETE FROM meta WHERE key = ?').run(key)
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
  account_key: string
  account_label: string | null
  billing_type: string
  origin: string
  parent_routing_id: string | null
  api_cost_usd: number | null
  billed_cost_usd: number | null
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
    source: row.source as 'live' | 'backfill',
    accountKey: row.account_key,
    accountLabel: row.account_label,
    // Both are stored strings, so a row written by a newer build (or hand-
    // edited) can carry a value this build has no name for. cost-rule.ts's
    // `default` branch is the conservative fallback for exactly that.
    billingType: row.billing_type as BillingType,
    origin: row.origin as UsageOrigin,
    parentRoutingId: row.parent_routing_id,
    apiCostUsd: row.api_cost_usd,
    billedCostUsd: row.billed_cost_usd
  }
}

const INSERT_USAGE_EVENT_SQL = `
  INSERT INTO usage_event (
    id, ts, engine_id, vendor_id, account_id, account_uuid,
    model_id, input_tokens, output_tokens,
    cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
    equiv_cost_usd, engine_cost_usd,
    session_id, message_id, source,
    account_key, account_label, billing_type, origin, parent_routing_id,
    api_cost_usd, billed_cost_usd
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(message_id) DO NOTHING
`

/** The bound parameters for {@link INSERT_USAGE_EVENT_SQL}, in column order. */
function usageEventParams(event: UsageEventInsert): unknown[] {
  return [
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
    event.source,
    // The three NOT NULL v18 columns mirror their SQL defaults here rather
    // than relying on them, so one statement covers every writer.
    event.accountKey ?? UNKNOWN_ACCOUNT_KEY,
    event.accountLabel ?? null,
    event.billingType ?? 'unknown',
    event.origin ?? 'session',
    event.parentRoutingId ?? null,
    event.apiCostUsd ?? null,
    event.billedCostUsd ?? null
  ]
}

/**
 * Insert a single usage event. Idempotent on message_id — duplicate inserts
 * (live turn + reconciler for the same turn) are silently dropped.
 */
export function insertUsageEvent(event: UsageEventInsert): void {
  const db = getDb()
  db.prepare(INSERT_USAGE_EVENT_SQL).run(...usageEventParams(event))
}

/**
 * Batch-insert usage events. Each event is inserted idempotently; the batch
 * runs in a single transaction for efficiency.
 */
export function insertUsageEvents(events: UsageEventInsert[]): void {
  if (events.length === 0) return
  const db = getDb()
  const stmt = db.prepare(INSERT_USAGE_EVENT_SQL)
  // Wrap in a manual BEGIN/COMMIT for bulk efficiency. This is the same pattern
  // the reconciler will use in Pass 2 (bulk JSONL backfill).
  db.prepare('BEGIN').run()
  try {
    for (const event of events) stmt.run(...usageEventParams(event))
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
    UsageEventDbRow | undefined
  return row ? rowToUsageEvent(row) : undefined
}

/**
 * Retrieve all usage events with ts >= cutoff, ordered by ts ascending.
 * This is the source for the SQL-backed dashboard aggregation (Pass 2): the
 * block-grouping walk consumes a chronologically-sorted list, exactly like the
 * old JSONL scan did. Optionally filter by engineId.
 *
 * EVERY origin, dispatched turns included (ADR-071 §1): delegated work spends
 * the same account and the same rate-limit window as a session's own turn, and
 * the dashboard counts it. A caller that wants only one kind filters on
 * `origin` itself — there is no second, narrower reader to pick by accident.
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

/**
 * The newest label each account key was last written under.
 *
 * `usage_bucket` carries no label — it is keyed by the machine-independent
 * account key and nothing else (ADR-071 §1), so the dashboard has to name its
 * accounts from somewhere. This is the second source it tries, after the limits
 * providers: a key this machine no longer holds credentials for still has the
 * email or the `<vendor> key …abcd` that the turns which spent it recorded.
 *
 * NEWEST, not any: a label is display-only and can change (an account renamed,
 * an organization added), and the latest one is what a person would recognise.
 * A key whose rows all carry a null label is absent rather than present-and-
 * empty, so a caller falls through to its own fallback instead of showing a
 * blank name. Bounded by `usage_event`'s 90-day retention, and served by
 * `idx_usage_event_account_key_ts`.
 */
export function latestAccountLabels(): Map<string, string> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT e.account_key AS account_key, e.account_label AS account_label
         FROM usage_event e
         JOIN (SELECT account_key, MAX(ts) AS ts
                 FROM usage_event
                WHERE account_label IS NOT NULL
                GROUP BY account_key) newest
           ON newest.account_key = e.account_key AND newest.ts = e.ts
        WHERE e.account_label IS NOT NULL`
    )
    .all() as Array<{ account_key: string; account_label: string }>
  const labels = new Map<string, string>()
  // Two turns of one account can share the newest ts; the first of a tie wins,
  // as it does for a window sample.
  for (const row of rows) {
    if (!labels.has(row.account_key)) labels.set(row.account_key, row.account_label)
  }
  return labels
}

/**
 * Every ledger row a Codex thread is answerable for: its own turns, plus the
 * turns of the children it spawned (ADR-071 §2, S1e).
 *
 * A child files its row under its OWN native thread id, so `session_id` cannot
 * find it from the root — `parent_routing_id` is the join, and for Codex the
 * routing id, the sidebar session id and the native thread id are the same
 * string (`adoptThread`), which is what makes one parameter enough for both
 * halves. Served by `idx_usage_event_session` and `idx_usage_event_parent_routing`.
 *
 * Rows of EVERY origin that matches come back, dispatch included: the caller
 * decides what belongs in a sum and what is only a breakdown row.
 */
export function usageEventsForCodexThread(threadId: string): UsageEventRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM usage_event
        WHERE engine_id = 'codex'
          AND (session_id = ? OR (origin = 'child' AND parent_routing_id = ?))
        ORDER BY ts ASC`
    )
    .all(threadId, threadId) as UsageEventDbRow[]
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
  account_key: string
  window_kind: string
}

function rowToWindowSample(row: WindowSampleDbRow): WindowSampleRow {
  return {
    id: row.id,
    ts: row.ts,
    accountUuid: row.account_uuid,
    usedPercent: row.used_percent,
    canonicalEnd: row.canonical_end,
    accountKey: row.account_key,
    windowKind: row.window_kind
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
    `INSERT INTO usage_window_sample
       (id, ts, account_uuid, used_percent, canonical_end, account_key, window_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sample.id,
    sample.ts,
    sample.accountUuid,
    sample.usedPercent,
    sample.canonicalEnd,
    sample.accountKey,
    sample.windowKind
  )
}

/**
 * The NEWEST sample of every window kind this account key has one for.
 *
 * What an INACTIVE account's limits are answered from when the caller may not
 * spend a refresh grant on it (ADR-071 §6): the last thing we saw, with its own
 * `ts` so the reader can say how old it is. `unknown` is a real key here — the
 * bucket every pre-v21 row landed in — so callers that mean "this account" must
 * not pass it.
 */
export function latestWindowSamples(accountKey: string): WindowSampleRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM usage_window_sample s
        WHERE s.account_key = ?
          AND s.ts = (SELECT MAX(t.ts) FROM usage_window_sample t
                       WHERE t.account_key = s.account_key AND t.window_kind = s.window_kind)
        ORDER BY s.window_kind`
    )
    .all(accountKey) as WindowSampleDbRow[]
  // Two samples of one kind can share the newest ts (a poll that wrote both
  // halves of a window in the same millisecond); one row per kind is the
  // contract, so the first of a tie wins.
  const newest = new Map<string, WindowSampleRow>()
  for (const row of rows) {
    if (!newest.has(row.window_kind)) newest.set(row.window_kind, rowToWindowSample(row))
  }
  return [...newest.values()]
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
 *
 * FIVE-HOUR SAMPLES ONLY. The table held nothing else until v21; it now holds
 * the weekly and per-model series too, and this `limit` is a budget — sharing it
 * across four kinds would quarter the 5-hour history the projection regresses
 * over, on exactly the accounts (Max, with scoped weeklies) that have the most
 * of it. The projection means the 5-hour window, so it says so.
 */
export function getWindowSamples(accountUuid: string, limit = 100): WindowSampleRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM usage_window_sample
        WHERE account_uuid = ? AND window_kind = '5h'
        ORDER BY ts DESC LIMIT ?`
    )
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
// callers) and older hours live durably in usage_bucket, so 90d is a very
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
 *
 * `usage_bucket` is NEVER pruned: it is the durable history the 90-day event
 * retention exists to make affordable (ADR-071 §1), and an hour's bucket cannot
 * be rebuilt once its events are gone.
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
// Usage bucket repository (ADR-071 §1 — hourly buckets, kept forever)
//
// `usage_bucket` is the durable half of the metering store: `usage_event` is
// pruned at 90 days, so a bucket is what a chart still has after that. One row
// per (hour, account, billing type, engine, vendor, model, origin), recomputed
// from the ledger for the recent hours and never touched again once the rollup
// window has passed them by (see BlockUsageService.rollupUsageBucketsFromDb).
//
// Hourly and in UTC, because a bucket outlives the machine that wrote it:
// ADR-072's hub holds this same table from several machines, and only a UTC
// hour can be grouped into the local day of whoever is looking.
//
// NEVER expose the raw db.
// ---------------------------------------------------------------------------

/** One hourly usage bucket. */
export interface UsageBucketRow {
  /** Start of the hour, in ms since the epoch, floored in UTC. */
  hourUtc: number
  accountKey: string
  billingType: BillingType
  engineId: string
  vendorId: string
  modelId: string
  origin: UsageOrigin
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  /** The 1h-TTL SUBSET of cacheWriteTokens — not additive with it. */
  cacheWrite1hTokens: number
  cacheReadTokens: number
  /** Sum of the KNOWN `api_cost_usd` values in the hour. */
  apiCostUsd: number
  /** Sum of the KNOWN `billed_cost_usd` values in the hour. */
  billedCostUsd: number
  /**
   * Sum of `api_cost_usd` over the hour's rows that recorded NO bill — the
   * `api` half of the per-row `billed ?? api` rule, so that
   * `billedCostUsd + unbilledApiCostUsd` is the hour's Σ(billed ?? api).
   * A row with neither figure is in `unknownApiCostCount` alone.
   */
  unbilledApiCostUsd: number
  /** How many of `requestCount` turns had no API-equivalent cost at all. */
  unknownApiCostCount: number
  /** How many of `requestCount` turns had no known bill. */
  unknownBilledCostCount: number
  requestCount: number
  /** 'rollup' — recomputed from usage_event; 'seed' — migrated from daily_usage. */
  source: 'rollup' | 'seed'
  /** Monotonic revision, stamped by the write. ADR-072 pulls "since rev". */
  rev: number
}

/** A bucket as a WRITER hands it over — the store issues the `rev`. */
export type UsageBucketWrite = Omit<UsageBucketRow, 'rev'>

interface UsageBucketDbRow {
  hour_utc: number
  account_key: string
  billing_type: string
  engine_id: string
  vendor_id: string
  model_id: string
  origin: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_write_1h_tokens: number
  cache_read_tokens: number
  api_cost_usd: number
  billed_cost_usd: number
  unbilled_api_cost_usd: number
  unknown_api_cost_count: number
  unknown_billed_cost_count: number
  request_count: number
  source: string
  rev: number
}

function rowToUsageBucket(row: UsageBucketDbRow): UsageBucketRow {
  return {
    hourUtc: row.hour_utc,
    accountKey: row.account_key,
    // Both are stored strings and can carry a value this build has no name
    // for — the cost rule's `default` branch is the fallback, as for a row.
    billingType: row.billing_type as BillingType,
    engineId: row.engine_id,
    vendorId: row.vendor_id,
    modelId: row.model_id,
    origin: row.origin as UsageOrigin,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    cacheReadTokens: row.cache_read_tokens,
    apiCostUsd: row.api_cost_usd,
    billedCostUsd: row.billed_cost_usd,
    unbilledApiCostUsd: row.unbilled_api_cost_usd,
    unknownApiCostCount: row.unknown_api_cost_count,
    unknownBilledCostCount: row.unknown_billed_cost_count,
    requestCount: row.request_count,
    source: row.source as 'rollup' | 'seed',
    rev: row.rev
  }
}

const UPSERT_USAGE_BUCKET_SQL = `
  INSERT INTO usage_bucket (
    hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin,
    input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
    cache_read_tokens, api_cost_usd, billed_cost_usd, unbilled_api_cost_usd,
    unknown_api_cost_count, unknown_billed_cost_count,
    request_count, source, rev
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin)
  DO UPDATE SET
    input_tokens              = excluded.input_tokens,
    output_tokens             = excluded.output_tokens,
    cache_write_tokens        = excluded.cache_write_tokens,
    cache_write_1h_tokens     = excluded.cache_write_1h_tokens,
    cache_read_tokens         = excluded.cache_read_tokens,
    api_cost_usd              = excluded.api_cost_usd,
    billed_cost_usd           = excluded.billed_cost_usd,
    unbilled_api_cost_usd     = excluded.unbilled_api_cost_usd,
    unknown_api_cost_count    = excluded.unknown_api_cost_count,
    unknown_billed_cost_count = excluded.unknown_billed_cost_count,
    request_count             = excluded.request_count,
    source                    = excluded.source,
    rev                       = excluded.rev
`

/**
 * The next revision number, from the one-row counter, consumed inside the
 * writing transaction.
 *
 * A COUNTER, not `MAX(rev) + 1` over the buckets themselves. One process owns
 * this database, so either would be race-free, and the MAX is the smaller
 * mechanism — but it is not monotonic: delete every row (the seed cleanup can,
 * on a database whose buckets are all seeds) and the maximum falls back to
 * zero, so the next write REUSES a revision a puller has already seen and its
 * "everything since rev N" silently skips those rows. Monotonicity is the whole
 * contract (ADR-072 §3), and a counter is the only thing that keeps it across a
 * delete.
 */
function nextUsageBucketRev(db: SqliteDatabase): number {
  const row = db.prepare('SELECT next_rev FROM usage_bucket_rev WHERE id = 1').get() as
    { next_rev: number } | undefined
  const rev = row?.next_rev ?? 1
  db.prepare('INSERT OR REPLACE INTO usage_bucket_rev (id, next_rev) VALUES (1, ?)').run(rev + 1)
  return rev
}

/**
 * Replace a set of buckets, all under ONE fresh `rev`, in a single transaction.
 * Returns the rev they were written under (0 when there was nothing to write).
 */
export function upsertUsageBuckets(rows: UsageBucketWrite[]): number {
  if (rows.length === 0) return 0
  const db = getDb()
  db.prepare('BEGIN').run()
  try {
    const rev = nextUsageBucketRev(db)
    const stmt = db.prepare(UPSERT_USAGE_BUCKET_SQL)
    for (const r of rows) {
      stmt.run(
        r.hourUtc,
        r.accountKey,
        r.billingType,
        r.engineId,
        r.vendorId,
        r.modelId,
        r.origin,
        r.inputTokens,
        r.outputTokens,
        r.cacheWriteTokens,
        r.cacheWrite1hTokens,
        r.cacheReadTokens,
        r.apiCostUsd,
        r.billedCostUsd,
        r.unbilledApiCostUsd,
        r.unknownApiCostCount,
        r.unknownBilledCostCount,
        r.requestCount,
        r.source,
        rev
      )
    }
    db.prepare('COMMIT').run()
    return rev
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

/**
 * Buckets at or after `sinceHourUtc`, oldest hour first (the chart's source).
 *
 * Bounded on purpose: buckets are hourly and kept forever, so an all-time read
 * grows without limit behind a chart that shows a fixed window. `idx_usage_
 * bucket_hour` serves the range. Pass 0 for everything.
 */
export function getUsageBucketsSince(sinceHourUtc: number): UsageBucketRow[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM usage_bucket WHERE hour_utc >= ? ORDER BY hour_utc ASC')
    .all(sinceHourUtc) as UsageBucketDbRow[]
  return rows.map(rowToUsageBucket)
}

/**
 * Drop the SEED buckets sitting at the given hours.
 *
 * A seed bucket is a whole day of the retired `daily_usage` table parked at
 * midday UTC (migration v20). The rollup recomputes whole LOCAL DAYS from the
 * ledger, so the moment it covers a day, that day's seed is a second, coarser
 * copy of the same spend — and the chart would add the two together. The rollup
 * passes the midday instant of each day it has just rebuilt; only `source =
 * 'seed'` rows are touched, so a rollup bucket that happens to sit at midday is
 * safe.
 */
export function deleteSeedUsageBuckets(hourUtcs: number[]): void {
  if (hourUtcs.length === 0) return
  const db = getDb()
  const stmt = db.prepare("DELETE FROM usage_bucket WHERE source = 'seed' AND hour_utc = ?")
  db.prepare('BEGIN').run()
  try {
    for (const hour of hourUtcs) stmt.run(hour)
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Window-value repository (ADR-071 §7)
//
// The SQL half of `usage-window-ledger.ts`, which owns the RULE: what a window
// spans, which windows a recompute touches, when one closes, and what the
// derived figures are. Nothing here decides any of that — these are the four
// statements the rule needs, kept beside every other repository because `getDb`
// is module-private. `UsageWindowRow` itself lives in `shared/types.ts`: the
// dashboard reads these rows over IPC, and the renderer may not import `core/`.
// ---------------------------------------------------------------------------

interface UsageWindowDbRow {
  account_key: string
  window_kind: string
  canonical_end: number
  window_start: number
  peak_percent: number
  api_cost_usd: number
  billed_cost_usd: number
  unknown_cost_count: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  sample_count: number
  closed: number
  updated_at: number
}

function rowToUsageWindow(row: UsageWindowDbRow): UsageWindowRow {
  return {
    accountKey: row.account_key,
    windowKind: row.window_kind,
    canonicalEnd: row.canonical_end,
    windowStart: row.window_start,
    peakPercent: row.peak_percent,
    apiCostUsd: row.api_cost_usd,
    billedCostUsd: row.billed_cost_usd,
    unknownCostCount: row.unknown_cost_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    sampleCount: row.sample_count,
    closed: row.closed !== 0,
    updatedAt: row.updated_at
  }
}

/** The identity of a window, plus what its samples say about it. */
export interface WindowSampleGroup {
  accountKey: string
  windowKind: string
  canonicalEnd: number
  peakPercent: number
  sampleCount: number
}

/**
 * Every window the samples since `sinceTs` name, with the peak each one saw.
 *
 * `unknown` is excluded for the reason migration v22 gives: it is one bucket
 * shared by every account whose identity was never captured, so a peak over it
 * belongs to no account.
 */
export function windowSampleGroups(sinceTs: number): WindowSampleGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT account_key, window_kind, canonical_end,
              MAX(used_percent) AS peak_percent,
              COUNT(*) AS sample_count
         FROM usage_window_sample
        WHERE account_key <> 'unknown' AND ts >= ?
        GROUP BY account_key, window_kind, canonical_end`
    )
    .all(sinceTs) as Array<{
    account_key: string
    window_kind: string
    canonical_end: number
    peak_percent: number
    sample_count: number
  }>
  return rows.map((r) => ({
    accountKey: r.account_key,
    windowKind: r.window_kind,
    canonicalEnd: r.canonical_end,
    peakPercent: r.peak_percent,
    sampleCount: r.sample_count
  }))
}

/**
 * Create rows for windows that have none, leaving every existing row alone.
 *
 * `OR IGNORE` is the whole point: a window already in the table keeps the sums
 * it has, and a CLOSED one is not resurrected by a late sample.
 */
export function insertMissingUsageWindows(
  windows: ReadonlyArray<
    Pick<UsageWindowRow, 'accountKey' | 'windowKind' | 'canonicalEnd' | 'windowStart'>
  >
): number {
  if (windows.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO usage_window
       (account_key, window_kind, canonical_end, window_start)
     VALUES (?, ?, ?, ?)`
  )
  let inserted = 0
  db.prepare('BEGIN').run()
  try {
    for (const w of windows) {
      inserted += stmt.run(w.accountKey, w.windowKind, w.canonicalEnd, w.windowStart).changes
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return inserted
}

/** Every window still open — the set a recompute is allowed to touch. */
export function getOpenUsageWindows(): UsageWindowRow[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM usage_window WHERE closed = 0 ORDER BY canonical_end ASC')
    .all() as UsageWindowDbRow[]
  return rows.map(rowToUsageWindow)
}

/** Windows matching the filter, newest end first. Closed windows included — they ARE the history. */
export function listUsageWindows(
  opts: { accountKey?: string; kind?: string; sinceTs?: number } = {}
): UsageWindowRow[] {
  const db = getDb()
  const clauses: string[] = ['canonical_end >= ?']
  const params: Array<string | number> = [opts.sinceTs ?? 0]
  if (opts.accountKey !== undefined) {
    clauses.push('account_key = ?')
    params.push(opts.accountKey)
  }
  if (opts.kind !== undefined) {
    clauses.push('window_kind = ?')
    params.push(opts.kind)
  }
  const rows = db
    .prepare(
      `SELECT * FROM usage_window
        WHERE ${clauses.join(' AND ')}
        ORDER BY canonical_end DESC, account_key ASC, window_kind ASC`
    )
    .all(...params) as UsageWindowDbRow[]
  return rows.map(rowToUsageWindow)
}

/** Replace the value rows a recompute has just rebuilt. */
export function upsertUsageWindows(rows: ReadonlyArray<UsageWindowRow>): void {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO usage_window (
       account_key, window_kind, canonical_end, window_start, peak_percent,
       api_cost_usd, billed_cost_usd, unknown_cost_count,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       sample_count, closed, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_key, window_kind, canonical_end) DO UPDATE SET
       window_start       = excluded.window_start,
       peak_percent       = excluded.peak_percent,
       api_cost_usd       = excluded.api_cost_usd,
       billed_cost_usd    = excluded.billed_cost_usd,
       unknown_cost_count = excluded.unknown_cost_count,
       input_tokens       = excluded.input_tokens,
       output_tokens      = excluded.output_tokens,
       cache_write_tokens = excluded.cache_write_tokens,
       cache_read_tokens  = excluded.cache_read_tokens,
       sample_count       = excluded.sample_count,
       closed             = excluded.closed,
       updated_at         = excluded.updated_at`
  )
  db.prepare('BEGIN').run()
  try {
    for (const r of rows) {
      stmt.run(
        r.accountKey,
        r.windowKind,
        r.canonicalEnd,
        r.windowStart,
        r.peakPercent,
        r.apiCostUsd,
        r.billedCostUsd,
        r.unknownCostCount,
        r.inputTokens,
        r.outputTokens,
        r.cacheWriteTokens,
        r.cacheReadTokens,
        r.sampleCount,
        r.closed ? 1 : 0,
        r.updatedAt
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

/** The cost and token columns of one account's turns, for a half-open `[startTs, endTs)` span. */
export interface LedgerCostRow {
  apiCostUsd: number | null
  billedCostUsd: number | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

/**
 * One account's ledger rows inside a window, ALL origins (ADR-071 §1): a
 * dispatched turn and a subagent's turn spend the same subscription as the
 * session's own, so all three count toward what the window delivered.
 *
 * HALF-OPEN on purpose. `canonical_end` is the next window's start, so a row
 * exactly at it belongs to that window and to this one it would be a double
 * count.
 *
 * ROWS, NOT `SUM()`. A SQL sum skips a NULL silently, so it cannot tell "no
 * turns" from "no turn could be priced", and it would absorb a non-finite REAL
 * as if it were a figure. The caller adds the finite values and COUNTS the rest
 * (ADR-030), which needs the rows one at a time.
 *
 * `cache_write_1h_tokens` is deliberately absent: it is the 1h-TTL SUBSET of
 * `cache_write_tokens`, so summing both would count those tokens twice.
 */
export function getLedgerCostRows(
  accountKey: string,
  startTs: number,
  endTs: number
): LedgerCostRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT api_cost_usd, billed_cost_usd,
              input_tokens, output_tokens, cache_write_tokens, cache_read_tokens
         FROM usage_event
        WHERE account_key = ? AND ts >= ? AND ts < ?`
    )
    .all(accountKey, startTs, endTs) as Array<{
    api_cost_usd: number | null
    billed_cost_usd: number | null
    input_tokens: number
    output_tokens: number
    cache_write_tokens: number
    cache_read_tokens: number
  }>
  return rows.map((r) => ({
    apiCostUsd: r.api_cost_usd,
    billedCostUsd: r.billed_cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    cacheReadTokens: r.cache_read_tokens
  }))
}

// ---------------------------------------------------------------------------
// The one-shot Claude identity re-key (S2e)
//
// The SQL half of `claude-account-identity.ts`, which owns the RULE — which
// rows moved to the wrong account, how far back, and when the repair may run.
// Nothing here decides any of that; it is the four statements the rule needs,
// in one transaction, because a half-applied re-key would leave the ledger and
// the buckets disagreeing about the same hours.
// ---------------------------------------------------------------------------

/** What the rule hands over: where the rows are, and where they belong. */
export interface ClaudeIdentityRepairPlan {
  /** The account key the rows were wrongly written under. */
  staleKey: string
  /** The account they actually belong to. */
  accountKey: string
  accountLabel: string | null
  accountUuid: string
  billingType: BillingType
  /** Rows at or after this instant move; earlier ones predate the mistake. */
  since: number
  /** `since` floored to its hour — the first bucket the span covers. */
  bucketSinceHourUtc: number
  /**
   * The first hour a bucket may be DELETED at: the rollup's own reach. Deleting
   * an hour it will never rebuild would simply lose that hour's spend, so a
   * span older than the rollup's window keeps its (mis-keyed) buckets and the
   * caller reports how many were left behind.
   */
  bucketDeleteFromHourUtc: number
}

export interface ClaudeIdentityRepairCounts {
  events: number
  samples: number
  windows: number
  buckets: number
  bucketsLeftBehind: number
}

/**
 * Move one account's rows onto another key, for a time span, atomically.
 *
 * `usage_event` and `usage_window_sample` are UPDATED — they are the record of
 * what happened and only their attribution was wrong. `usage_window` and
 * `usage_bucket` are DELETED instead, because both are DERIVED: the next
 * `recomputeUsageWindows` re-seeds a window from the re-keyed samples, and the
 * next rollup rebuilds an hour from the re-keyed ledger. Updating a
 * `usage_window` row's key would also collide with the primary key whenever the
 * correct account already owns that window.
 */
export function repairClaudeAccountKey(plan: ClaudeIdentityRepairPlan): ClaudeIdentityRepairCounts {
  const db = getDb()
  db.prepare('BEGIN').run()
  try {
    // ENGINE-FILTERED, unlike the three below: `usage_event` is the one table
    // holding other engines' rows, and only Claude's attribution was read off
    // the shared file.
    const events = db
      .prepare(
        `UPDATE usage_event
            SET account_key  = ?,
                account_label = ?,
                account_uuid  = ?,
                billing_type  = ?
          WHERE engine_id = 'claude' AND account_key = ? AND ts >= ?`
      )
      .run(
        plan.accountKey,
        plan.accountLabel,
        plan.accountUuid,
        plan.billingType,
        plan.staleKey,
        plan.since
      ).changes

    const samples = db
      .prepare(
        `UPDATE usage_window_sample
            SET account_key = ?, account_uuid = ?
          WHERE account_key = ? AND ts >= ?`
      )
      .run(plan.accountKey, plan.accountUuid, plan.staleKey, plan.since).changes

    const windows = db
      .prepare('DELETE FROM usage_window WHERE account_key = ? AND canonical_end >= ?')
      .run(plan.staleKey, plan.since).changes

    const leftBehind = db
      .prepare(
        `SELECT COUNT(*) AS n FROM usage_bucket
          WHERE account_key = ? AND hour_utc >= ? AND hour_utc < ?`
      )
      .get(plan.staleKey, plan.bucketSinceHourUtc, plan.bucketDeleteFromHourUtc) as { n: number }

    const buckets = db
      .prepare('DELETE FROM usage_bucket WHERE account_key = ? AND hour_utc >= ?')
      .run(plan.staleKey, plan.bucketDeleteFromHourUtc).changes

    db.prepare('COMMIT').run()
    return { events, samples, windows, buckets, bucketsLeftBehind: leftBehind.n }
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Dispatched-turn readers (ADR-033 M4-B, on ADR-071 §1's ledger)
//
// `dispatched_usage` is gone (migration v20). A dispatched turn is a
// `usage_event` row with `origin = 'dispatch'` and the dispatching session in
// `parent_routing_id` — the same two facts the old table's `from_routing_id`
// and its separateness carried, plus the token split, the account, the billing
// type and both costs it had nowhere to put.
//
// Both readers keep the shapes their callers already consume (the Delegated
// section over IPC, and the per-session dispatched-cost breakdown), so nothing
// above them changed. What changed is the money: a dispatched turn's cost is
// now whatever the ONE cost rule says for its billing type, like every other
// row, instead of a figure the dispatcher resolved and stored on its own.
// ---------------------------------------------------------------------------

/**
 * A dispatched row's target model as the dispatcher ENCODED it, rebuilt from
 * the vendor and model the ledger stores separately.
 *
 * `dispatchModelRef` split it on the way in (`engineMeta.decodeModelValue`),
 * and the callers of both readers key on the encoded form — the session
 * breakdown merges these rows with the LIVE ones `addDispatchedCost` records
 * under exactly that string, so a decoded id here would split one target into
 * two rows after a resume.
 *
 * The round trip is exact because the WRITE side canonicalises first
 * (`canonicalDispatchModel`): opencode and pi decode a bare id to their default
 * vendor, so an uncanonicalised `gpt-5-codex` would come back out of here as
 * `opencode/gpt-5-codex` and be the very second row this function exists to
 * prevent. A row written before that canonicalisation shipped — or by an engine
 * whose encoding changed — can still differ, and the live half is what moves in
 * that case, not this.
 *
 * `ENGINE_META` rather than `engineMeta()`, because an engine id this build has
 * never heard of must read back verbatim, not throw inside a DB read.
 */
function dispatchTargetModel(engineId: string, vendorId: string, modelId: string): string {
  const meta = ENGINE_META[engineId as keyof typeof ENGINE_META]
  if (!meta) return modelId
  return meta.encodeModelValue({ engineId: engineId as EngineId, vendorId, modelId })
}

/** The ledger columns both dispatched-turn readers need. */
interface DispatchLedgerDbRow {
  engine_id: string
  vendor_id: string
  model_id: string
  billing_type: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  api_cost_usd: number | null
  billed_cost_usd: number | null
}

/** The display cost of one dispatched row, or null when nothing could price it. */
function dispatchRowCostUsd(row: DispatchLedgerDbRow): number | null {
  return displayCostFromRow({
    billingType: row.billing_type as BillingType,
    apiCostUsd: row.api_cost_usd,
    billedCostUsd: row.billed_cost_usd
  })
}

const DISPATCH_LEDGER_COLUMNS = `engine_id, vendor_id, model_id, billing_type,
  input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
  api_cost_usd, billed_cost_usd`

// ---------------------------------------------------------------------------
// Slice C — cross-engine dispatched cost in the dispatching session's own
// cost breakdown (TopBar tooltip). Scoped to ONE dispatching session, for
// BaseSession.seedDispatchedCosts()'s durability-across-reloads seed.
// ---------------------------------------------------------------------------

/**
 * Per-(targetEngine, targetModel) cost totals for ONE dispatching session,
 * UNPRICED turns excluded — a turn that recorded no resolvable cost adds
 * nothing, and a target whose every turn was unpriced gets no row at all
 * rather than a spurious $0 group. Feeds BaseSession.seedDispatchedCosts() on
 * session construction/resume so a reloaded session's dispatched-cost
 * breakdown survives instead of resetting to zero (parity with Slice B's
 * costBaseUsd seeding).
 */
export function dispatchedCostsByRouting(
  fromRoutingId: string
): Array<{ targetEngine: string; targetModel: string; costUsd: number }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${DISPATCH_LEDGER_COLUMNS}
       FROM usage_event
       WHERE origin = 'dispatch' AND parent_routing_id = ?`
    )
    .all(fromRoutingId) as DispatchLedgerDbRow[]

  const byTarget = new Map<string, { targetEngine: string; targetModel: string; costUsd: number }>()
  for (const row of rows) {
    const costUsd = dispatchRowCostUsd(row)
    if (costUsd === null) continue
    const targetModel = dispatchTargetModel(row.engine_id, row.vendor_id, row.model_id)
    const key = `${row.engine_id}|${targetModel}`
    const agg = byTarget.get(key)
    if (agg) agg.costUsd += costUsd
    else byTarget.set(key, { targetEngine: row.engine_id, targetModel, costUsd })
  }
  return [...byTarget.values()]
}

/**
 * The same rename for `usage_event.parent_routing_id` (ADR-071 §1). A `child`
 * or `dispatch` row names the session that spawned the work, and a subagent
 * turn can finish while the session is still on its renderer-minted temporary
 * id — so without this the row keeps pointing at an id that no longer exists
 * and its spend can never be traced back to the session that caused it.
 */
export function renameUsageEventParent(oldRoutingId: string, newRoutingId: string): void {
  const db = getDb()
  db.prepare('UPDATE usage_event SET parent_routing_id = ? WHERE parent_routing_id = ?').run(
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
  /** ADR-064 (v14). Host-side master switch for the `ide` capability, 0/1. */
  allow_ide: number
  /**
   * ADR-064 (v14). Optional override for the VS Code CLI the host spawns, or
   * NULL for auto-detection. HOST-ANCHORED because the host EXECUTES it.
   */
  ide_cli_path: string | null
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
   * Host-side master switch for the remote IDE (ADR-064). Default OFF, and the
   * same host-anchored write path as {@link RemoteConfigRow.allowTerminal}.
   */
  allowIde: boolean
  /**
   * Optional VS Code CLI override, or null for auto-detection. Host-anchored
   * because the host SPAWNS it — see the v14 migration comment.
   */
  ideCliPath: string | null
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
    // v14 (ADR-064). Same in-code COALESCE reasoning as `allow_terminal`: a row
    // written by a build that predates v14 must read as "IDE off, no override",
    // never as `undefined`.
    allowIde: row.allow_ide === 1,
    ideCliPath: row.ide_cli_path ?? null,
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
    RemoteConfigDbRow | undefined
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
  /** ADR-064 host-side master switch for the remote IDE. */
  allowIde?: boolean
  /**
   * ADR-064 VS Code CLI override. `null` is MEANINGFUL (clear the override and
   * go back to auto-detection), so it is distinguished from `undefined` (leave
   * alone) — same convention as `bindHost`.
   */
  ideCliPath?: string | null
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
  const allowIde =
    partial.allowIde !== undefined ? (partial.allowIde ? 1 : 0) : (existing?.allow_ide ?? 0)
  const ideCliPath =
    partial.ideCliPath !== undefined ? partial.ideCliPath : (existing?.ide_cli_path ?? null)
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
       allow_ide, ide_cli_path,
       auth_policy, password_break_glass,
       step_up_tier, step_up_mutation_idle_minutes, session_max_age_hours,
       audit_retention_days, updated_at
     )
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       port                          = excluded.port,
       bind_host                     = excluded.bind_host,
       autostart                     = excluded.autostart,
       tls_mode                      = excluded.tls_mode,
       tls_https_port                = excluded.tls_https_port,
       allow_terminal                = excluded.allow_terminal,
       shell_grant_idle_minutes      = excluded.shell_grant_idle_minutes,
       allow_ide                     = excluded.allow_ide,
       ide_cli_path                  = excluded.ide_cli_path,
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
    allowIde,
    ideCliPath,
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
      if (Array.isArray(parsed))
        transports = parsed.filter((t): t is string => typeof t === 'string')
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
    WebauthnCredentialDbRow | undefined
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
    { n: number } | undefined
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
  /** Per-connection uuid (one per authenticated socket / per host surface per run). */
  connectionId: string
  /**
   * The `IdentityMethod` the connection was admitted under: 'password' |
   * 'webauthn' | 'webauthn-resumed' | 'enroll-token' | 'none' | 'host'.
   *
   * TEXT rather than an enum because it is a HISTORICAL record — rows written by
   * an older build keep whatever vocabulary that build had, and the retired
   * values ('token' and 'tailnet-identity', both gone in ADR-056; 'desktop',
   * renamed to 'host' on 2026-08-20) may still be sitting in a local DB. Nothing
   * reads this column back for a decision, so there is no migration.
   */
  method: string
  /**
   * Tailnet login / passkey nickname when known; for `host`, WHICH host surface
   * ('desktop-renderer' or 'server-console'); else the method name.
   */
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
export function appendAuditLog(
  entry: Omit<AuditLogRow, 'id' | 'detail'> & { detail?: string | null }
): void {
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
