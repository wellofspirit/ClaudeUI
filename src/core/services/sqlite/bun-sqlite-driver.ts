/**
 * The `bun:sqlite` driver — the BUN headless path, and the one that makes the
 * compiled executable possible (S3 stage 1).
 *
 * `bun:sqlite` is a bun BUILTIN, not a native addon, so `bun build --compile`
 * embeds it in the single-file executable with nothing to ship alongside. That
 * is the entire reason this driver exists: the S3 stage-0 investigation proved
 * `better-sqlite3` cannot run under bun at all (an uncatchable N-API panic at
 * construct time, on both 1.3.6 and 1.3.14), so the compiled-executable artifact
 * the owner asked for was unreachable through the native module and reachable
 * through this one. The compile path was verified end to end before this file
 * was written: a `--compile` binary opening a DB, running DDL, inserting and
 * selecting.
 *
 * The `bun:sqlite` import is why this module is loaded ONLY by
 * `src/server/main.ts`, and only when it has established it is running under
 * bun. Nothing else may import it — under node or Electron the specifier does
 * not resolve.
 *
 * Two engine differences are normalised here (both verified empirically against
 * bun 1.3.14, not assumed from docs):
 *
 *   - `get()` returns `null` for a miss where better-sqlite3 returns
 *     `undefined` — {@link normalizeGet} closes it, and the conformance spec
 *     asserts it;
 *   - there is no `pragma()` method, so {@link emulatePragma} provides
 *     better-sqlite3's bare-body form. `PRAGMA journal_mode = WAL` returns a row
 *     under bun, which is why that helper tolerates a result-producing write.
 *
 * `run()` already returns `{ changes, lastInsertRowid }` with the same meanings,
 * and BLOBs come back as `Uint8Array` — which db.ts's credential read already
 * coerces to `Buffer`, exactly as it does for `node:sqlite`.
 *
 * ## Why the engine is INJECTED rather than imported
 *
 * Same reason as the `node:sqlite` driver, in the opposite direction. A static
 * `import ... from 'bun:sqlite'` here gets hoisted into the bundled entry chunk
 * and evaluated at startup, which breaks the NODE-hosted distribution — where
 * that specifier does not resolve at all. Taking the constructor as an argument
 * makes loading this module harmless on any runtime, and `src/server/main.ts`
 * supplies the real one after it has established it is running under bun.
 */

import type { Database, DatabaseOptions, Statement } from 'bun:sqlite'
import {
  emulatePragma,
  normalizeGet,
  type SqliteDatabase,
  type SqliteDriver,
  type SqliteOpenOptions
} from '../sqlite-driver'

/** The `bun:sqlite` `Database` constructor, as injected. */
export type BunDatabaseCtor = new (filename: string, options?: DatabaseOptions) => Database

/**
 * Build the driver around an injected `Database`.
 *
 * `const { Database } = await import('bun:sqlite')` at the call site — see the
 * module header for why the import cannot live here.
 */
export function bunSqliteDriver(BunDatabaseCtor: BunDatabaseCtor): SqliteDriver {
  return {
    name: 'bun:sqlite',
    open(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
      // `create: false` is bun's spelling of better-sqlite3's `fileMustExist` —
      // it throws `unable to open database file` on a missing path, which is the
      // same failure `readOpencodeSessionRows` already catches.
      const inner = new BunDatabaseCtor(filename, {
        readonly: options?.readonly === true,
        create: options?.fileMustExist ? false : true
      })
      const handle = {
        exec: (sql: string) => {
          inner.exec(sql)
        },
        prepare: (sql: string) => inner.prepare(sql)
      }

      return {
        exec: (sql) => {
          inner.exec(sql)
        },
        pragma: (source, opts) => emulatePragma(handle, source, opts),
        prepare(sql) {
          const stmt = inner.prepare(sql)
          return {
            run: (...params) => {
              const result = (stmt as Statement).run(...(params as never[]))
              return {
                changes: Number(result.changes),
                lastInsertRowid: result.lastInsertRowid
              }
            },
            get: (...params) => normalizeGet(stmt.get(...(params as never[]))),
            all: (...params) => stmt.all(...(params as never[]))
          }
        },
        close: () => inner.close()
      }
    }
  }
}
