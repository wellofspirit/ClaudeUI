/**
 * The `node:sqlite` driver — the NODE headless path (S3 stage 1).
 *
 * A Node BUILTIN (22+), so a node-hosted `claudeui-server` and the pure-asset
 * distribution ship no native dependency at all: `bun run build:server` emits
 * JS, the user points their own `node` at it, and there is nothing to rebuild
 * per platform or per ABI.
 *
 * This is also, in behaviour, what vitest has run against since the operational
 * DB existed — `src/test/stubs/better-sqlite3-stub.ts` adapted the same builtin
 * to the same surface, and its `pragma` emulation is the direct ancestor of
 * {@link emulatePragma}. The difference is that this one is PRODUCTION code held
 * to the conformance spec, and honours real file paths and the open options; the
 * stub forced `:memory:` and ignored both, which is exactly why the stub could
 * never have been promoted into the server's driver.
 *
 * ## Why the engine is INJECTED rather than imported
 *
 * This module deliberately does not `import ... from 'node:sqlite'`. It takes
 * the `DatabaseSync` constructor as an argument, and `src/server/main.ts`
 * supplies it after deciding which runtime it is on.
 *
 * That is not ceremony — it is a bug fix. With a static import, `bun build`
 * pulls this module into the entry chunk (it is reachable, even if only through
 * a dynamic import down a branch that never runs under bun) and HOISTS the
 * engine import to module-evaluation time. The bundled server then died at
 * startup under bun with `No such built-in module: node:sqlite`: the runtime
 * choice the whole driver seam exists to make was being undone by the bundler.
 * `--external` did not help, because the problem is WHEN the module is
 * evaluated, not how the specifier resolves. Injection makes merely loading this
 * file harmless on any runtime, which is the only property that survives
 * bundling.
 */

import * as fs from 'fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  emulatePragma,
  normalizeGet,
  type SqliteDatabase,
  type SqliteDriver,
  type SqliteOpenOptions
} from '../sqlite-driver'

/** The `node:sqlite` `DatabaseSync` constructor, as injected. */
export type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSync

/**
 * Build the driver around an injected `DatabaseSync`.
 *
 * `const { DatabaseSync } = await import('node:sqlite')` at the call site — see
 * the module header for why the import cannot live here.
 */
export function nodeSqliteDriver(DatabaseSyncCtor: DatabaseSyncCtor): SqliteDriver {
  return {
    name: 'node:sqlite',
    open(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
      // node:sqlite has no `fileMustExist`. better-sqlite3 throws when the file
      // is absent under that option, so reproduce it rather than silently
      // creating an empty database — `readOpencodeSessionRows` is the only
      // caller, and a silently-created file would turn "opencode is not
      // installed" into an empty foreign DB that then reports schema drift.
      if (options?.fileMustExist && filename !== ':memory:' && !fs.existsSync(filename)) {
        throw new Error(`unable to open database file: ${filename}`)
      }

      const inner = new DatabaseSyncCtor(filename, { readOnly: options?.readonly === true })
      const handle = {
        exec: (sql: string) => inner.exec(sql),
        prepare: (sql: string) => inner.prepare(sql)
      }

      return {
        exec: (sql) => inner.exec(sql),
        pragma: (source, opts) => emulatePragma(handle, source, opts),
        prepare(sql) {
          const stmt = inner.prepare(sql)
          return {
            run: (...params) => {
              const result = stmt.run(...(params as never[]))
              // node:sqlite types `changes` as number|bigint; better-sqlite3's
              // RunResult.changes is a number and callers do arithmetic on it
              // (`pruneUsageTables` returns the counts).
              return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
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
