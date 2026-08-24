/**
 * Minimal ambient type declarations for `bun:sqlite`.
 *
 * Deliberately hand-written rather than pulled from `@types/bun`: the driver
 * uses five methods, and adding a large ambient type package to devDependencies
 * to describe them would be a supply-chain cost with no return — and would drag
 * bun's global type declarations across the whole `tsconfig.node.json` program,
 * where they would silently redefine `process`, `fetch` and friends for every
 * other file. This mirrors `src/main/services/better-sqlite3.d.ts`, which exists
 * for exactly the same reason.
 *
 * The shapes below were verified empirically against bun 1.3.14 (S3 stage 0),
 * not copied from documentation — in particular that `run()` returns
 * `{ changes, lastInsertRowid }` and that `get()` yields `null`, not
 * `undefined`, for a miss. The driver normalises that second one.
 */

declare module 'bun:sqlite' {
  export interface Statement {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    /** The row, or `null` when there is none — the driver maps that to `undefined`. */
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  export interface DatabaseOptions {
    /** Open read-only. */
    readonly?: boolean
    /** Create the file when absent. `false` is better-sqlite3's `fileMustExist`. */
    create?: boolean
  }

  export class Database {
    constructor(filename: string, options?: DatabaseOptions)
    exec(sql: string, ...params: unknown[]): unknown
    prepare(sql: string): Statement
    close(): void
  }
}
