/**
 * @vitest-environment node
 *
 * The batched key reader (S7 review M3d): an ADR-074 §6 pass over many
 * vendors reads opencode 2.x's credential list ONCE (one server), and a
 * credential ClaudeUI changes drops the memo. Fake keys only.
 */
import { describe, expect, it, vi } from 'vitest'
import { KEY_PASS_TTL_MS, batchedApiKeyReader } from '../native-api-keys'

describe('batchedApiKeyReader', () => {
  it('answers a whole pass from one read, re-reads after the TTL or an invalidation', async () => {
    let now = 0
    const readAll = vi.fn(
      async () =>
        new Map([
          ['openrouter', 'sk-or-fake'],
          ['groq', 'gsk-fake']
        ])
    )
    const reader = batchedApiKeyReader(readAll, () => now)
    expect(await reader.listApiKeyVendorIds()).toEqual(['openrouter', 'groq'])
    expect(await reader.readApiKey('openrouter')).toBe('sk-or-fake')
    expect(await reader.readApiKey('groq')).toBe('gsk-fake')
    expect(await reader.readApiKey('anthropic')).toBeNull()
    expect(readAll).toHaveBeenCalledTimes(1)
    reader.invalidate()
    await reader.readApiKey('groq')
    expect(readAll).toHaveBeenCalledTimes(2)
    now += KEY_PASS_TTL_MS + 1
    await reader.readApiKey('groq')
    expect(readAll).toHaveBeenCalledTimes(3)
  })

  it('a failed read answers nothing (never throws into the pass)', async () => {
    const reader = batchedApiKeyReader(async () => {
      throw new Error('no server')
    })
    expect(await reader.listApiKeyVendorIds()).toEqual([])
    expect(await reader.readApiKey('openrouter')).toBeNull()
  })
})
