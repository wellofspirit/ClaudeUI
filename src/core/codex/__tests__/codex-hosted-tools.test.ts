/**
 * @vitest-environment node
 *
 * Codex's `dispatch_agent` dynamic tool spec (ADR-033 slice H, S4): its
 * description comes from the shared builder and steers Codex to its own
 * `spawn_agent` first.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: vi.fn(() => ({})) }))

import { codexDynamicToolSpecs } from '../codex-hosted-tools'

describe('codexDynamicToolSpecs — dispatch_agent (S4)', () => {
  it('steers Codex to spawn_agent first, names claude, opencode and pi as targets, keeps the per-target hints', () => {
    const spec = codexDynamicToolSpecs(true).find((s) => s.name === 'dispatch_agent')!
    expect(spec.description).toContain(
      'Use this only when the user asks for a different engine or model vendor'
    )
    expect(spec.description).toContain('use your own spawn_agent tool instead')
    expect(spec.description).toContain(
      "claude (Anthropic's models), opencode (fronts non-Anthropic model vendors, e.g. GPT or Gemini models) or pi (an alternative coding-agent harness)"
    )
    expect(spec.description).toContain('For claude:')
    expect(spec.description).toContain('For opencode:')
    expect(spec.description).toContain('For pi:')
    expect(codexDynamicToolSpecs(false).some((s) => s.name === 'dispatch_agent')).toBe(false)
  })
})
