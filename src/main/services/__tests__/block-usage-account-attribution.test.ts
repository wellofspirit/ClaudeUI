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

/**
 * One assistant line in the shape cli.js writes. Every value is invented.
 *
 * `entrypoint` is a real top-level field on every transcript line — `claude-desktop`
 * on the sessions this app spawns (`src/core/sdk/args.ts` sets it), and `cli` /
 * `sdk-cli` / `sdk-ts` on the ones it does not.
 */
function assistantLine(
  ts: number,
  messageId: string,
  entrypoint: string | null = 'claude-desktop'
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    // null writes no field at all — the shape of a transcript from a client
    // that does not record one.
    ...(entrypoint === null ? {} : { entrypoint }),
    message: {
      id: messageId,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 50 }
    }
  })
}

function seedTranscript(
  ts: number,
  messageId = MESSAGE_ID,
  entrypoint: string | null = 'claude-desktop'
): void {
  const dir = join(testHome, '.claude', 'projects', '-fake-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${SESSION_ID}.jsonl`),
    assistantLine(ts, messageId, entrypoint) + '\n',
    'utf-8'
  )
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

/**
 * A block-usage + db pair from one fresh module graph.
 *
 * `securestorage` comes from the SAME graph on purpose: the applied credential
 * dir is module state, so setting it on the outer graph's copy would leave the
 * block-usage under test reading a different (empty) one.
 */
async function freshModules(): Promise<{
  blockUsage: typeof import('../../../core/services/block-usage')
  db: typeof import('../../../core/services/db')
  securestorage: typeof import('../../../core/sdk/securestorage-env')
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
    db: await import('../../../core/services/db'),
    securestorage: await import('../../../core/sdk/securestorage-env')
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

// ---------------------------------------------------------------------------
// S2g — a switch whose identity could not be read defers rows; it never lends
// them to the account the user just switched AWAY from.
//
// The 2026-09-21 incident: the switch's own record landed thirteen minutes
// late, and 65 rows ($6.78) written in between were keyed to the OLD
// subscription because the log's last record still named it.
// ---------------------------------------------------------------------------

const COMPANY = {
  accountUuid: 'acc_company',
  email: 'work@example.test',
  organizationUuid: 'org_company',
  billingType: 'subscription'
}
const PERSONAL = {
  accountUuid: 'acc_personal',
  email: 'me@example.test',
  organizationUuid: 'org_personal',
  billingType: 'subscription'
}

describe('block-usage — rows under an unresolved account switch', () => {
  it('writes NO row while the switch is unresolved', async () => {
    const switchAt = Date.now() - 120_000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt + 30_000)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    // Not `unknown`, not the company's key: no row at all. A row cannot be
    // re-keyed once written, so one that cannot be keyed yet waits.
    expect(db.getUsageEventByMessageId(MESSAGE_ID)).toBeUndefined()
    expect(db.countUsageEvents()).toBe(0)
    db.closeDb()
  })

  it('hands the reconciler nothing for a deferred entry either', async () => {
    const switchAt = Date.now() - 120_000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt + 30_000)
    const { blockUsage, db } = await freshModules()

    expect(await blockUsage.blockUsageService.getClaudeEntriesForReconcile()).toEqual([])
    db.closeDb()
  })

  it('keeps the rows BEFORE the switch on the account that ran them', async () => {
    const switchAt = Date.now() - 120_000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt - 30_000)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    expect(db.getUsageEventByMessageId(MESSAGE_ID)!.accountKey).toBe(
      'anthropic:org_company:acc_company'
    )
    db.closeDb()
  })

  it('writes the deferred rows under the NEW account, at their own timestamps, once it resolves', async () => {
    const switchAt = Date.now() - 120_000
    const turnAt = switchAt + 30_000
    // The real record carries the MARKER's ts and is the later line, which is
    // how the fetcher closes a deferral.
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true },
      { ts: switchAt, ...PERSONAL }
    ])
    seedTranscript(turnAt)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    const row = db.getUsageEventByMessageId(MESSAGE_ID)
    expect(row!.accountKey).toBe('anthropic:org_personal:acc_personal')
    expect(row!.accountLabel).toBe('me@example.test')
    expect(row!.ts).toBe(turnAt)
    db.closeDb()
  })

  // Round 2, R5 — the bound. A gap the app can never close (a profile endpoint
  // that never answers, or a folder switched away from before it resolved)
  // would otherwise take its rows to the grave once they left the scan window.
  it('writes a row under a marker older than the deferral bound as `unknown`', async () => {
    const switchAt = Date.now() - 25 * 60 * 60 * 1000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt + 60_000)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    const row = db.getUsageEventByMessageId(MESSAGE_ID)
    // A FIRST write, not a re-key: nothing under the old key, nothing to move.
    expect(row!.accountKey).toBe('unknown')
    expect(row!.accountLabel).toBeNull()
    expect(row!.billingType).toBe('unknown')
    db.closeDb()
  })

  it('still defers under a marker that is inside the bound', async () => {
    const switchAt = Date.now() - 23 * 60 * 60 * 1000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt + 60_000)
    const { blockUsage, db } = await freshModules()

    await blockUsage.blockUsageService.recalculate()

    expect(db.getUsageEventByMessageId(MESSAGE_ID)).toBeUndefined()
    db.closeDb()
  })

  // Round 3, item 3 — the bound is a comparison against the clock, so the
  // clock has to be read ONCE per pass. Letting each entry read it separately
  // lets two entries under one marker straddle the bound: the hour would be
  // half deferred and half `unknown`, for ever.
  it('samples `now` once per pass and hands it to every entry', async () => {
    const ts = Date.now() - 60_000
    seedAccountLog([{ ts: ts - 10_000, ...PERSONAL }])
    const dir = join(testHome, '.claude', 'projects', '-fake-project')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${SESSION_ID}.jsonl`),
      `${assistantLine(ts, 'msg_one')}\n${assistantLine(ts + 1_000, 'msg_two')}\n`,
      'utf-8'
    )

    const MODULE = '../../../core/services/usage-windows'
    const args: unknown[][] = []
    vi.doMock(MODULE, async () => {
      const actual =
        await vi.importActual<typeof import('../../../core/services/usage-windows')>(MODULE)
      return {
        ...actual,
        claudeAccountAttribution: (...call: unknown[]) => {
          args.push(call)
          return (actual.claudeAccountAttribution as (...c: unknown[]) => unknown)(...call)
        }
      }
    })
    try {
      const { blockUsage, db } = await freshModules()
      await blockUsage.blockUsageService.recalculate()
      db.closeDb()
    } finally {
      vi.doUnmock(MODULE)
    }

    // Both entries were attributed, and both were asked about the same instant.
    expect(args.length).toBeGreaterThan(1)
    expect(typeof args[0][2]).toBe('number')
    expect(new Set(args.map((call) => call[2])).size).toBe(1)
  })

  it('leaves the marker out of the account filter’s email list', async () => {
    const switchAt = Date.now() - 120_000
    seedAccountLog([
      { ts: switchAt - 60_000, ...COMPANY },
      { ts: switchAt, email: '', unresolved: true }
    ])
    seedTranscript(switchAt - 30_000)
    const { blockUsage, db } = await freshModules()

    const data = await blockUsage.blockUsageService.recalculate()

    expect(data.accounts).toEqual(['work@example.test'])
    db.closeDb()
  })
})

// ---------------------------------------------------------------------------
// S2g part 5 — a session this app did not spawn is `unknown` under
// multi-account. `setSecurestorageEnv` is a module value overlaid onto OUR
// spawns, so a terminal `claude` uses the default `~/.claude` login and its
// turns belong to no account the app can name.
// ---------------------------------------------------------------------------

describe('block-usage — the entrypoint decides whether time-based attribution applies', () => {
  const ACCOUNT_DIR = '/nowhere/.claude/ui/accounts/acct-a'

  async function rowFor(
    entrypoint: string | null,
    dir: string | null
  ): Promise<{ [k: string]: unknown }> {
    const ts = Date.now() - 60_000
    seedAccountLog([{ ts: ts - 10_000, ...PERSONAL }])
    seedTranscript(ts, MESSAGE_ID, entrypoint)
    const { blockUsage, db, securestorage } = await freshModules()
    securestorage.setSecurestorageEnv(dir ? { dir } : null)
    await blockUsage.blockUsageService.recalculate()
    const row = db.getUsageEventByMessageId(MESSAGE_ID)
    db.closeDb()
    return row as unknown as { [k: string]: unknown }
  }

  it('attributes a session the app spawned', async () => {
    const row = await rowFor('claude-desktop', ACCOUNT_DIR)
    expect(row.accountKey).toBe('anthropic:org_personal:acc_personal')
  })

  it('keys a terminal session `unknown`, with no label and no billing type', async () => {
    const row = await rowFor('cli', ACCOUNT_DIR)
    expect(row.accountKey).toBe('unknown')
    expect(row.accountLabel).toBeNull()
    expect(row.billingType).toBe('unknown')
    // The row still exists and still counts as spend — it is the ACCOUNT that
    // is unknown, not the usage.
    expect(row.inputTokens).toBe(1000)
  })

  it('keys a line with no entrypoint at all `unknown` too', async () => {
    const row = await rowFor(null, ACCOUNT_DIR)
    expect(row.accountKey).toBe('unknown')
  })

  it('changes nothing in single-account mode, where both share one login', async () => {
    expect((await rowFor('cli', null)).accountKey).toBe('anthropic:org_personal:acc_personal')
    expect((await rowFor('claude-desktop', null)).accountKey).toBe(
      'anthropic:org_personal:acc_personal'
    )
  })
})
