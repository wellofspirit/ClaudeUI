/**
 * @vitest-environment node
 *
 * ADR-071 §3 — the API-key account key. The fixed vector below is the whole
 * point of this file: the digest is what every API-key row in the ledger (and
 * in ADR-072's hub) is filed under, so a refactor that changes the hash input,
 * the prefix or the truncation must fail here rather than silently splitting
 * one account into two.
 *
 * The keys here are invented strings, not credentials.
 */

import { describe, it, expect } from 'vitest'
import { apiKeyAccountKey } from '../account-key-hash'

const FAKE_KEY = 'sk-or-v1-test-key-0000a41f'

describe('apiKeyAccountKey', () => {
  it('matches the pinned vector for a known vendor and key', () => {
    expect(apiKeyAccountKey('openrouter', FAKE_KEY)).toEqual({
      accountKey: 'openrouter:key:f6b9eb5c99cab124',
      accountLabel: 'openrouter key …a41f'
    })
  })

  it('files the same key under two vendors as two accounts', () => {
    expect(apiKeyAccountKey('anthropic', FAKE_KEY).accountKey).toBe(
      'anthropic:key:0fe76705e6bdb7ce'
    )
  })

  it('is stable across calls', () => {
    expect(apiKeyAccountKey('openrouter', FAKE_KEY)).toEqual(
      apiKeyAccountKey('openrouter', FAKE_KEY)
    )
  })

  it('gives two different keys two different accounts', () => {
    expect(apiKeyAccountKey('openrouter', FAKE_KEY).accountKey).not.toBe(
      apiKeyAccountKey('openrouter', `${FAKE_KEY}x`).accountKey
    )
  })

  it('never returns the key itself — only a digest and the last four characters', () => {
    const { accountKey, accountLabel } = apiKeyAccountKey('openrouter', FAKE_KEY)
    expect(accountKey).not.toContain(FAKE_KEY)
    expect(accountLabel).not.toContain(FAKE_KEY)
    // The label's trailing fragment is four characters, no more.
    expect(accountLabel?.split('…')[1]).toHaveLength(4)
  })
})
