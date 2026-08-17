/**
 * @vitest-environment node
 *
 * Tests for the account repository (Phase 4 / ADR-021):
 *  - DB v2 migration creates the account table
 *  - getAllAccounts / upsertAccount / deleteAccountRow round-trip
 *  - importAccountsOnce is idempotent
 *
 * Uses the node:sqlite-backed better-sqlite3 shim (never loads native .node).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getAllAccounts,
  upsertAccount,
  deleteAccountRow,
  importAccountsOnce,
  closeDb
} from '../../../core/services/db'
import type { AccountInfo } from '../../../shared/types'

// Each test gets a fresh in-memory DB (closeDb() resets the singleton).
// afterEach mirrors beforeEach so the singleton can't leak past the last test.
beforeEach(() => {
  closeDb()
})
afterEach(() => {
  closeDb()
})

function makeAccount(overrides?: Partial<AccountInfo>): AccountInfo {
  return {
    id: `acct-${Math.random().toString(36).slice(2)}`,
    email: 'test@example.com',
    subscriptionType: 'max',
    organization: null,
    createdAt: Date.now(),
    ...overrides
  }
}

describe('account table (v2 migration)', () => {
  it('account table exists after v2 migration runs', () => {
    // runMigrations is called implicitly by getDb() on first use.
    const accounts = getAllAccounts()
    expect(Array.isArray(accounts)).toBe(true)
    expect(accounts).toHaveLength(0)
  })

  it('upsertAccount inserts a new row', () => {
    const acc = makeAccount({ email: 'alice@example.com' })
    upsertAccount(acc)
    const rows = getAllAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(acc.id)
    expect(rows[0].email).toBe('alice@example.com')
    expect(rows[0].subscriptionType).toBe('max')
  })

  it('upsertAccount updates email on conflict', () => {
    const acc = makeAccount({ email: 'alice@example.com' })
    upsertAccount(acc)
    upsertAccount({ ...acc, email: 'alice-updated@example.com' })
    const rows = getAllAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('alice-updated@example.com')
  })

  it('deleteAccountRow removes a row', () => {
    const acc = makeAccount()
    upsertAccount(acc)
    expect(getAllAccounts()).toHaveLength(1)
    deleteAccountRow(acc.id)
    expect(getAllAccounts()).toHaveLength(0)
  })

  it('deleteAccountRow is a no-op for unknown id', () => {
    deleteAccountRow('nonexistent')
    expect(getAllAccounts()).toHaveLength(0)
  })

  it('getAllAccounts returns rows in created_at order', () => {
    const a = makeAccount({ createdAt: 1000 })
    const b = makeAccount({ createdAt: 3000 })
    const c = makeAccount({ createdAt: 2000 })
    upsertAccount(b)
    upsertAccount(a)
    upsertAccount(c)
    const rows = getAllAccounts()
    expect(rows.map((r) => r.createdAt)).toEqual([1000, 2000, 3000])
  })
})

describe('importAccountsOnce', () => {
  it('imports accounts when table is empty', () => {
    const accounts = [makeAccount({ email: 'a@x.com' }), makeAccount({ email: 'b@x.com' })]
    importAccountsOnce(accounts)
    const rows = getAllAccounts()
    expect(rows).toHaveLength(2)
  })

  it('is idempotent — does not re-import when table already has rows', () => {
    const accounts = [makeAccount({ email: 'a@x.com' })]
    importAccountsOnce(accounts)
    // Second call should be a no-op.
    importAccountsOnce([makeAccount({ email: 'b@x.com' })])
    // Still only the first import's rows.
    expect(getAllAccounts()).toHaveLength(1)
  })

  it('is a no-op when accounts array is empty', () => {
    importAccountsOnce([])
    expect(getAllAccounts()).toHaveLength(0)
  })
})
