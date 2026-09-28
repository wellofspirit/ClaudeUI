/**
 * @vitest-environment node
 *
 * One judge call as a ledger row (`../judge-usage`, ADR-081 §5).
 *
 * The builder is asserted field for field, because every field is a rule: the
 * disjoint token split, the origin the dashboard marks, the charge flag the
 * cost rule branches on. The recorder path then runs against the real ledger,
 * where the two costs are resolved — a subscription judge bills nothing, an
 * OpenRouter one bills what OpenRouter reported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDb, countUsageEvents, getUsageEventsSince } from '../../services/db'
import { buildJudgeUsageEvent, recordJudgeUsage, type JudgeUsageInput } from '../judge-usage'
import type { JudgeUsageSample } from '../judge-http'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function sample(overrides: Partial<JudgeUsageSample> = {}): JudgeUsageSample {
  return {
    inputTokens: 1_000,
    cachedInputTokens: 400,
    outputTokens: 100,
    reasoningTokens: 30,
    costUsd: null,
    ...overrides
  }
}

/** A ChatGPT-subscription judge for an opencode session. */
function chatgptInput(overrides: Partial<JudgeUsageInput> = {}): JudgeUsageInput {
  return {
    engineId: 'opencode',
    vendorId: 'openai',
    modelId: 'gpt-5.4',
    sessionId: 'ses_judged',
    parentRoutingId: 'route-judged',
    accountId: 'vault-acct-1',
    accountKey: 'chatgpt:ws-1:user-1',
    accountLabel: 'ChatGPT Plus',
    billingType: 'subscription',
    ...overrides
  }
}

/** An OpenRouter API-key judge for a pi session. */
function openrouterInput(overrides: Partial<JudgeUsageInput> = {}): JudgeUsageInput {
  return {
    engineId: 'pi',
    vendorId: 'openrouter',
    modelId: 'z-ai/glm-4.6',
    sessionId: 'pi-ses-1',
    parentRoutingId: 'route-pi',
    accountId: null,
    accountKey: 'openrouter:key:0123456789abcdef',
    accountLabel: 'OpenRouter …cdef',
    billingType: 'apiKey',
    ...overrides
  }
}

describe('buildJudgeUsageEvent', () => {
  it('builds a judge row with the disjoint token split', () => {
    expect(buildJudgeUsageEvent(sample(), chatgptInput(), 'fixed-id')).toEqual({
      engineId: 'opencode',
      vendorId: 'openai',
      accountId: 'vault-acct-1',
      accountUuid: null,
      modelId: 'gpt-5.4',
      // The cached 400 come OUT of input and become the cache read; reasoning
      // is already inside output and is not added again.
      tokens: { input: 600, output: 100, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 400 },
      engineCostUsd: null,
      sessionId: 'ses_judged',
      messageId: 'judge:fixed-id',
      source: 'live',
      accountKey: 'chatgpt:ws-1:user-1',
      accountLabel: 'ChatGPT Plus',
      billingType: 'subscription',
      origin: 'judge',
      parentRoutingId: 'route-judged',
      engineCostIsEquivalent: false
    })
  })

  it("carries OpenRouter's reported cost as the engine figure, a charge", () => {
    const event = buildJudgeUsageEvent(sample({ costUsd: 0.0021 }), openrouterInput(), 'x')!
    expect(event.engineCostUsd).toBe(0.0021)
    expect(event.engineCostIsEquivalent).toBe(false)
    expect(event.billingType).toBe('apiKey')
    expect(event.accountId).toBeNull()
  })

  it('never writes a negative input when the cached count exceeds it', () => {
    const event = buildJudgeUsageEvent(
      sample({ inputTokens: 100, cachedInputTokens: 150 }),
      chatgptInput(),
      'x'
    )!
    expect(event.tokens.input).toBe(0)
    expect(event.tokens.cacheRead).toBe(150)
  })

  it('returns null for a sample that moved nothing', () => {
    const zero = sample({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: null
    })
    expect(buildJudgeUsageEvent(zero, chatgptInput())).toBeNull()
    expect(buildJudgeUsageEvent({ ...zero, costUsd: 0 }, chatgptInput())).toBeNull()
  })

  it('gives every call its own message id when none is passed', () => {
    const a = buildJudgeUsageEvent(sample(), chatgptInput())!
    const b = buildJudgeUsageEvent(sample(), chatgptInput())!
    expect(a.messageId).toMatch(/^judge:[0-9a-f-]{36}$/)
    expect(a.messageId).not.toBe(b.messageId)
  })
})

describe('recordJudgeUsage', () => {
  it('writes a subscription judge row that bills nothing and is worth its list price', () => {
    recordJudgeUsage(sample(), chatgptInput())

    const rows = getUsageEventsSince(0)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      origin: 'judge',
      engineId: 'opencode',
      sessionId: 'ses_judged',
      parentRoutingId: 'route-judged',
      accountKey: 'chatgpt:ws-1:user-1',
      billingType: 'subscription',
      inputTokens: 600,
      cacheReadTokens: 400,
      outputTokens: 100
    })
    expect(row.messageId.startsWith('judge:')).toBe(true)
    // gpt-5.4: 600 × $2.50 + 400 × $0.25 + 100 × $15.00, per MTok.
    expect(row.apiCostUsd).toBeCloseTo(0.0031, 10)
    expect(row.billedCostUsd).toBe(0)
  })

  it('writes an API-key judge row billed at the provider-reported cost', () => {
    recordJudgeUsage(sample({ costUsd: 0.0021 }), openrouterInput())

    const [row] = getUsageEventsSince(0)
    expect(row.origin).toBe('judge')
    expect(row.engineCostUsd).toBe(0.0021)
    expect(row.billedCostUsd).toBeCloseTo(0.0021, 10)
  })

  it('records nothing for an all-zero sample', () => {
    recordJudgeUsage(
      sample({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }),
      chatgptInput()
    )
    expect(countUsageEvents()).toBe(0)
  })

  it('never throws, whatever the sample does', () => {
    const hostile = sample()
    Object.defineProperty(hostile, 'inputTokens', {
      get() {
        throw new Error('boom')
      }
    })
    expect(() => recordJudgeUsage(hostile, chatgptInput())).not.toThrow()
    expect(countUsageEvents()).toBe(0)
  })
})
