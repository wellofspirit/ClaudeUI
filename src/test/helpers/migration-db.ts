import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, type Db } from '../../core/services/db'

/** The highest schema version in the real MIGRATIONS: what a fully migrated db reports. */
export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))

/** Open a bare in-memory db (resolves to the node:sqlite-backed shim under vitest). */
export function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

/** Read user_version off a db. */
export function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}
