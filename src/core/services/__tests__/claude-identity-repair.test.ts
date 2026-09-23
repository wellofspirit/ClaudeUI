/**
 * @vitest-environment node
 *
 * S2e — the one-shot re-key of the rows written under a stale attribution.
 *
 * `~/.claude.json` names whichever cli.js process refetched the profile last,
 * so every Claude row written since the account log's last record may be keyed
 * to the wrong subscription. The owner confirmed every Claude session in that
 * span ran under the ACTIVE dir, which is what makes a time-bounded re-key
 * possible at all: no row carries a dir id to repair by.
 *
 * DB is isolated per test by redirecting `os.homedir()` at a temp dir — the same
 * harness `usage-window-ledger.test.ts` uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'claude-identity-repair-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

type DbModule = typeof import('../db')
type IdentityModule = typeof import('../claude-account-identity')
type UsageEventInsert = import('../db').UsageEventInsert
type WindowSampleRow = import('../db').WindowSampleRow

const HOUR = 60 * 60 * 1000

/** A fixed instant, far enough in the past that the app's clock is irrelevant. */
const NOW = new Date('2026-06-15T12:00:00.000Z').getTime()
/** The last account-log record's timestamp — everything at or after it moves. */
const SINCE = NOW - 24 * HOUR

const STALE_KEY = 'anthropic:org-personal:acc-1'
const DIR_KEY = 'anthropic:org-company:acc-2'
const OTHER_KEY = 'anthropic:org-third:acc-3'

async function fresh(): Promise<{ db: DbModule; identity: IdentityModule }> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` too, and the seam has
  // no default engine — install the driver right where the fresh `db` is
  // imported, exactly as the window-ledger suite does.
  const driverSeam = await import('../sqlite-driver')
  const { betterSqlite3Driver } = await import('../sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../db')
  const identity = await import('../claude-account-identity')
  return { db, identity }
}

let eventSeq = 0
function event(accountKey: string, ts: number): UsageEventInsert {
  eventSeq += 1
  const id = `e-${eventSeq}`
  return {
    id,
    ts,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: 'acc-1',
    modelId: 'claude-opus-4-8',
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: 1,
    engineCostUsd: null,
    sessionId: 's1',
    messageId: id,
    source: 'live',
    accountKey,
    accountLabel: 'personal@example.com',
    billingType: 'subscription',
    origin: 'session',
    apiCostUsd: 1,
    billedCostUsd: 0
  }
}

let sampleSeq = 0
function sample(accountKey: string, ts: number): WindowSampleRow {
  sampleSeq += 1
  return {
    id: `ws-${sampleSeq}`,
    ts,
    accountUuid: 'acc-1',
    usedPercent: 20,
    canonicalEnd: ts + HOUR,
    accountKey,
    windowKind: '5h',
    windowMinutes: null
  }
}

function bucket(db: DbModule, accountKey: string, hourUtc: number): void {
  db.upsertUsageBuckets([
    {
      hourUtc,
      accountKey,
      billingType: 'subscription',
      engineId: 'claude',
      vendorId: 'anthropic',
      modelId: 'claude-opus-4-8',
      origin: 'session',
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      apiCostUsd: 1,
      billedCostUsd: 0,
      unbilledApiCostUsd: 0,
      unknownApiCostCount: 0,
      unknownBilledCostCount: 0,
      requestCount: 1,
      source: 'rollup'
    }
  ])
}

const DIR_IDENTITY = {
  accountUuid: 'acc-2',
  email: 'alice@example.com',
  organizationUuid: 'org-company',
  billingType: 'subscription' as const
}

const LAST_RECORD = {
  ts: SINCE,
  accountUuid: 'acc-1',
  email: 'personal@example.com',
  organizationUuid: 'org-personal',
  billingType: 'subscription' as const
}

/** The ledger, samples, windows and buckets the repair has to move — or not. */
function seedLedger(db: DbModule): void {
  db.insertUsageEvents([
    event(STALE_KEY, SINCE - HOUR), // before the switch — stays
    event(STALE_KEY, SINCE), // exactly at it — moves
    event(STALE_KEY, SINCE + HOUR), // after — moves
    event(OTHER_KEY, SINCE + HOUR) // another account — untouched
  ])
  db.recordWindowSample(sample(STALE_KEY, SINCE - HOUR))
  db.recordWindowSample(sample(STALE_KEY, SINCE + HOUR))
  db.recordWindowSample(sample(OTHER_KEY, SINCE + HOUR))
  db.upsertUsageWindows([
    {
      accountKey: STALE_KEY,
      windowKind: '5h',
      canonicalEnd: SINCE + 2 * HOUR,
      windowStart: SINCE - 3 * HOUR,
      windowMinutes: null,
      peakPercent: 30,
      apiCostUsd: 2,
      billedCostUsd: 0,
      unknownCostCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      sampleCount: 2,
      closed: false,
      updatedAt: NOW
    },
    {
      accountKey: STALE_KEY,
      windowKind: '5h',
      canonicalEnd: SINCE - 2 * HOUR,
      windowStart: SINCE - 7 * HOUR,
      windowMinutes: null,
      peakPercent: 10,
      apiCostUsd: 1,
      billedCostUsd: 0,
      unknownCostCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      sampleCount: 1,
      closed: true,
      updatedAt: NOW
    }
  ])
  bucket(db, STALE_KEY, SINCE - HOUR)
  bucket(db, STALE_KEY, SINCE + HOUR)
  bucket(db, OTHER_KEY, SINCE + HOUR)
}

function eventKeys(db: DbModule): Array<{ ts: number; accountKey: string }> {
  return db
    .getUsageEventsSince(0)
    .map((r) => ({ ts: r.ts, accountKey: r.accountKey }))
    .sort((a, b) => a.ts - b.ts || a.accountKey.localeCompare(b.accountKey))
}

describe('the one-shot identity repair', () => {
  it('moves only the rows at or after the log’s last record', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })

      expect(eventKeys(db)).toEqual([
        { ts: SINCE - HOUR, accountKey: STALE_KEY },
        { ts: SINCE, accountKey: DIR_KEY },
        { ts: SINCE + HOUR, accountKey: DIR_KEY },
        { ts: SINCE + HOUR, accountKey: OTHER_KEY }
      ])
      const moved = db.getUsageEventsSince(SINCE).find((r) => r.accountKey === DIR_KEY)
      expect(moved).toMatchObject({ accountUuid: 'acc-2', billingType: 'subscription' })
    } finally {
      db.closeDb()
    }
  })

  it('labels the moved rows with the email and the organization', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        organizationName: 'Company',
        lastRecord: LAST_RECORD,
        now: NOW
      })

      // The same rule `claudeAccountLabel` applies to a row attributed by time,
      // so a re-keyed row and a live one read identically in the dashboard.
      const moved = db.getUsageEventsSince(SINCE).filter((r) => r.accountKey === DIR_KEY)
      expect(moved).toHaveLength(2)
      for (const row of moved) expect(row.accountLabel).toBe('alice@example.com (Company)')
    } finally {
      db.closeDb()
    }
  })

  it('labels with the email alone when no organization was captured', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })

      const moved = db.getUsageEventsSince(SINCE).filter((r) => r.accountKey === DIR_KEY)
      for (const row of moved) expect(row.accountLabel).toBe('alice@example.com')
    } finally {
      db.closeDb()
    }
  })

  it('re-keys the samples the same way, and leaves another account alone', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })

      expect(db.latestWindowSamples(DIR_KEY).map((s) => s.ts)).toEqual([SINCE + HOUR])
      expect(db.latestWindowSamples(DIR_KEY)[0].accountUuid).toBe('acc-2')
      expect(db.latestWindowSamples(STALE_KEY).map((s) => s.ts)).toEqual([SINCE - HOUR])
      expect(db.latestWindowSamples(OTHER_KEY).map((s) => s.ts)).toEqual([SINCE + HOUR])
    } finally {
      db.closeDb()
    }
  })

  it('drops the stale account’s windows that end inside the span, and keeps the rest', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })

      // The next recompute re-seeds the dropped one from the re-keyed samples.
      expect(db.listUsageWindows({ accountKey: STALE_KEY }).map((w) => w.canonicalEnd)).toEqual([
        SINCE - 2 * HOUR
      ])
    } finally {
      db.closeDb()
    }
  })

  it('drops the stale account’s buckets inside the span so the rollup rebuilds them', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })

      const keysByHour = db
        .getUsageBucketsSince(0)
        .map((b) => `${b.hourUtc}:${b.accountKey}`)
        .sort()
      expect(keysByHour).toEqual(
        [
          `${Math.floor((SINCE - HOUR) / HOUR) * HOUR}:${STALE_KEY}`,
          `${Math.floor((SINCE + HOUR) / HOUR) * HOUR}:${OTHER_KEY}`
        ].sort()
      )
    } finally {
      db.closeDb()
    }
  })

  it('marks the repair done, and a second run moves nothing', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: LAST_RECORD,
        now: NOW
      })
      expect(db.getMeta('claude_identity_repair')).toMatch(/^done:/)
      const after = eventKeys(db)

      // Idempotence is the whole safety property: the marker is the only thing
      // standing between one re-key and a second one that would move rows the
      // user has since written under the correct account.
      identity.repairClaudeIdentityOnce({
        identity: { ...DIR_IDENTITY, accountUuid: 'acc-4', organizationUuid: 'org-fourth' },
        lastRecord: LAST_RECORD,
        now: NOW + HOUR
      })

      expect(eventKeys(db)).toEqual(after)
    } finally {
      db.closeDb()
    }
  })

  it('moves nothing when the log already names the dir’s account', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: { ...LAST_RECORD, accountUuid: 'acc-2', organizationUuid: 'org-company' },
        now: NOW
      })

      expect(eventKeys(db).filter((r) => r.accountKey === DIR_KEY)).toEqual([])
      expect(db.getMeta('claude_identity_repair')).toMatch(/^done:/)
    } finally {
      db.closeDb()
    }
  })

  it('moves nothing when the log’s last record names no subscription', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      // A pre-ADR-071 record carries no organization, so it resolves to the
      // shared `unknown` bucket — which holds every account's unattributable
      // rows and must never be re-keyed to one of them.
      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: { ts: SINCE, accountUuid: 'acc-1', email: 'personal@example.com' },
        now: NOW
      })

      expect(eventKeys(db).filter((r) => r.accountKey === DIR_KEY)).toEqual([])
      expect(db.getMeta('claude_identity_repair')).toMatch(/^done:/)
    } finally {
      db.closeDb()
    }
  })

  it('marks done without moving anything when there is no log at all', async () => {
    const { db, identity } = await fresh()
    try {
      seedLedger(db)

      identity.repairClaudeIdentityOnce({ identity: DIR_IDENTITY, lastRecord: null, now: NOW })

      expect(eventKeys(db).filter((r) => r.accountKey === DIR_KEY)).toEqual([])
      expect(db.getMeta('claude_identity_repair')).toMatch(/^done:/)
    } finally {
      db.closeDb()
    }
  })

  it('leaves buckets the rollup cannot reach, and says how many', async () => {
    const { db, identity } = await fresh()
    try {
      // A switch older than the rollup's 7-day reach: deleting a bucket it will
      // never rebuild would simply lose that hour's spend.
      const longAgo = NOW - 30 * 24 * HOUR
      db.insertUsageEvents([event(STALE_KEY, longAgo)])
      bucket(db, STALE_KEY, Math.floor(longAgo / HOUR) * HOUR)

      identity.repairClaudeIdentityOnce({
        identity: DIR_IDENTITY,
        lastRecord: { ...LAST_RECORD, ts: longAgo },
        now: NOW
      })

      // The ledger row moved; its bucket stayed, because nothing would rebuild it.
      expect(eventKeys(db)).toEqual([{ ts: longAgo, accountKey: DIR_KEY }])
      expect(db.getUsageBucketsSince(0).map((b) => b.accountKey)).toEqual([STALE_KEY])
    } finally {
      db.closeDb()
    }
  })
})

describe('migration v23', () => {
  it('clears every account row’s identity columns and arms the repair', async () => {
    const { db } = await fresh()
    const { betterSqlite3Driver } = await import('../sqlite/better-sqlite3-driver')
    const handle = betterSqlite3Driver().open(':memory:')
    try {
      // Stop at v22 — the shape the owner's real database is in — then stamp
      // the four identity columns the shared `~/.claude.json` filled in.
      db.runMigrations(
        handle,
        db.MIGRATIONS.filter((m) => m.version <= 22)
      )
      handle
        .prepare(
          `INSERT INTO account
             (id, email, subscription_type, organization, created_at,
              account_uuid, organization_uuid, organization_name, billing_type)
           VALUES ('acct-a', 'alice@example.com', 'max', 'Company', 1,
                   'acc-1', 'org-personal', 'Personal', 'subscription')`
        )
        .run()

      db.runMigrations(handle)

      const row = handle.prepare('SELECT * FROM account WHERE id = ?').get('acct-a') as Record<
        string,
        unknown
      >
      // Not one of the four was derived from the account's OWN credential, so
      // none of them is trustworthy — the dir is re-stamped at the next boot.
      expect(row.account_uuid).toBeNull()
      expect(row.organization_uuid).toBeNull()
      expect(row.organization_name).toBeNull()
      expect(row.billing_type).toBeNull()
      expect(row.identity_checked_at).toBeNull()
      // The login-captured columns are untouched: they came from cli.js's own
      // control response for THAT dir, and are what a label still reads.
      expect(row.email).toBe('alice@example.com')
      expect(row.organization).toBe('Company')

      const marker = handle
        .prepare("SELECT value FROM meta WHERE key = 'claude_identity_repair'")
        .get() as { value: string } | undefined
      expect(marker?.value).toBe('pending')
    } finally {
      handle.close()
      db.closeDb()
    }
  })
})
