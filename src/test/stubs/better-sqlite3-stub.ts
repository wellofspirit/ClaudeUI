/**
 * better-sqlite3 stub for vitest.
 *
 * Vitest runs in plain Node, which cannot load the Electron-ABI better-sqlite3
 * native module (ERR_DLOPEN_FAILED). This shim adapts node:sqlite's DatabaseSync
 * (built into Node 24, flagless) to the better-sqlite3 API surface so that the
 * DB module, migrations, and repository logic are exercised against a real
 * in-memory SQLite — just without the native .node binary.
 *
 * API surface covered:
 *   new Database(path)          — ':memory:' for path = ':memory:' or any path
 *   db.exec(sql)                — multi-statement DDL/DML
 *   db.pragma(stmt, opts?)      — runs real PRAGMA so user_version round-trips
 *   db.prepare(sql)             — returns a Statement
 *   stmt.run(...args)           — returns { changes, lastInsertRowid }
 *   stmt.get(...args)           — returns first row or undefined
 *   stmt.all(...args)           — returns all rows
 *   db.close()                  — closes the connection
 *
 * pragma() runs against real SQLite (node:sqlite), so the migration version
 * guard (user_version read/write) is genuinely exercised under vitest. WAL /
 * foreign_keys pragmas also execute but are effectively inert on :memory:
 * (journal_mode returns 'memory'); that's harmless.
 *
 * Intentional deviations from better-sqlite3:
 *   - All paths are silently mapped to ':memory:' (tests must not rely on file I/O)
 *   - Named parameter bindings use node:sqlite's native syntax (:name / $name);
 *     better-sqlite3 also supports both, so there is no divergence in practice.
 */

// node:sqlite is a Node 24 built-in. We use require() so the import is only
// resolved at test runtime in Node 24 (plain ESM import would be resolved at
// module-parse time and fail if @types/node is too old for the sqlite types).
const nodeSqlite = require('node:sqlite') as typeof import('node:sqlite')
const { DatabaseSync } = nodeSqlite

import { emulatePragma, normalizeGet } from '../../core/services/sqlite-driver'

type NodeStatement = ReturnType<InstanceType<typeof DatabaseSync>['prepare']>

interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

class Statement {
  private stmt: NodeStatement

  constructor(stmt: NodeStatement) {
    this.stmt = stmt
  }

  run(...args: unknown[]): RunResult {
    const result = this.stmt.run(...(args as Parameters<NodeStatement['run']>))
    // node:sqlite types both fields as `number | bigint`; coerce to match
    // better-sqlite3's RunResult which has `changes: number`.
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid
    }
  }

  get(...args: unknown[]): unknown {
    // Same null→undefined contract the drivers hold to, so a test and production
    // agree on what a miss looks like.
    return normalizeGet(this.stmt.get(...(args as Parameters<NodeStatement['get']>)))
  }

  all(...args: unknown[]): unknown[] {
    return this.stmt.all(...(args as Parameters<NodeStatement['all']>))
  }
}

class Database {
  private db: InstanceType<typeof DatabaseSync>

  constructor(_path: string) {
    // Always use in-memory; tests must not rely on file persistence.
    this.db = new DatabaseSync(':memory:')
  }

  exec(sql: string): this {
    this.db.exec(sql)
    return this
  }

  pragma(stmt: string, opts?: { simple?: boolean }): unknown {
    // Delegates to the PRODUCTION emulation (S3 stage 1) rather than carrying a
    // second copy. This stub used to branch on `=` and return `null` for the
    // write form — an invention: the driver conformance spec, pointed at real
    // better-sqlite3, showed that `pragma()` has no write/read distinction and
    // always returns the statement's result rows. Keeping a private copy here
    // would mean the whole suite ran against pragma semantics that production
    // does not have, which is exactly the drift the seam exists to remove.
    return emulatePragma(
      { exec: (sql) => this.db.exec(sql), prepare: (sql) => this.db.prepare(sql) },
      stmt,
      opts
    )
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql))
  }

  close(): void {
    this.db.close()
  }
}

// Mirror better-sqlite3's default export shape: `new Database(path)` as the
// default export, with `Database` also accessible as a named export.
export { Database }
export default Database
