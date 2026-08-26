/**
 * The ONE conformance spec every SQLite driver must satisfy (S3 stage 1).
 *
 * Not a `.test.ts`: it exports a function that a runner calls with a driver, so
 * that the SAME assertions run in the two places they have to run. vitest cannot
 * host `bun:sqlite` (it is a bun builtin and the suite runs on node), and bun
 * cannot host vitest's suite — so a single vitest file could only ever have
 * covered two of the three engines, and the third would have drifted silently.
 *
 *   - `sqlite-driver.test.ts`      — vitest, over `node:sqlite` and (when the
 *                                    installed native binary's ABI permits)
 *                                    better-sqlite3;
 *   - `scripts/verify-bun-sqlite.ts` — bun, over `bun:sqlite`, run as part of
 *                                    `build:server:compile`'s verification.
 *
 * What it pins is exactly what `db.ts` depends on, and in particular the two
 * behaviours where the engines genuinely disagreed before the drivers
 * normalised them: a `get()` miss must be `undefined` (bun returns `null`), and
 * `pragma()` must accept better-sqlite3's bare-body form with `{ simple: true }`
 * (neither builtin has the method at all). The migration version guard rides on
 * that second one, so a drift there corrupts rather than throws.
 *
 * Assertions are plain `throw`s, not a test framework's matchers, for the same
 * reason the file is shared: bun's runner and vitest do not agree on a matcher
 * API, and the spec must not depend on either.
 */

import type { SqliteDriver } from '../sqlite-driver'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`sqlite-driver conformance: ${message}`)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `sqlite-driver conformance: ${message} — expected ${JSON.stringify(expected)}, ` +
        `got ${JSON.stringify(actual)}`
    )
  }
}

/**
 * Run the full spec against one driver.
 *
 * `dbPath` should be a real file path in a temp directory — file-backed, not
 * `:memory:`, because WAL mode, the `readonly` option and `fileMustExist` are
 * all no-ops or lies on an in-memory database, and those are precisely the parts
 * of the surface the desktop's driver exercises against a real DB.
 */
export function runSqliteDriverConformance(driver: SqliteDriver, dbPath: string): void {
  const db = driver.open(dbPath)

  try {
    // ── pragma ─────────────────────────────────────────────────────────────
    //
    // This is the migration version guard's entire mechanism, so it is pinned
    // against the REFERENCE engine's measured behaviour: `pragma()` runs the
    // statement and returns its result rows, with no write/read distinction.
    // `journal_mode` is the case that proves there is no such distinction — it
    // is a "write" that returns a row — and `foreign_keys` the case that proves
    // an empty result is `[]` and not null.
    const journal = db.pragma('journal_mode = WAL')
    assert(Array.isArray(journal), 'pragma returns rows even for a write')
    assertEqual(
      (journal as Array<Record<string, unknown>>)[0]?.journal_mode,
      'wal',
      'journal_mode = WAL reports the mode it set'
    )

    const fk = db.pragma('foreign_keys = ON')
    assert(Array.isArray(fk) && fk.length === 0, 'a pragma with no result rows returns []')
    assertEqual(
      db.pragma('foreign_keys = ON', { simple: true }),
      undefined,
      '{simple} on a no-row pragma is undefined'
    )

    assertEqual(
      db.pragma('user_version', { simple: true }),
      0,
      'user_version starts at 0 on a fresh DB'
    )

    const versionWrite = db.pragma('user_version = 13')
    assert(
      Array.isArray(versionWrite) && versionWrite.length === 0,
      'user_version = N returns no rows'
    )
    assertEqual(
      db.pragma('user_version', { simple: true }),
      13,
      'user_version round-trips through pragma'
    )

    const nonSimple = db.pragma('user_version')
    assert(Array.isArray(nonSimple), 'pragma read without {simple} returns rows')
    assertEqual(
      (nonSimple as Array<Record<string, unknown>>)[0]?.user_version,
      13,
      'pragma read rows carry the value'
    )

    // ── exec: multi-statement DDL ──────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS conformance (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        name  TEXT NOT NULL,
        score REAL,
        blob  BLOB,
        UNIQUE(name)
      );
      CREATE INDEX IF NOT EXISTS idx_conformance_name ON conformance(name);
    `)

    // ── run(): changes + lastInsertRowid ───────────────────────────────────
    const insert = db.prepare('INSERT INTO conformance (name, score) VALUES (?, ?)')
    const first = insert.run('alpha', 1.5)
    assertEqual(first.changes, 1, 'insert reports one change')
    assertEqual(Number(first.lastInsertRowid), 1, 'insert reports lastInsertRowid')
    insert.run('beta', 2.5)

    // A prepared statement must be REUSABLE across calls — every bulk writer in
    // db.ts (`insertUsageEvents`, `upsertDailyUsage`) prepares once and runs in
    // a loop.
    const third = insert.run('gamma', 3.5)
    assertEqual(Number(third.lastInsertRowid), 3, 'a reused statement keeps inserting')

    // ── get(): a hit, and THE MISS CONTRACT ────────────────────────────────
    const hit = db.prepare('SELECT * FROM conformance WHERE name = ?').get('alpha') as {
      id: number
      name: string
      score: number
    }
    assertEqual(hit.name, 'alpha', 'get returns the row')
    assertEqual(hit.score, 1.5, 'get preserves REAL values')

    // The single most important line in this file. bun:sqlite returns `null`
    // here natively; the driver must map it, or `=== undefined` checks in the
    // repository layer would silently change meaning per engine.
    const miss = db.prepare('SELECT * FROM conformance WHERE name = ?').get('nope')
    assertEqual(miss, undefined, 'a get() MISS is undefined, never null')

    // ── all() ──────────────────────────────────────────────────────────────
    const all = db.prepare('SELECT name FROM conformance ORDER BY name ASC').all() as Array<{
      name: string
    }>
    assertEqual(all.length, 3, 'all() returns every row')
    assertEqual(all.map((r) => r.name).join(','), 'alpha,beta,gamma', 'all() preserves ORDER BY')

    const empty = db.prepare('SELECT name FROM conformance WHERE name = ?').all('nope')
    assert(Array.isArray(empty) && empty.length === 0, 'all() with no matches is an empty array')

    // ── NULL binding round-trip ────────────────────────────────────────────
    //
    // db.ts binds `?? null` in almost every writer (nullable account ids, costs,
    // session ids), so a driver that mangled null into 'null' or 0 would corrupt
    // a great deal very quietly.
    db.prepare('INSERT INTO conformance (name, score) VALUES (?, ?)').run('nulled', null)
    const nulled = db.prepare('SELECT score FROM conformance WHERE name = ?').get('nulled') as {
      score: unknown
    }
    assertEqual(nulled.score, null, 'a bound NULL reads back as null')

    // ── manual BEGIN/COMMIT and BEGIN/ROLLBACK ─────────────────────────────
    //
    // `runMigrations` wraps each migration in a manual transaction (explicitly
    // NOT `db.transaction()`), and the rollback arm is what stops a half-applied
    // schema from becoming permanent. Both arms are pinned.
    db.prepare('BEGIN').run()
    db.prepare('INSERT INTO conformance (name) VALUES (?)').run('committed')
    db.prepare('COMMIT').run()
    assert(
      db.prepare('SELECT id FROM conformance WHERE name = ?').get('committed') !== undefined,
      'COMMIT persists the write'
    )

    db.prepare('BEGIN').run()
    db.prepare('INSERT INTO conformance (name) VALUES (?)').run('rolled-back')
    db.prepare('ROLLBACK').run()
    assertEqual(
      db.prepare('SELECT id FROM conformance WHERE name = ?').get('rolled-back'),
      undefined,
      'ROLLBACK discards the write'
    )

    // ── ON CONFLICT DO NOTHING (the usage_event dedup key) ─────────────────
    const dup = db
      .prepare('INSERT INTO conformance (name) VALUES (?) ON CONFLICT(name) DO NOTHING')
      .run('alpha')
    assertEqual(dup.changes, 0, 'ON CONFLICT DO NOTHING reports zero changes')

    // ── ON CONFLICT DO UPDATE … excluded (every upsert in db.ts) ───────────
    const upsert = db
      .prepare(
        `INSERT INTO conformance (name, score) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET score = excluded.score`
      )
      .run('alpha', 9.5)
    assertEqual(upsert.changes, 1, 'ON CONFLICT DO UPDATE reports one change')
    assertEqual(
      (db.prepare('SELECT score FROM conformance WHERE name = ?').get('alpha') as { score: number })
        .score,
      9.5,
      'the upsert wrote excluded.score'
    )

    // ── DELETE reports its row count (pruneUsageTables returns these) ──────
    const deleted = db.prepare('DELETE FROM conformance WHERE name = ?').run('nulled')
    assertEqual(deleted.changes, 1, 'DELETE reports the number of rows removed')

    // ── BLOB round-trip ────────────────────────────────────────────────────
    //
    // The type is NOT normalised by design (better-sqlite3 gives Buffer, the
    // builtins Uint8Array, and db.ts coerces at its one BLOB read). What must
    // hold on every engine is that the BYTES survive.
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff])
    db.prepare('INSERT INTO conformance (name, blob) VALUES (?, ?)').run('blobbed', bytes)
    const blobRow = db.prepare('SELECT blob FROM conformance WHERE name = ?').get('blobbed') as {
      blob: Uint8Array
    }
    const readBack = Buffer.isBuffer(blobRow.blob) ? blobRow.blob : Buffer.from(blobRow.blob)
    assertEqual(readBack.length, 4, 'a BLOB round-trips with its length')
    assertEqual(readBack.equals(bytes), true, 'a BLOB round-trips byte for byte')

    // ── COUNT(*) reads as a number (the `{ n: number }` idiom) ─────────────
    const counted = db.prepare('SELECT COUNT(*) as n FROM conformance').get() as { n: number }
    assertEqual(typeof counted.n, 'number', 'COUNT(*) aliases to a JS number')
  } finally {
    db.close()
  }

  // ── open options, on a SECOND handle to the now-populated file ───────────
  const readonlyDb = driver.open(dbPath, { readonly: true, fileMustExist: true })
  try {
    const n = readonlyDb.prepare('SELECT COUNT(*) as n FROM conformance').get() as { n: number }
    assert(n.n > 0, 'a readonly handle reads the existing rows')

    let refused = false
    try {
      readonlyDb.prepare('INSERT INTO conformance (name) VALUES (?)').run('nope')
    } catch {
      refused = true
    }
    assertEqual(refused, true, 'a readonly handle REFUSES a write')
  } finally {
    readonlyDb.close()
  }

  // `fileMustExist` on an absent path must throw rather than create — this is
  // what keeps `readOpencodeSessionRows` from conjuring an empty opencode DB
  // when opencode simply is not installed.
  let threw = false
  try {
    driver.open(`${dbPath}.does-not-exist`, { readonly: true, fileMustExist: true }).close()
  } catch {
    threw = true
  }
  assertEqual(threw, true, 'fileMustExist throws on an absent file instead of creating it')
}
