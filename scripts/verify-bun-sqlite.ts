/**
 * The `bun:sqlite` arm of the SQLite driver conformance spec (S3 stage 1).
 *
 *     bun scripts/verify-bun-sqlite.ts
 *
 * vitest runs on node and therefore cannot host `bun:sqlite` — it is a bun
 * BUILTIN, not a package. So the third driver's conformance runs here, under
 * bun, against the SAME exported spec `sqlite-driver.test.ts` uses for
 * `node:sqlite` and better-sqlite3. One spec, three runners; no engine gets a
 * weaker set of assertions than the others.
 *
 * This is not optional colour: `bun:sqlite` is the engine the compiled
 * `claudeui-server` executable ships with, and it is the one engine no CI job
 * running `bun run test` would otherwise touch. `build:server:compile` runs this
 * script as part of its verification, so the artifact cannot be produced without
 * its storage engine having been checked.
 *
 * It also runs the PRODUCTION migration list here, which nothing else does
 * under `bun:sqlite`: `bun run test` migrates under node's drivers only, so a
 * statement the builtin refuses (or silently reads differently) would have
 * reached the compiled server unchecked. v18 and v19 were verified by hand;
 * this is the gate that means the next one need not be. Driver only — no app
 * boot, no real DB file, no repository call.
 *
 * Exits non-zero with the failing assertion on any divergence.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runSqliteDriverConformance } from '../src/core/services/__tests__/sqlite-driver-conformance'
import { Database } from 'bun:sqlite'
import { bunSqliteDriver } from '../src/core/services/sqlite/bun-sqlite-driver'
import { MIGRATIONS, runMigrations } from '../src/core/services/db'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-bun-sqlite-'))
const dbPath = path.join(tmpRoot, 'conformance.db')

function cleanup(): void {
  // Individual removes, never a recursive force-delete. WAL/SHM sidecars may or
  // may not exist depending on where a failure landed.
  for (const suffix of ['', '-wal', '-shm', '.does-not-exist']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true })
    } catch {
      /* best effort — a Windows handle may still be settling */
    }
  }
  try {
    fs.rmdirSync(tmpRoot)
  } catch {
    /* best effort */
  }
}

const driver = bunSqliteDriver(Database)

/**
 * Every table a repository function in `db.ts` names. A migration that renames
 * or drops one without moving its readers fails here instead of at runtime.
 */
const REQUIRED_TABLES = [
  'session_meta',
  'account',
  'usage_event',
  'usage_window_sample',
  'usage_bucket',
  'usage_bucket_rev',
  'usage_window',
  'remote_config',
  'audit_log',
  'webauthn_credential',
  'codex_session_overrides',
  'codex_forks',
  'meta',
  'usage_hub_config',
  'remote_usage_bucket',
  'remote_usage_window',
  'remote_limits'
]

/** The full production migration list, on an in-memory `bun:sqlite` database. */
function verifyMigrations(): void {
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
  const db = driver.open(':memory:')
  try {
    runMigrations(db)
    const version = db.pragma('user_version', { simple: true }) as number | null
    if (version !== latest) {
      throw new Error(`migrations: user_version is ${version}, expected ${latest}`)
    }
    for (const table of REQUIRED_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
      if (row === undefined) throw new Error(`migrations: table "${table}" does not exist`)
      // Readable, not merely declared — a CREATE that the builtin parsed
      // differently would still be queryable, so this is the honest check.
      db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get()
    }
    // Re-running must be a no-op, not an error: every app start does it.
    runMigrations(db)
  } finally {
    db.close()
  }
}

try {
  runSqliteDriverConformance(driver, dbPath)
  verifyMigrations()
  console.log(
    `PASS  sqlite driver conformance + ${MIGRATIONS.length} migrations — ${driver.name} ` +
      `(bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'})`
  )
} catch (err) {
  console.error(`FAIL  sqlite driver conformance — ${driver.name}`)
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  cleanup()
  process.exit(1)
}

cleanup()
