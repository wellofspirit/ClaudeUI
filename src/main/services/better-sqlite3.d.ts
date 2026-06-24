/**
 * Minimal ambient type declarations for better-sqlite3.
 *
 * These cover only the API surface used by db.ts. Replace with
 * @types/better-sqlite3 once it can be added to devDependencies without
 * triggering bun's postinstall (which would revert the Electron-ABI rebuild).
 */

declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement<BindParameters extends unknown[] = unknown[]> {
      run(...params: BindParameters): RunResult
      get(...params: BindParameters): unknown
      all(...params: BindParameters): unknown[]
    }

    interface Database {
      exec(sql: string): this
      pragma(source: string, options?: { simple?: boolean }): unknown
      prepare(sql: string): Statement
      close(): void
    }
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): BetterSqlite3.Database
    (filename: string, options?: Record<string, unknown>): BetterSqlite3.Database
  }

  const Database: DatabaseConstructor
  export = Database
}
