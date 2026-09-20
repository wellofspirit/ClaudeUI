/**
 * @vitest-environment node
 *
 * Tests for the Phase 7 Pass 1 DB migrations and metering repos:
 *   - usage_event migration (v3) + message_id dedup
 *   - usage_window_sample migration (v4)
 *   - insertUsageEvent / insertUsageEvents idempotency
 *   - recordWindowSample / getWindowSamples
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  runMigrations,
  closeDb,
  insertUsageEvent,
  insertUsageEvents,
  getUsageEventByMessageId,
  recordWindowSample,
  getWindowSamples,
  latestWindowSamples,
  pruneUsageTables,
  upsertUsageBuckets,
  getUsageBucketsSince,
  deleteSeedUsageBuckets,
  type UsageEventInsert,
  type WindowSampleRow,
  type UsageBucketWrite,
  type Db
} from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

// ---------------------------------------------------------------------------
// Migration — v3 (usage_event) + v4 (usage_window_sample)
// ---------------------------------------------------------------------------

describe('DB migrations — v3 usage_event + v4 usage_window_sample', () => {
  it('applies all migrations and reaches the latest user_version', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      // Bump alongside MIGRATIONS in db.ts — currently v21 (the account's
      // identity columns and the window samples' account key + kind).
      expect(userVersion(db)).toBe(22)
    } finally {
      db.close()
    }
  })

  it('usage_event table exists after migrations', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const rows = db.prepare('SELECT * FROM usage_event').all()
      expect(rows).toEqual([])
    } finally {
      db.close()
    }
  })

  it('usage_window_sample table exists after migrations', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const rows = db.prepare('SELECT * FROM usage_window_sample').all()
      expect(rows).toEqual([])
    } finally {
      db.close()
    }
  })

  it('usage_event UNIQUE(message_id) constraint is present', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      // Insert a row, then insert again with the same message_id — second must be
      // silently dropped (ON CONFLICT DO NOTHING).
      db.prepare(
        `
        INSERT INTO usage_event
          (id, ts, engine_id, vendor_id, model_id, input_tokens, output_tokens,
           cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
           session_id, message_id, source)
        VALUES ('id1', 1, 'claude', 'anthropic', 'claude-sonnet-4-6', 100, 50, 0, 0, 0, null, 'msg_abc', 'live')
        ON CONFLICT(message_id) DO NOTHING
      `
      ).run()
      db.prepare(
        `
        INSERT INTO usage_event
          (id, ts, engine_id, vendor_id, model_id, input_tokens, output_tokens,
           cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
           session_id, message_id, source)
        VALUES ('id2', 2, 'claude', 'anthropic', 'claude-sonnet-4-6', 999, 999, 0, 0, 0, null, 'msg_abc', 'live')
        ON CONFLICT(message_id) DO NOTHING
      `
      ).run()
      const rows = db.prepare('SELECT * FROM usage_event WHERE message_id = ?').all('msg_abc')
      expect(rows).toHaveLength(1)
      // First insert wins — id1 not id2
      expect((rows[0] as Record<string, unknown>).id).toBe('id1')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// usage_event repository
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<UsageEventInsert> = {}): UsageEventInsert {
  return {
    id: 'evt_' + Math.random().toString(36).slice(2),
    ts: Date.now(),
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 5,
    equivCostUsd: 0.001,
    engineCostUsd: 0.001,
    sessionId: 'ses_test',
    messageId: 'msg_' + Math.random().toString(36).slice(2),
    source: 'live',
    ...overrides
  }
}

describe('insertUsageEvent / getUsageEventByMessageId', () => {
  it('round-trips all fields', () => {
    const event = makeEvent({
      engineId: 'claude',
      vendorId: 'anthropic',
      accountId: 'acc_1',
      accountUuid: 'uuid_1',
      modelId: 'claude-opus-4-8',
      inputTokens: 1234,
      outputTokens: 567,
      cacheWriteTokens: 89,
      cacheWrite1hTokens: 10,
      cacheReadTokens: 100,
      equivCostUsd: 0.0123,
      engineCostUsd: 0.012,
      sessionId: 'ses_abc',
      messageId: 'msg_roundtrip',
      source: 'live'
    })
    insertUsageEvent(event)
    const found = getUsageEventByMessageId('msg_roundtrip')
    expect(found).toBeDefined()
    expect(found!.engineId).toBe('claude')
    expect(found!.vendorId).toBe('anthropic')
    expect(found!.accountId).toBe('acc_1')
    expect(found!.accountUuid).toBe('uuid_1')
    expect(found!.modelId).toBe('claude-opus-4-8')
    expect(found!.inputTokens).toBe(1234)
    expect(found!.outputTokens).toBe(567)
    expect(found!.cacheWriteTokens).toBe(89)
    expect(found!.cacheWrite1hTokens).toBe(10)
    expect(found!.cacheReadTokens).toBe(100)
    expect(found!.equivCostUsd).toBeCloseTo(0.0123)
    expect(found!.engineCostUsd).toBeCloseTo(0.012)
    expect(found!.sessionId).toBe('ses_abc')
    expect(found!.messageId).toBe('msg_roundtrip')
    expect(found!.source).toBe('live')
  })

  it('stores null optional fields correctly', () => {
    const event = makeEvent({
      accountId: null,
      accountUuid: null,
      equivCostUsd: null,
      engineCostUsd: null,
      sessionId: null,
      messageId: 'msg_nulls'
    })
    insertUsageEvent(event)
    const found = getUsageEventByMessageId('msg_nulls')
    expect(found!.accountId).toBeNull()
    expect(found!.accountUuid).toBeNull()
    expect(found!.equivCostUsd).toBeNull()
    expect(found!.engineCostUsd).toBeNull()
    expect(found!.sessionId).toBeNull()
  })

  it('returns undefined for missing message_id', () => {
    expect(getUsageEventByMessageId('does-not-exist')).toBeUndefined()
  })
})

describe('insertUsageEvent — message_id dedup (ON CONFLICT DO NOTHING)', () => {
  it('second insert with same message_id is silently dropped', () => {
    const first = makeEvent({ messageId: 'msg_dedup', inputTokens: 100 })
    const second = makeEvent({ messageId: 'msg_dedup', inputTokens: 999 })
    insertUsageEvent(first)
    insertUsageEvent(second)
    const found = getUsageEventByMessageId('msg_dedup')
    expect(found!.inputTokens).toBe(100) // first wins
  })

  it('different message_ids are distinct rows', () => {
    insertUsageEvent(makeEvent({ messageId: 'msg_a', inputTokens: 10 }))
    insertUsageEvent(makeEvent({ messageId: 'msg_b', inputTokens: 20 }))
    expect(getUsageEventByMessageId('msg_a')!.inputTokens).toBe(10)
    expect(getUsageEventByMessageId('msg_b')!.inputTokens).toBe(20)
  })

  it('live source is preserved even if a backfill insert follows for same message_id', () => {
    insertUsageEvent(makeEvent({ messageId: 'msg_live', source: 'live' }))
    insertUsageEvent(makeEvent({ messageId: 'msg_live', source: 'backfill' }))
    const found = getUsageEventByMessageId('msg_live')
    expect(found!.source).toBe('live') // first insert (live) wins
  })
})

describe('insertUsageEvents — batch insert', () => {
  it('inserts multiple events', () => {
    const events = [
      makeEvent({ messageId: 'batch_1' }),
      makeEvent({ messageId: 'batch_2' }),
      makeEvent({ messageId: 'batch_3' })
    ]
    insertUsageEvents(events)
    expect(getUsageEventByMessageId('batch_1')).toBeDefined()
    expect(getUsageEventByMessageId('batch_2')).toBeDefined()
    expect(getUsageEventByMessageId('batch_3')).toBeDefined()
  })

  it('is idempotent on duplicate message_ids within the batch', () => {
    const events = [
      makeEvent({ messageId: 'dup_in_batch', inputTokens: 100 }),
      makeEvent({ messageId: 'dup_in_batch', inputTokens: 200 })
    ]
    insertUsageEvents(events)
    const found = getUsageEventByMessageId('dup_in_batch')
    expect(found!.inputTokens).toBe(100) // first wins
  })

  it('no-ops on empty array', () => {
    expect(() => insertUsageEvents([])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// usage_window_sample repository
// ---------------------------------------------------------------------------

function makeSample(overrides: Partial<WindowSampleRow> = {}): WindowSampleRow {
  return {
    id: 'ws_' + Math.random().toString(36).slice(2),
    ts: Date.now(),
    accountUuid: 'uuid_test',
    usedPercent: 42.5,
    canonicalEnd: 1_700_000_000_000,
    accountKey: 'anthropic:org_test:uuid_test',
    windowKind: '5h',
    ...overrides
  }
}

describe('recordWindowSample / getWindowSamples', () => {
  it('round-trips all fields', () => {
    const sample = makeSample({
      accountUuid: 'uuid_abc',
      usedPercent: 75.0,
      canonicalEnd: 1_700_100_000_000
    })
    recordWindowSample(sample)
    const rows = getWindowSamples('uuid_abc')
    expect(rows).toHaveLength(1)
    expect(rows[0].accountUuid).toBe('uuid_abc')
    expect(rows[0].usedPercent).toBeCloseTo(75.0)
    expect(rows[0].canonicalEnd).toBe(1_700_100_000_000)
  })

  it('returns empty array for unknown account', () => {
    const rows = getWindowSamples('no-such-account')
    expect(rows).toHaveLength(0)
  })

  it('multiple samples for the same account are returned in ts order', () => {
    recordWindowSample(makeSample({ accountUuid: 'ua', ts: 3000, usedPercent: 30 }))
    recordWindowSample(makeSample({ accountUuid: 'ua', ts: 1000, usedPercent: 10 }))
    recordWindowSample(makeSample({ accountUuid: 'ua', ts: 2000, usedPercent: 20 }))
    const rows = getWindowSamples('ua')
    expect(rows.map((r) => r.usedPercent)).toEqual([10, 20, 30])
  })

  it('samples are isolated by accountUuid', () => {
    recordWindowSample(makeSample({ accountUuid: 'acct_X', usedPercent: 55 }))
    recordWindowSample(makeSample({ accountUuid: 'acct_Y', usedPercent: 66 }))
    expect(getWindowSamples('acct_X')).toHaveLength(1)
    expect(getWindowSamples('acct_Y')).toHaveLength(1)
  })

  it('respects limit parameter by returning the NEWEST rows, ascending (M-DB2)', () => {
    for (let i = 0; i < 10; i++) {
      recordWindowSample(makeSample({ accountUuid: 'limit_test', ts: i * 1000 }))
    }
    const rows = getWindowSamples('limit_test', 5)
    expect(rows).toHaveLength(5)
    // The newest 5 (ts 5000..9000), returned in ascending ts order — NOT the
    // oldest 5. Selecting the oldest (the old ASC-LIMIT behaviour) is exactly
    // the M-DB2 bug: the current window would never appear past `limit` samples.
    expect(rows.map((r) => r.ts)).toEqual([5000, 6000, 7000, 8000, 9000])
  })

  it('keeps the CURRENT window in the result once >limit lifetime samples exist (M-DB2 guard)', () => {
    const OLD_END = 1_000_000
    const CUR_END = 9_000_000
    // 120 samples for an old, expired window, then 10 for the current window.
    for (let i = 0; i < 120; i++) {
      recordWindowSample(
        makeSample({ accountUuid: 'm2', ts: i, canonicalEnd: OLD_END, usedPercent: 1 })
      )
    }
    for (let i = 0; i < 10; i++) {
      recordWindowSample(
        makeSample({ accountUuid: 'm2', ts: 200 + i, canonicalEnd: CUR_END, usedPercent: 50 })
      )
    }
    // Default limit 100. The old ASC-LIMIT-100 returned the OLDEST 100 (all
    // OLD_END) and buildDbProjectionSamples' `canonicalEnd === currentWindowEnd`
    // filter then matched nothing forever. Newest-100 keeps the current window.
    const rows = getWindowSamples('m2')
    expect(rows).toHaveLength(100)
    expect(rows.filter((r) => r.canonicalEnd === CUR_END)).toHaveLength(10)
    // Ascending contract preserved after the internal DESC page + reverse.
    const tsList = rows.map((r) => r.ts)
    expect(tsList).toEqual([...tsList].sort((a, b) => a - b))
  })

  it('is the FIVE-HOUR series only — the weekly kinds must not eat the budget', () => {
    // The projection regresses over 5-hour samples; sharing one LIMIT across
    // every kind would quarter its history on an account with scoped weeklies.
    recordWindowSample(makeSample({ accountUuid: 'kinds', windowKind: '5h', usedPercent: 10 }))
    recordWindowSample(makeSample({ accountUuid: 'kinds', windowKind: '7d', usedPercent: 20 }))
    recordWindowSample(makeSample({ accountUuid: 'kinds', windowKind: '7d:opus', usedPercent: 30 }))

    const rows = getWindowSamples('kinds')

    expect(rows).toHaveLength(1)
    expect(rows[0].usedPercent).toBeCloseTo(10)
  })

  it('multiple samples per window are allowed (no unique constraint)', () => {
    recordWindowSample(makeSample({ accountUuid: 'ua2', canonicalEnd: 100 }))
    recordWindowSample(makeSample({ accountUuid: 'ua2', canonicalEnd: 100 }))
    const rows = getWindowSamples('ua2')
    expect(rows).toHaveLength(2) // both rows kept
  })
})

/**
 * ADR-071 §6 — what an INACTIVE account's limits are answered from when no
 * refresh grant may be spent: the newest sample of each window kind.
 */
describe('latestWindowSamples', () => {
  const KEY = 'anthropic:org_x:uuid_x'

  it('returns the newest sample of every kind, one per kind', () => {
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '5h', ts: 1000, usedPercent: 10 }))
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '5h', ts: 3000, usedPercent: 30 }))
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '7d', ts: 2000, usedPercent: 20 }))

    const rows = latestWindowSamples(KEY)

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r.windowKind, r.usedPercent])).toEqual(
      expect.arrayContaining([
        ['5h', 30],
        ['7d', 20]
      ])
    )
  })

  it('never answers with another account’s samples', () => {
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '5h', ts: 1000, usedPercent: 11 }))
    recordWindowSample(
      makeSample({ accountKey: 'anthropic:org_y:uuid_y', windowKind: '5h', ts: 9000 })
    )

    const rows = latestWindowSamples(KEY)

    expect(rows).toHaveLength(1)
    expect(rows[0].usedPercent).toBeCloseTo(11)
  })

  it('is empty for an account nothing was ever recorded for', () => {
    expect(latestWindowSamples('anthropic:org_none:uuid_none')).toEqual([])
  })

  it('keeps one row per kind even when two share the newest timestamp', () => {
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '5h', ts: 5000 }))
    recordWindowSample(makeSample({ accountKey: KEY, windowKind: '5h', ts: 5000 }))

    expect(latestWindowSamples(KEY)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// pruneUsageTables (M-DB3)
// ---------------------------------------------------------------------------

describe('pruneUsageTables (M-DB3)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('prunes old window samples but keeps the current window (coordinates with M-DB2)', () => {
    const now = Date.now()
    // Old sample (60d ago, expired window) + current-window sample (1h ago).
    recordWindowSample(makeSample({ accountUuid: 'p', ts: now - 60 * DAY, canonicalEnd: 111 }))
    recordWindowSample(
      makeSample({ accountUuid: 'p', ts: now - 1 * 60 * 60 * 1000, canonicalEnd: 222 })
    )

    const res = pruneUsageTables(now)
    expect(res.windowSamplesDeleted).toBe(1)

    const rows = getWindowSamples('p')
    expect(rows).toHaveLength(1)
    expect(rows[0].canonicalEnd).toBe(222) // the current window survives
  })

  it('prunes usage_event rows past the retention floor, keeps recent ones', () => {
    const now = Date.now()
    insertUsageEvent(makeEvent({ messageId: 'old_evt', ts: now - 200 * DAY }))
    insertUsageEvent(makeEvent({ messageId: 'recent_evt', ts: now - 1 * DAY }))

    const res = pruneUsageTables(now)
    expect(res.usageEventsDeleted).toBe(1)
    expect(getUsageEventByMessageId('old_evt')).toBeUndefined()
    expect(getUsageEventByMessageId('recent_evt')).toBeDefined()
  })

  it('honours custom retention windows', () => {
    const now = Date.now()
    recordWindowSample(makeSample({ accountUuid: 'r', ts: now - 10 * DAY }))
    const res = pruneUsageTables(now, { windowSampleDays: 5 })
    expect(res.windowSamplesDeleted).toBe(1)
    expect(getWindowSamples('r')).toHaveLength(0)
  })

  it('is idempotent — a second sweep with the same clock deletes nothing', () => {
    const now = Date.now()
    recordWindowSample(makeSample({ accountUuid: 'i', ts: now - 100 * DAY }))
    insertUsageEvent(makeEvent({ messageId: 'i_old', ts: now - 100 * DAY }))
    pruneUsageTables(now)
    const res2 = pruneUsageTables(now)
    expect(res2.windowSamplesDeleted).toBe(0)
    expect(res2.usageEventsDeleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// usage_bucket repository (ADR-071 §1)
// ---------------------------------------------------------------------------

function makeBucket(overrides: Partial<UsageBucketWrite> = {}): UsageBucketWrite {
  return {
    hourUtc: Date.UTC(2026, 5, 20, 9),
    accountKey: 'anthropic:org-1:acct-1',
    billingType: 'subscription',
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    origin: 'session',
    inputTokens: 1000,
    outputTokens: 500,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 10,
    cacheReadTokens: 50,
    apiCostUsd: 0.012,
    billedCostUsd: 0,
    unbilledApiCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 3,
    source: 'rollup',
    ...overrides
  }
}

describe('usage_bucket repository', () => {
  it('upsertUsageBuckets round-trips every field and stamps the write’s rev', () => {
    const rev = upsertUsageBuckets([makeBucket()])
    const rows = getUsageBucketsSince(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ ...makeBucket(), rev })
  })

  it('REPLACES on the seven dimension columns, under a higher rev', () => {
    const first = upsertUsageBuckets([makeBucket({ inputTokens: 1000, apiCostUsd: 0.01 })])
    const second = upsertUsageBuckets([makeBucket({ inputTokens: 9999, apiCostUsd: 0.99 })])
    const rows = getUsageBucketsSince(0)
    expect(rows).toHaveLength(1) // same key → replaced, not duplicated
    expect(rows[0].inputTokens).toBe(9999)
    expect(rows[0].apiCostUsd).toBeCloseTo(0.99)
    // A puller that has seen the first rev must be told this row changed.
    expect(second).toBeGreaterThan(first)
    expect(rows[0].rev).toBe(second)
  })

  it('every bucket in one write shares the same rev', () => {
    upsertUsageBuckets([makeBucket()])
    const rev = upsertUsageBuckets([
      makeBucket({ modelId: 'a' }),
      makeBucket({ modelId: 'b' }),
      makeBucket({ modelId: 'c' })
    ])
    const revs = getUsageBucketsSince(0)
      .filter((r) => r.modelId !== 'claude-sonnet-4-6')
      .map((r) => r.rev)
    expect(revs).toEqual([rev, rev, rev])
  })

  it('each dimension column is part of the key', () => {
    upsertUsageBuckets([
      makeBucket(),
      makeBucket({ hourUtc: Date.UTC(2026, 5, 20, 10) }),
      makeBucket({ accountKey: 'other' }),
      makeBucket({ billingType: 'apiKey' }),
      makeBucket({ engineId: 'opencode' }),
      makeBucket({ vendorId: 'openai' }),
      makeBucket({ modelId: 'other-model' }),
      makeBucket({ origin: 'dispatch' })
    ])
    expect(getUsageBucketsSince(0)).toHaveLength(8)
  })

  it('getUsageBucketsSince returns rows oldest hour first', () => {
    upsertUsageBuckets([
      makeBucket({ hourUtc: Date.UTC(2026, 5, 20, 11) }),
      makeBucket({ hourUtc: Date.UTC(2026, 5, 20, 9) }),
      makeBucket({ hourUtc: Date.UTC(2026, 5, 20, 10) })
    ])
    expect(getUsageBucketsSince(0).map((r) => r.hourUtc)).toEqual([
      Date.UTC(2026, 5, 20, 9),
      Date.UTC(2026, 5, 20, 10),
      Date.UTC(2026, 5, 20, 11)
    ])
  })

  it('keeps the unknown-cost counts, so a sum can say what is missing from it', () => {
    upsertUsageBuckets([
      makeBucket({
        apiCostUsd: 0.5,
        billedCostUsd: 0,
        unbilledApiCostUsd: 0.4,
        unknownApiCostCount: 2,
        unknownBilledCostCount: 7,
        requestCount: 9
      })
    ])
    const row = getUsageBucketsSince(0)[0]
    expect(row.unknownApiCostCount).toBe(2)
    expect(row.unknownBilledCostCount).toBe(7)
    expect(row.unbilledApiCostUsd).toBeCloseTo(0.4)
    expect(row.requestCount).toBe(9)
  })

  it('deleteSeedUsageBuckets removes seeds at the given hours and never a rollup', () => {
    const seedHour = Date.UTC(2026, 5, 20, 12)
    upsertUsageBuckets([
      makeBucket({ hourUtc: seedHour, source: 'seed' }),
      // Same hour, a DIFFERENT model — a rollup bucket that happens to sit at
      // midday must survive.
      makeBucket({ hourUtc: seedHour, modelId: 'rolled-up', source: 'rollup' }),
      makeBucket({ hourUtc: Date.UTC(2026, 5, 21, 12), source: 'seed' })
    ])

    deleteSeedUsageBuckets([seedHour])

    const rows = getUsageBucketsSince(0)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.modelId)).toEqual(['rolled-up', 'claude-sonnet-4-6'])
  })

  it('a rev is never reissued after a delete empties the table', () => {
    const hour = Date.UTC(2026, 5, 20, 12)
    const first = upsertUsageBuckets([makeBucket({ hourUtc: hour, source: 'seed' })])
    deleteSeedUsageBuckets([hour])
    expect(getUsageBucketsSince(0)).toHaveLength(0)
    // The guard on the counter: a MAX(rev)+1 scheme would hand out `first`
    // again here, and a puller asking for everything after it would never see
    // these rows (ADR-072 §3).
    expect(upsertUsageBuckets([makeBucket()])).toBeGreaterThan(first)
  })

  it('an empty write is a no-op and issues no rev', () => {
    expect(upsertUsageBuckets([])).toBe(0)
    expect(() => deleteSeedUsageBuckets([])).not.toThrow()
    expect(getUsageBucketsSince(0)).toHaveLength(0)
  })
})
