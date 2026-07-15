/**
 * @vitest-environment node
 *
 * Unit tests for describeDispatchModels (ADR-033 follow-up) — the resolution
 * order (allowlist > cached-known models > generic hint) plus the default-
 * model clause and the 15-id cap on the cached-list branch.
 */
import { describe, it, expect } from 'vitest'
import { describeDispatchModels } from '../dispatch-model-hint'

describe('describeDispatchModels', () => {
  it('allowlist set: lists verbatim ids, uncapped, with no default clause when unset', () => {
    const hint = describeDispatchModels({
      targetEngine: 'opencode',
      allowedModels: ['openai/gpt-5', 'anthropic/claude-x']
    })
    expect(hint.long).toContain('Allowed models: openai/gpt-5, anthropic/claude-x.')
    expect(hint.long).toContain('No default is configured — pass model explicitly.')
    expect(hint.short).toContain('openai/gpt-5')
    expect(hint.short).toContain('anthropic/claude-x')
  })

  it('allowlist set: appends the default clause when defaultModel is configured', () => {
    const hint = describeDispatchModels({
      targetEngine: 'opencode',
      allowedModels: ['openai/gpt-5'],
      defaultModel: 'openai/gpt-5'
    })
    expect(hint.long).toContain('Default: openai/gpt-5.')
    expect(hint.short).toContain('Default: openai/gpt-5.')
  })

  it('allowlist is NOT capped even beyond 15 entries (verbatim, user-authored)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `provider/model-${i}`)
    const hint = describeDispatchModels({ targetEngine: 'opencode', allowedModels: many })
    for (const id of many) expect(hint.long).toContain(id)
    expect(hint.long).not.toContain('more)')
  })

  it('no allowlist, cached models available: lists known ids and caps at 15 with a (+N more) suffix', () => {
    const known = Array.from({ length: 18 }, (_, i) => `opencode/model-${i}`)
    const hint = describeDispatchModels({
      targetEngine: 'opencode',
      knownModelIds: known,
      defaultModel: 'opencode/model-0'
    })
    expect(hint.long).toContain('Available models include:')
    for (let i = 0; i < 15; i++) expect(hint.long).toContain(`opencode/model-${i}`)
    expect(hint.long).toContain('(+3 more)')
    expect(hint.long).not.toContain('model-15')
    expect(hint.long).toContain('Default: opencode/model-0.')
    expect(hint.short).toContain('(+3 more)')
  })

  it('no allowlist, cached list under the cap: no truncation suffix', () => {
    const known = ['opencode/a', 'opencode/b', 'opencode/c']
    const hint = describeDispatchModels({ targetEngine: 'opencode', knownModelIds: known })
    expect(hint.long).toContain('opencode/a, opencode/b, opencode/c')
    expect(hint.long).not.toContain('more)')
  })

  it('nothing known: falls back to the opencode "providerID/modelID" format hint', () => {
    const hint = describeDispatchModels({ targetEngine: 'opencode' })
    expect(hint.long).toContain('providerID/modelID')
    expect(hint.long).toContain('No default is configured — pass model explicitly.')
  })

  it('nothing known: falls back to the Claude-alias hint for targetEngine "claude"', () => {
    const hint = describeDispatchModels({ targetEngine: 'claude' })
    expect(hint.long).toContain('Claude model alias')
    expect(hint.long).toContain('sonnet')
  })

  it('empty allowedModels array is treated as "not configured" (falls through)', () => {
    const hint = describeDispatchModels({ targetEngine: 'claude', allowedModels: [] })
    expect(hint.long).not.toContain('Allowed models')
    expect(hint.long).toContain('Claude model alias')
  })

  it('empty knownModelIds array is treated as "not cached" (falls through to generic hint)', () => {
    const hint = describeDispatchModels({ targetEngine: 'opencode', knownModelIds: [] })
    expect(hint.long).not.toContain('Available models include')
    expect(hint.long).toContain('providerID/modelID')
  })
})
