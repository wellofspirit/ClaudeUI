/**
 * @vitest-environment node
 *
 * Per-account usage provider (foundation §7, Phase 7 Pass 2) — the window+
 * projection gate. Windows are subscription-gated AND require a provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetLastUsage } = vi.hoisted(() => ({ mockGetLastUsage: vi.fn() }))

vi.mock('../usage-fetcher', () => ({
  usageFetcher: { getLastUsage: mockGetLastUsage }
}))

import { resolveUsageProvider } from '../usage-provider'

beforeEach(() => mockGetLastUsage.mockReset())

describe('resolveUsageProvider — per-billingType gate', () => {
  it('returns a provider for Claude/anthropic + subscription', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'subscription')).not.toBeNull()
  })

  it('returns null for apiKey (real-spend, no window)', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'apiKey')).toBeNull()
  })

  it('returns null for free (tokens-only, no window)', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'free')).toBeNull()
  })

  it('returns null for unknown billing', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'unknown')).toBeNull()
  })

  it('returns null for opencode even when subscription (no usage API yet)', () => {
    expect(resolveUsageProvider('opencode', 'openai', 'subscription')).toBeNull()
  })
})

describe('claudeUsageProvider.getWindow', () => {
  it('yields the 5h window from usageFetcher when available', () => {
    mockGetLastUsage.mockReturnValue({
      error: null,
      fiveHour: { usedPercent: 42.5, resetsAt: '2026-06-22T15:00:00.000Z' }
    })
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    const window = provider.getWindow()
    expect(window).toEqual({ usedPercent: 42.5, resetsAt: '2026-06-22T15:00:00.000Z' })
  })

  it('returns null when usageFetcher has an error', () => {
    mockGetLastUsage.mockReturnValue({ error: 'no creds', fiveHour: { usedPercent: 0, resetsAt: null } })
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toBeNull()
  })

  it('returns null when usageFetcher has no data', () => {
    mockGetLastUsage.mockReturnValue(null)
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toBeNull()
  })
})
