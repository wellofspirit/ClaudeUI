/**
 * @vitest-environment node
 *
 * Tests for the usage-recorder (Phase 7 Pass 1).
 *
 * recordUsageEvent is engine-agnostic: it takes a UsageTurnEvent and writes one
 * usage_event row. opencode calls it live (per assistant message at session.idle);
 * Claude does NOT call it live (the Pass-2 reconciler feeds Claude rows via
 * insertUsageEvents from the JSONL parse). These tests exercise the recorder API
 * directly with both engine-shaped payloads.
 *
 * Verifies:
 *   - recordUsageEvent builds a correct DB row for an anthropic-shaped event
 *   - recordUsageEvent builds a correct DB row for an opencode turn (the live caller)
 *   - dedup: second call with same message_id is silently dropped
 *   - DB errors are swallowed (never throw from the recorder)
 *   - equiv_cost_usd is computed via the pricing table (null for unpriced)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDb, getUsageEventByMessageId } from '../db'
import { recordUsageEvent } from '../usage-recorder'
import type { UsageTurnEvent } from '../usage-recorder'

beforeEach(() => closeDb())
afterEach(() => closeDb())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An anthropic-vendored event. Note: in Pass 1 Claude rows actually arrive via
 *  the Pass-2 reconciler (source 'backfill'); this exercises the recorder API
 *  with an anthropic-shaped payload and anthropic pricing. */
function anthropicEvent(overrides: Partial<UsageTurnEvent> = {}): UsageTurnEvent {
  return {
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: 'acc_default',
    accountUuid: 'uuid_abc123',
    modelId: 'claude-sonnet-4-6',
    tokens: {
      input: 1000,
      output: 500,
      cacheWrite: 100,
      cacheWrite1h: 0,
      cacheRead: 50
    },
    engineCostUsd: 0.00975,
    sessionId: 'ses_test',
    messageId: 'msg_claude_1',
    source: 'backfill',
    ...overrides
  }
}

function opencodeTurn(overrides: Partial<UsageTurnEvent> = {}): UsageTurnEvent {
  return {
    engineId: 'opencode',
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-4o',
    tokens: {
      input: 2000,
      output: 800,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0
    },
    engineCostUsd: 0.013,
    sessionId: 'ses_oc',
    messageId: 'msg_oc_1',
    source: 'live',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// anthropic-shaped event recording (recorder API — fed by the Pass-2 reconciler
// for Claude; this validates the row build + anthropic pricing)
// ---------------------------------------------------------------------------

describe('recordUsageEvent — anthropic-shaped event', () => {
  it('writes a DB row with correct engine/vendor/model fields', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_a' }))
    const row = getUsageEventByMessageId('msg_cl_a')
    expect(row).toBeDefined()
    expect(row!.engineId).toBe('claude')
    expect(row!.vendorId).toBe('anthropic')
    expect(row!.modelId).toBe('claude-sonnet-4-6')
  })

  it('writes correct token counts', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_b' }))
    const row = getUsageEventByMessageId('msg_cl_b')
    expect(row!.inputTokens).toBe(1000)
    expect(row!.outputTokens).toBe(500)
    expect(row!.cacheWriteTokens).toBe(100)
    expect(row!.cacheWrite1hTokens).toBe(0)
    expect(row!.cacheReadTokens).toBe(50)
  })

  it('computes equiv_cost_usd via the pricing table for a priced model', () => {
    // claude-sonnet-4-6: input=$3, output=$15, cacheWrite=$3.75, cacheRead=$0.3 per MTok
    // 1000 input + 500 output + 100 cacheWrite (5m) + 50 cacheRead
    // = (1000/1M)*3 + (500/1M)*15 + (100/1M)*3.75 + (50/1M)*0.3
    // = 0.003 + 0.0075 + 0.000375 + 0.000015 = 0.01089
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_equiv' }))
    const row = getUsageEventByMessageId('msg_cl_equiv')
    expect(row!.equivCostUsd).not.toBeNull()
    expect(row!.equivCostUsd!).toBeCloseTo(0.01089)
  })

  it('stores engine_cost_usd as-is from the event', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_eng', engineCostUsd: 0.0123 }))
    const row = getUsageEventByMessageId('msg_cl_eng')
    expect(row!.engineCostUsd).toBeCloseTo(0.0123)
  })

  it('stores accountId, accountUuid, sessionId', () => {
    recordUsageEvent(anthropicEvent({
      messageId: 'msg_cl_ids',
      accountId: 'my_account',
      accountUuid: 'my-uuid',
      sessionId: 'my-session'
    }))
    const row = getUsageEventByMessageId('msg_cl_ids')
    expect(row!.accountId).toBe('my_account')
    expect(row!.accountUuid).toBe('my-uuid')
    expect(row!.sessionId).toBe('my-session')
  })

  it('stores the source field verbatim (live or backfill)', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_src_live', source: 'live' }))
    expect(getUsageEventByMessageId('msg_cl_src_live')!.source).toBe('live')
    recordUsageEvent(anthropicEvent({ messageId: 'msg_cl_src_bf', source: 'backfill' }))
    expect(getUsageEventByMessageId('msg_cl_src_bf')!.source).toBe('backfill')
  })
})

// ---------------------------------------------------------------------------
// opencode turn recording
// ---------------------------------------------------------------------------

describe('recordUsageEvent — opencode turn', () => {
  it('writes a DB row with opencode engine/openai vendor', () => {
    recordUsageEvent(opencodeTurn({ messageId: 'msg_oc_a' }))
    const row = getUsageEventByMessageId('msg_oc_a')
    expect(row!.engineId).toBe('opencode')
    expect(row!.vendorId).toBe('openai')
    expect(row!.modelId).toBe('gpt-4o')
  })

  it('computes equiv_cost_usd for a priced openai model', () => {
    // gpt-4o: input=$2.5/MTok, output=$10/MTok
    // 2000 input + 800 output = (2000/1M)*2.5 + (800/1M)*10 = 0.005 + 0.008 = 0.013
    recordUsageEvent(opencodeTurn({ messageId: 'msg_oc_equiv' }))
    const row = getUsageEventByMessageId('msg_oc_equiv')
    expect(row!.equivCostUsd).not.toBeNull()
    expect(row!.equivCostUsd!).toBeCloseTo(0.013)
  })

  it('equiv_cost_usd is null for an unpriced opencode model', () => {
    recordUsageEvent(opencodeTurn({
      messageId: 'msg_oc_free',
      vendorId: 'opencode',
      modelId: 'mimo-v2.5-free'
    }))
    const row = getUsageEventByMessageId('msg_oc_free')
    expect(row!.equivCostUsd).toBeNull()
  })

  it('stores engine_cost_usd from opencode info.cost', () => {
    recordUsageEvent(opencodeTurn({ messageId: 'msg_oc_cost', engineCostUsd: 0.0456 }))
    expect(getUsageEventByMessageId('msg_oc_cost')!.engineCostUsd).toBeCloseTo(0.0456)
  })

  it('stores null accountId and null accountUuid (opencode has no OAuth UUID)', () => {
    recordUsageEvent(opencodeTurn({ messageId: 'msg_oc_nullids' }))
    const row = getUsageEventByMessageId('msg_oc_nullids')
    expect(row!.accountId).toBeNull()
    expect(row!.accountUuid).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dedup — same message_id from both engines / reconciler / live
// ---------------------------------------------------------------------------

describe('recordUsageEvent — message_id dedup', () => {
  it('second call with the same message_id is silently dropped (first wins)', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_dedup_x' }))
    recordUsageEvent(anthropicEvent({
      messageId: 'msg_dedup_x',
      tokens: { input: 999, output: 999, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    }))
    const row = getUsageEventByMessageId('msg_dedup_x')
    // First insert's token counts should be preserved
    expect(row!.inputTokens).toBe(1000)
  })

  it('backfill source after live source: live is preserved', () => {
    recordUsageEvent(anthropicEvent({ messageId: 'msg_live_first', source: 'live' }))
    recordUsageEvent(anthropicEvent({ messageId: 'msg_live_first', source: 'backfill' }))
    expect(getUsageEventByMessageId('msg_live_first')!.source).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// Error swallowing — never throws
// ---------------------------------------------------------------------------

describe('recordUsageEvent — errors swallowed', () => {
  it('does not throw even when called with an empty message_id (degenerate)', () => {
    // An empty string message_id would fail the NOT NULL constraint. The recorder
    // should catch the error and not re-throw.
    expect(() =>
      recordUsageEvent(anthropicEvent({ messageId: '' }))
    ).not.toThrow()
  })

  it('does not throw on repeated identical inserts', () => {
    const t = anthropicEvent({ messageId: 'msg_no_throw' })
    expect(() => {
      recordUsageEvent(t)
      recordUsageEvent(t)
      recordUsageEvent(t)
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Cache-split billing via the recorder
// ---------------------------------------------------------------------------

describe('recordUsageEvent — cache-split billing passthrough', () => {
  it('cacheWrite1h reduces 5m portion and increases 1h portion in equiv_cost', () => {
    // 1000 total cache writes, 400k at 1h rate, 600k at 5m rate
    // sonnet: 5m=$3.75/MTok, 1h=$6/MTok
    recordUsageEvent(anthropicEvent({
      messageId: 'msg_cache_split',
      tokens: {
        input: 0,
        output: 0,
        cacheWrite: 1000,
        cacheWrite1h: 400,
        cacheRead: 0
      }
    }))
    const row = getUsageEventByMessageId('msg_cache_split')
    // 600 at 3.75/MTok + 400 at 6/MTok (per million)
    const expected = (600 / 1_000_000) * 3.75 + (400 / 1_000_000) * 6.0
    expect(row!.equivCostUsd).toBeCloseTo(expected)
    expect(row!.cacheWriteTokens).toBe(1000)
    expect(row!.cacheWrite1hTokens).toBe(400)
  })
})
