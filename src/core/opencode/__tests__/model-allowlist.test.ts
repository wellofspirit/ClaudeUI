/**
 * @vitest-environment node
 *
 * `loadOpencodeModelAllowlist` validates the persisted allowlist's shape once
 * (ADR-111): the consumers (picker, shim, server config, the plugin's options)
 * trust what it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { loadEngineConfig } = vi.hoisted(() => ({ loadEngineConfig: vi.fn() }))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig }))

import { loadOpencodeModelAllowlist, opencodeModelAllowed } from '../model-allowlist'
import { logger } from '../../services/logger'

const withAllowlist = (modelAllowlist: unknown): void => {
  loadEngineConfig.mockReturnValue({ opencodeConfig: { modelAllowlist } })
}

describe('loadOpencodeModelAllowlist', () => {
  beforeEach(() => {
    loadEngineConfig.mockReset()
    vi.restoreAllMocks()
  })

  it('keeps providers whose value is an array of strings (an empty list stays: it restricts to none)', () => {
    withAllowlist({ openai: ['gpt-a', 'gpt-b'], anthropic: [] })
    expect(loadOpencodeModelAllowlist()).toEqual({ openai: ['gpt-a', 'gpt-b'], anthropic: [] })
  })

  it('fails closed on a malformed provider value: a string is one id, an array keeps its strings, anything else allows none', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    withAllowlist({
      openai: ['gpt-a'],
      stringy: 'gpt-a',
      numbery: 7,
      mixed: ['gpt-a', 3],
      nully: null
    })
    const list = loadOpencodeModelAllowlist()
    expect(list).toEqual({
      openai: ['gpt-a'],
      stringy: ['gpt-a'],
      numbery: [],
      mixed: ['gpt-a'],
      nully: []
    })
    expect(warn).toHaveBeenCalledTimes(4)
    // Still restricted: never a substring match, never unrestricted.
    expect(opencodeModelAllowed(list, 'stringy/gpt')).toBe(false)
    expect(opencodeModelAllowed(list, 'stringy/gpt-a')).toBe(true)
    expect(opencodeModelAllowed(list, 'numbery/anything')).toBe(false)
  })

  it('returns {} for a missing, non-object or array allowlist and when the read throws', () => {
    for (const bad of [undefined, null, 'openai', 5, ['gpt-a']]) {
      withAllowlist(bad)
      expect(loadOpencodeModelAllowlist()).toEqual({})
    }
    loadEngineConfig.mockImplementation(() => {
      throw new Error('unreadable')
    })
    expect(loadOpencodeModelAllowlist()).toEqual({})
  })
})
