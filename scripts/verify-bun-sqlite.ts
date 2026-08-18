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
 * Exits non-zero with the failing assertion on any divergence.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runSqliteDriverConformance } from '../src/core/services/__tests__/sqlite-driver-conformance'
import { Database } from 'bun:sqlite'
import { bunSqliteDriver } from '../src/core/services/sqlite/bun-sqlite-driver'

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

try {
  runSqliteDriverConformance(driver, dbPath)
  console.log(
    `PASS  sqlite driver conformance — ${driver.name} ` +
      `(bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'})`
  )
} catch (err) {
  console.error(`FAIL  sqlite driver conformance — ${driver.name}`)
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  cleanup()
  process.exit(1)
}

cleanup()
