/**
 * The SQLite DRIVER SEAM — one storage API, three engines (S3 stage 1).
 *
 * ## Why this exists
 *
 * `db.ts` used to `import BetterSqlite3 from 'better-sqlite3'` statically, which
 * made the operational DB — and therefore every module that reads it, which is
 * most of `src/core` — loadable ONLY under a runtime that can `dlopen` a Node
 * native addon. That was fine while Electron was the only entrypoint. It is not
 * fine for `claudeui-server`.
 *
 * The S3 stage-0 investigation established the constraint empirically, on
 * Windows x64 with better-sqlite3 13.0.3:
 *
 *   - under **bun** (1.3.6 AND 1.3.14), `require('better-sqlite3')` does not
 *     merely fail — it takes the process down with
 *     `panic(main thread): NAPI FATAL ERROR: Error::New napi_get_last_error_info`,
 *     at construct time, even for `:memory:`. It is a bun N-API defect, not a
 *     WAL/path problem, and being a panic it is UNCATCHABLE — no try/catch
 *     fallback could have rescued it;
 *   - under **node** the same prebuilt binary works perfectly;
 *   - `bun:sqlite` works, and — the point — a `bun build --compile` single-file
 *     executable embeds it, because it is a bun BUILTIN rather than an addon.
 *     The "native addon in a single-file binary" hard case never arises.
 *
 * So every headless distribution ships with ZERO native dependencies, and only
 * Electron keeps the native module.
 *
 * ## The contract: selection is EXPLICIT
 *
 * The entrypoint declares its driver; nothing sniffs the runtime. Sniffing would
 * make the storage engine a function of how the process happened to be launched
 * — precisely the property you do not want in the layer holding the audit log.
 *
 *   - `src/main/index.ts` (Electron desktop) installs {@link betterSqlite3Driver}
 *     — the native module, byte-identical behaviour, nothing about the app
 *     changes;
 *   - `src/server/main.ts` installs `bun:sqlite` under bun, `node:sqlite` under
 *     node (it detects its own host runtime — an ENTRYPOINT may, the seam may
 *     not);
 *   - vitest installs the driver from its setup files.
 *
 * There is deliberately NO default. An un-installed driver throws a message
 * naming the fix, rather than quietly picking an engine: the failure mode this
 * seam exists to prevent is "the desktop wrote its audit log with a different
 * SQLite than it read it with", and a convenient fallback is exactly how that
 * would happen unnoticed.
 *
 * ## Behavioural equivalence
 *
 * The drivers are held to ONE conformance spec
 * (`__tests__/sqlite-driver-conformance.ts`), which vitest runs against
 * `node:sqlite` and — when the installed native binary's ABI permits — real
 * better-sqlite3, and which `scripts/verify-bun-sqlite.ts` runs against
 * `bun:sqlite` under bun (vitest cannot host `bun:sqlite`). The two places the
 * engines genuinely differ are normalised HERE, once, rather than at ~40 call
 * sites in db.ts:
 *
 *   1. a `get()` miss is `undefined`, never `null` (bun:sqlite returns `null`;
 *      db.ts's `row ? … : undefined` idiom tolerates both, but a storage seam
 *      that is "compatible if you only use it the way today's callers do" is a
 *      trap for the next caller);
 *   2. `pragma()` — better-sqlite3's bare-body form (`'user_version'`,
 *      `'journal_mode = WAL'`) with `{ simple: true }` — is emulated for the two
 *      builtins, which expose no such method.
 *
 * BLOB typing is deliberately NOT normalised: better-sqlite3 hands back a
 * `Buffer`, the builtins a `Uint8Array`, and db.ts's `webauthn_credential` read
 * already coerces (`Buffer.isBuffer(...) ? … : Buffer.from(...)`). Copying every
 * BLOB through the seam to satisfy a coercion that already exists would be pure
 * cost.
 */

// ---------------------------------------------------------------------------
// The neutral surface (exactly what db.ts consumes — nothing speculative)
// ---------------------------------------------------------------------------

/** better-sqlite3's `RunResult`. */
export interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  /** The row, or `undefined` when there is none — never `null`. */
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  /** Multi-statement DDL/DML. */
  exec(sql: string): void
  /**
   * better-sqlite3's `pragma()`: the BARE pragma body, no leading `PRAGMA`.
   * Write form (`'user_version = 3'`) returns null; read form returns the rows,
   * or the first column of the first row under `{ simple: true }`.
   */
  pragma(source: string, options?: { simple?: boolean }): unknown
  prepare(sql: string): SqliteStatement
  close(): void
}

/**
 * The subset of better-sqlite3's open options db.ts uses — both are set by
 * `readOpencodeSessionRows`, which reads a FOREIGN database (opencode's own) and
 * must never create or write it.
 */
export interface SqliteOpenOptions {
  readonly?: boolean
  fileMustExist?: boolean
}

export interface SqliteDriver {
  /** Diagnostic identity — surfaced by `claudeui-server --help` and the smoke script. */
  readonly name: 'better-sqlite3' | 'node:sqlite' | 'bun:sqlite'
  open(filename: string, options?: SqliteOpenOptions): SqliteDatabase
}

// ---------------------------------------------------------------------------
// Shared adapter helpers — used by the two BUILTIN drivers
// ---------------------------------------------------------------------------

/** The minimum a raw engine handle must offer for {@link emulatePragma}. */
export interface PragmaCapableHandle {
  exec(sql: string): void
  prepare(sql: string): { all(...args: unknown[]): unknown[] }
}

/**
 * Emulate better-sqlite3's `pragma()` on an engine that only has `exec`/`prepare`.
 *
 * Shared rather than duplicated in the two builtin drivers: a pragma that
 * silently disagreed between node and bun would desync the MIGRATION VERSION
 * GUARD, which is the one place in this codebase where being subtly wrong
 * corrupts data instead of throwing.
 *
 * **There is no write/read split.** The long-standing vitest shim had one — it
 * branched on `=` and returned `null` for the write form — and the conformance
 * spec caught that as an invention the moment it was pointed at the real engine.
 * better-sqlite3 (measured, not assumed) simply RUNS the pragma and returns its
 * result rows, whatever they are:
 *
 *     pragma('journal_mode = WAL')            → [{ journal_mode: 'wal' }]
 *     pragma('foreign_keys = ON')             → []
 *     pragma('user_version = 13')             → []
 *     pragma('user_version')                  → [{ user_version: 13 }]
 *     pragma('user_version', {simple:true})   → 13
 *     pragma('foreign_keys = ON',{simple:true}) → undefined
 *
 * A "write" that returns rows (`journal_mode`) and a "read" that returns none
 * are both ordinary cases of one rule, so this emulation implements that one
 * rule. Converging on better-sqlite3 rather than on a third invented behaviour
 * is the point of a seam: the desktop is the reference deployment, and db.ts's
 * semantics were written against it.
 *
 * `exec` is kept on the handle as the fallback for an engine that refuses to
 * PREPARE a particular pragma; the empty-row answer it yields is what
 * better-sqlite3 returns for a non-result pragma anyway.
 */
export function emulatePragma(
  handle: PragmaCapableHandle,
  source: string,
  options?: { simple?: boolean }
): unknown {
  const statement = `PRAGMA ${source.trim()};`

  let rows: Array<Record<string, unknown>>
  try {
    rows = handle.prepare(statement).all() as Array<Record<string, unknown>>
  } catch {
    // Engine refused to prepare it — run it for effect and report no rows.
    handle.exec(statement)
    rows = []
  }

  if (!options?.simple) return rows
  // `{ simple: true }` is the first column of the first row, or undefined.
  const first = rows[0]
  if (!first) return undefined
  const keys = Object.keys(first)
  return keys.length > 0 ? first[keys[0]] : undefined
}

/** `null` → `undefined`, so a `get()` miss reads identically on all three engines. */
export function normalizeGet(row: unknown): unknown {
  return row === null ? undefined : row
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

let installed: SqliteDriver | null = null

/**
 * Whether the operational DB currently holds an open handle. Wired by `db.ts`
 * at import time — a plain function reference, so this module needs no import
 * back into `db.ts` (which imports THIS one) and the two stay acyclic.
 */
let dbIsOpen: () => boolean = () => false

/** @internal — called once by `db.ts` at module load. */
export function setDbOpenProbe(probe: () => boolean): void {
  dbIsOpen = probe
}

/**
 * Install the driver for this process. Call from the ENTRYPOINT, before any DB
 * access.
 *
 * Re-installing the same driver is a no-op (the desktop and a test may both
 * install). SWITCHING drivers while the DB is open is a throw rather than a
 * silent re-open: two handles on one file's WAL, through different engines, is
 * a corruption story, not a configuration change.
 */
export function setSqliteDriver(driver: SqliteDriver): void {
  if (installed && installed.name !== driver.name && dbIsOpen()) {
    throw new Error(
      `setSqliteDriver: cannot switch from "${installed.name}" to "${driver.name}" — the ` +
        'operational DB is already open. Install the driver from the entrypoint, before any DB access.'
    )
  }
  installed = driver
}

/**
 * The installed driver. Throws when the entrypoint never installed one — see the
 * header for why there is no fallback.
 */
export function getSqliteDriver(): SqliteDriver {
  if (!installed) {
    throw new Error(
      'No SQLite driver installed. The entrypoint must call setSqliteDriver() before any DB ' +
        'access — src/main/index.ts installs better-sqlite3, src/server/main.ts installs ' +
        'bun:sqlite or node:sqlite, and the vitest setup files install the test driver.'
    )
  }
  return installed
}

/** The installed driver's name, or `null`. Diagnostics only — never branch on it. */
export function installedSqliteDriverName(): string | null {
  return installed?.name ?? null
}

/** Test seam: forget the installed driver. Never called in production. */
export function resetSqliteDriver(): void {
  installed = null
}
