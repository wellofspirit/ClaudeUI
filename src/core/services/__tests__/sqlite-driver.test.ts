/**
 * Driver conformance under vitest — `node:sqlite`, and real `better-sqlite3`
 * when the installed binary's ABI allows it (S3 stage 1).
 *
 * The `bun:sqlite` arm is NOT here and cannot be: it is a bun builtin and this
 * suite runs on node. It is covered by `scripts/verify-bun-sqlite.ts`, which
 * runs the SAME exported spec under bun.
 *
 * **Why the better-sqlite3 arm is conditional.** The repo's `better-sqlite3` is
 * rebuilt against the ELECTRON ABI by `bun run rebuild:native` (that is the
 * whole reason `vitest.config.ts` aliases the package to a `node:sqlite` stub).
 * So whether plain-node vitest can `dlopen` it depends on which rebuild ran
 * last — right now bun's install has left a Node-ABI build and it loads fine,
 * but after `rebuild:native` it will not. An unconditional arm would therefore
 * be a test that breaks for the developer who followed the documented workflow,
 * which is worse than no test. It is skipped, loudly, instead — and unlike the
 * aliased import, the load here goes through an ABSOLUTE PATH so that when it
 * does run it is testing the real native module and not the stub.
 */

import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { runSqliteDriverConformance } from './sqlite-driver-conformance'
import {
  emulatePragma,
  normalizeGet,
  setSqliteDriver,
  getSqliteDriver,
  resetSqliteDriver,
  installedSqliteDriverName,
  type SqliteDriver
} from '../sqlite-driver'
import { nodeSqliteDriver } from '../sqlite/node-sqlite-driver'
import { DatabaseSync } from 'node:sqlite'

/** The `node:sqlite` driver with its engine injected (S3 stage 1 / stage 3). */
const nodeDriver = (): ReturnType<typeof nodeSqliteDriver> => nodeSqliteDriver(DatabaseSync)

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-sqlite-conformance-'))

afterAll(() => {
  // Individual removes, never a recursive force-delete.
  for (const entry of fs.readdirSync(tmpRoot)) {
    try {
      fs.rmSync(path.join(tmpRoot, entry), { force: true })
    } catch {
      /* a WAL sidecar may already be gone */
    }
  }
  try {
    fs.rmdirSync(tmpRoot)
  } catch {
    /* best effort */
  }
})

function freshDbPath(label: string): string {
  return path.join(tmpRoot, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

// ---------------------------------------------------------------------------
// node:sqlite — always runs
// ---------------------------------------------------------------------------

describe('sqlite driver conformance — node:sqlite', () => {
  it('satisfies the shared spec', () => {
    runSqliteDriverConformance(nodeDriver(), freshDbPath('node'))
  })
})

// ---------------------------------------------------------------------------
// better-sqlite3 — the desktop's engine, when this runtime can load it
// ---------------------------------------------------------------------------

/**
 * Load the REAL better-sqlite3 by absolute path, bypassing vitest's alias to the
 * stub. Returns null when the native binary cannot be loaded here (an
 * Electron-ABI build under plain node), which is a skip and not a failure.
 */
function loadRealBetterSqlite3(): SqliteDriver | null {
  try {
    const require_ = createRequire(import.meta.url)
    const resolved = path.join(process.cwd(), 'node_modules', 'better-sqlite3')
    const Ctor = require_(resolved) as new (
      filename: string,
      options?: Record<string, unknown>
    ) => {
      exec(sql: string): unknown
      pragma(source: string, options?: { simple?: boolean }): unknown
      prepare(sql: string): {
        run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }
        get(...p: unknown[]): unknown
        all(...p: unknown[]): unknown[]
      }
      close(): void
    }
    // Prove it actually opens before declaring the arm live — resolving the
    // module is not the same as dlopen'ing its addon.
    new Ctor(':memory:').close()

    return {
      name: 'better-sqlite3',
      open(filename, options) {
        const inner = options
          ? new Ctor(filename, options as unknown as Record<string, unknown>)
          : new Ctor(filename)
        return {
          exec: (sql) => {
            inner.exec(sql)
          },
          pragma: (source, opts) => inner.pragma(source, opts),
          prepare(sql) {
            const stmt = inner.prepare(sql)
            return {
              run: (...p) => stmt.run(...p),
              get: (...p) => normalizeGet(stmt.get(...p)),
              all: (...p) => stmt.all(...p)
            }
          },
          close: () => inner.close()
        }
      }
    }
  } catch {
    return null
  }
}

const realBetterSqlite3 = loadRealBetterSqlite3()

describe.skipIf(realBetterSqlite3 === null)(
  'sqlite driver conformance — better-sqlite3 (native)',
  () => {
    it('satisfies the same spec as the builtins', () => {
      runSqliteDriverConformance(realBetterSqlite3 as SqliteDriver, freshDbPath('bs3'))
    })
  }
)

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

describe('the driver seam', () => {
  it('throws a directive error when no driver was installed', () => {
    const previous = getSqliteDriver()
    resetSqliteDriver()
    try {
      expect(() => getSqliteDriver()).toThrow(/No SQLite driver installed/)
      expect(installedSqliteDriverName()).toBeNull()
    } finally {
      // Restore the setup file's driver — this module's tests share a process
      // with everything else in the project.
      setSqliteDriver(previous)
    }
  })

  it('reports the installed driver name', () => {
    const previous = getSqliteDriver()
    try {
      setSqliteDriver(nodeDriver())
      expect(installedSqliteDriverName()).toBe('node:sqlite')
    } finally {
      setSqliteDriver(previous)
    }
  })

  it('re-installing the same driver is accepted', () => {
    const previous = getSqliteDriver()
    try {
      setSqliteDriver(nodeDriver())
      expect(() => setSqliteDriver(nodeDriver())).not.toThrow()
    } finally {
      setSqliteDriver(previous)
    }
  })
})

describe('emulatePragma', () => {
  function fakeHandle(): {
    handle: { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } }
    execed: string[]
    prepared: string[]
  } {
    const execed: string[] = []
    const prepared: string[] = []
    return {
      execed,
      prepared,
      handle: {
        exec: (sql) => {
          execed.push(sql)
        },
        prepare: (sql) => {
          prepared.push(sql)
          return { all: () => [{ user_version: 7, second: 'ignored' }] }
        }
      }
    }
  }

  it('prepares every pragma — writes included — and returns its rows', () => {
    // The reference engine makes no write/read distinction, so neither does the
    // emulation. A `=` form goes through prepare(), not exec().
    const { handle, prepared, execed } = fakeHandle()
    expect(emulatePragma(handle, 'user_version = 7')).toEqual([
      { user_version: 7, second: 'ignored' }
    ])
    expect(prepared).toEqual(['PRAGMA user_version = 7;'])
    expect(execed).toEqual([])
  })

  it('returns rows for a READ, and the first column under {simple}', () => {
    const { handle } = fakeHandle()
    expect(emulatePragma(handle, 'user_version')).toEqual([{ user_version: 7, second: 'ignored' }])
    expect(emulatePragma(handle, 'user_version', { simple: true })).toBe(7)
  })

  it('is undefined under {simple} when the pragma returns no rows', () => {
    const handle = { exec: () => {}, prepare: () => ({ all: () => [] }) }
    expect(emulatePragma(handle, 'foreign_keys = ON', { simple: true })).toBeUndefined()
    expect(emulatePragma(handle, 'foreign_keys = ON')).toEqual([])
  })

  it('falls back to exec (and no rows) when the engine refuses to prepare a pragma', () => {
    const execed: string[] = []
    const handle = {
      exec: (sql: string) => {
        execed.push(sql)
      },
      prepare: () => {
        throw new Error('this engine cannot prepare that pragma')
      }
    }
    expect(emulatePragma(handle, 'optimize')).toEqual([])
    expect(execed).toEqual(['PRAGMA optimize;'])
  })
})

describe('normalizeGet', () => {
  it('maps null to undefined and passes everything else through', () => {
    expect(normalizeGet(null)).toBeUndefined()
    expect(normalizeGet(undefined)).toBeUndefined()
    const row = { id: 1 }
    expect(normalizeGet(row)).toBe(row)
    // 0 and '' are legitimate values, not misses.
    expect(normalizeGet(0)).toBe(0)
    expect(normalizeGet('')).toBe('')
  })
})
