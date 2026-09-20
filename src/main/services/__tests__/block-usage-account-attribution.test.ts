/**
 * @vitest-environment node
 *
 * ADR-071 §3 / S2a2 — the SECOND Claude row writer.
 *
 * `usage-reconciler.test.ts` covers the reconciler's Claude builder. This file
 * covers block-usage's own inline upsert, which races it for the same
 * `message_id`, plus the disk half neither unit test reaches: reading the
 * account log off the filesystem and resolving an entry's timestamp against it.
 *
 * SAFETY: `node:os`.homedir is mocked to a temp directory, so
 * `~/.claude/projects`, `~/.claude/ui/usage` and the account log all resolve
 * inside it. The DB is the in-memory node:sqlite stub. Nothing here reads a
 * real transcript, a real account log or a credential file, and every account
 * id, email and organization below is invented.
 *
 * `blockUsageService` is a singleton with a scan cache, so each test takes a
 * fresh module graph (`vi.resetModules()`) against its own temp home rather
 * than inheriting the previous test's cached entries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// block-usage asks the fetcher for the live window; there is none in a test,
// and the real module would reach for the developer's own usage cache.
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: {
    updateFromRateLimitEvent: vi.fn(),
    fetch: vi.fn(async () => null),
    getLastUsage: () => null,
    getActiveAccount: () => null,
    getActiveAccountUuid: () => undefined
  }
}))
vi.mock('../../../core/services/sync-host', () => ({ emitEvent: vi.fn() }))

const MESSAGE_ID = 'msg_attributed'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

let testHome: string

/** One assistant line in the shape cli.js writes. Every value is invented. */
function assistantLine(ts: number, messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      id: messageId,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 50 }
    }
  })
}

function seedTranscript(ts: number, messageId = MESSAGE_ID): void {
  const dir = join(testHome, '.claude', 'projects', '-fake-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), assistantLine(ts, messageId) + '\n', 'utf-8')
}

function seedAccountLog(records: Array<Record<string, unknown>>): void {
  const dir = join(testHome, '.claude', 'ui', 'usage')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'account-log.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8'
  )
}

/** A block-usage + db pair from one fresh module graph. */
async function freshModules(): Promise<{
  blockUsage: typeof import('../../../core/services/block-usage')
  db: typeof import('../../../core/services/db')
}> {
  vi.resetModules()
  // The driver seam is module state too, and the vitest setup file installed
  // it into the graph we just threw away (see src/test/setup/node.setup.ts).
  const { setSqliteDriver } = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  setSqliteDriver(betterSqlite3Driver())
  return {
    blockUsage: await import('../../../core/services/block-usage'),
    db: await import('../../../core/services/db')
  }
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'block-usage-attribution-'))
  home.value = testHome
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('block-usage — Claude rows name the subscription', () => {
  it('writes the key, the label and the billing type the log recorded', async () => {
    const ts = Date.now() - 60_000
    seedAccountLog([
      {
        ts: ts - 10_000,
        accountUuid: 'acc_1',
        email: 'someone@example.test',
        organizationUuid: 'org_personal',
        organizationName: 'Personal',
        billingType: 'subscription'
      }
    ])
    seedTranscript(ts)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    const row = db.getUsageEventByMessageId(MESSAGE_ID)
    expect(row).toBeDefined()
    expect(row!.accountKey).toBe('anthropic:org_personal:acc_1')
    expect(row!.accountLabel).toBe('someone@example.test (Personal)')
    expect(row!.billingType).toBe('subscription')
    expect(row!.accountUuid).toBe('acc_1')
    // A subscription's list price is the API cost and nothing was billed.
    expect(row!.billedCostUsd).toBe(0)
    expect(row!.apiCostUsd!).toBeGreaterThan(0)
    db.closeDb()
  })

  it('leaves an entry resolved to a pre-ADR-071 record in the unknown bucket', async () => {
    const ts = Date.now() - 60_000
    seedAccountLog([{ ts: ts - 10_000, accountUuid: 'acc_1', email: 'someone@example.test' }])
    seedTranscript(ts)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    const row = db.getUsageEventByMessageId(MESSAGE_ID)
    expect(row!.accountKey).toBe('unknown')
    expect(row!.accountLabel).toBeNull()
    expect(row!.billingType).toBe('unknown')
    // Still attributable by email/uuid for the usage view's account filter.
    expect(row!.accountUuid).toBe('acc_1')
    db.closeDb()
  })

  it('hands the reconciler the same attribution it writes itself', async () => {
    const ts = Date.now() - 60_000
    seedAccountLog([
      {
        ts: ts - 10_000,
        accountUuid: 'acc_1',
        email: 'someone@example.test',
        organizationUuid: 'org_work',
        billingType: 'apiKey'
      }
    ])
    seedTranscript(ts)
    const { blockUsage, db } = await freshModules()

    const entries = await blockUsage.blockUsageService.getClaudeEntriesForReconcile()

    expect(entries).toHaveLength(1)
    expect(entries[0].account).toEqual({
      email: 'someone@example.test',
      accountUuid: 'acc_1',
      accountKey: 'anthropic:org_work:acc_1',
      // No organization name in the record — the bare email is the label.
      accountLabel: 'someone@example.test',
      billingType: 'apiKey'
    })
    db.closeDb()
  })
})
