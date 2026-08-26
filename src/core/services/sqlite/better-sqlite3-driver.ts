/**
 * The `better-sqlite3` driver — the DESKTOP path (S3 stage 1).
 *
 * This is the only module in `src/core` that imports `better-sqlite3`, and it is
 * imported by exactly one place: `src/main/index.ts`, the Electron entrypoint.
 * That import edge is the whole design — the native addon enters the graph from
 * the runtime that can load it, and from nowhere else, so `src/server` and every
 * module it reaches never sees it.
 *
 * The import is STATIC on purpose. `electron.vite.config.ts` lists
 * `better-sqlite3` in `external`, so the bundler leaves the require in place and
 * the Electron main bundle is unaffected by this refactor; a dynamic import
 * would have changed how that externalisation resolves for no benefit.
 *
 * Behaviour is a pass-through. better-sqlite3 already IS the surface
 * `SqliteDriver` describes (the surface was derived from it), so the only
 * adaptation is the `get()` null-normalisation contract — which better-sqlite3
 * satisfies natively, since it returns `undefined` for a miss. It is applied
 * anyway rather than assumed: the conformance spec asserts it for all three
 * drivers, and a driver that passes only because its engine happens to agree is
 * a driver nobody has actually checked.
 *
 * Under vitest this module resolves to `src/test/stubs/better-sqlite3-stub.ts`
 * via the long-standing `resolve.alias`, so tests keep running on an in-memory
 * `node:sqlite` and never touch the real operational DB or the Electron-ABI
 * `.node` binary.
 */

import BetterSqlite3 from 'better-sqlite3'
import {
  normalizeGet,
  type SqliteDatabase,
  type SqliteDriver,
  type SqliteOpenOptions
} from '../sqlite-driver'

export function betterSqlite3Driver(): SqliteDriver {
  return {
    name: 'better-sqlite3',
    open(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
      // better-sqlite3's own option names match ours 1:1 (ours were taken from
      // it), so the options object passes through untouched. Passing `undefined`
      // rather than `{}` preserves the exact single-argument constructor call
      // the operational DB has always made.
      const inner = options
        ? new BetterSqlite3(filename, options as Record<string, unknown>)
        : new BetterSqlite3(filename)

      return {
        exec: (sql) => {
          inner.exec(sql)
        },
        pragma: (source, opts) => inner.pragma(source, opts),
        prepare(sql) {
          const stmt = inner.prepare(sql)
          return {
            run: (...params) => stmt.run(...params),
            get: (...params) => normalizeGet(stmt.get(...params)),
            all: (...params) => stmt.all(...params)
          }
        },
        close: () => inner.close()
      }
    }
  }
}
