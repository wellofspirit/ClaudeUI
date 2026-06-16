/**
 * Unit tests for CodexSession pure helpers.
 *
 * Only exercises the exported pure functions (no process spawn, no real
 * binary). `electron` is mocked so importing CodexSession (which transitively
 * imports ./locate → electron's `app`) resolves under the unit project.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

import { normalizeCodexModel } from '../CodexSession'

describe('normalizeCodexModel', () => {
  it("omits ClaudeUI's 'default' alias (Codex 400s on model:'default')", () => {
    expect(normalizeCodexModel('default')).toBeUndefined()
  })

  it('omits undefined', () => {
    expect(normalizeCodexModel(undefined)).toBeUndefined()
  })

  it('omits empty string', () => {
    expect(normalizeCodexModel('')).toBeUndefined()
  })

  it('passes through a real Codex model slug', () => {
    expect(normalizeCodexModel('gpt-5.1-codex')).toBe('gpt-5.1-codex')
  })

  it('passes through other real slugs unchanged', () => {
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.5')
    expect(normalizeCodexModel('gpt-5.4-mini')).toBe('gpt-5.4-mini')
  })
})
