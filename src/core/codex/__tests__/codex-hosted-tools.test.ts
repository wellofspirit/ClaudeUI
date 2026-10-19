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

import { CODEX_HOSTED_TOOL_NAMES, codexDynamicToolSpecs } from '../codex-hosted-tools'
import {
  DISPATCH_DESCRIPTION_PARAM,
  DISPATCH_NAME_PARAM
} from '../../../shared/dispatch-agent-description'
import {
  SESSION_TOOL_NAMES,
  sessionToolDescriptions
} from '../../../shared/session-tools-description'

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

describe('codexDynamicToolSpecs — dispatch_agent name and description', () => {
  it('takes them as optional strings, worded by the shared description module', () => {
    const spec = codexDynamicToolSpecs(true).find((s) => s.name === 'dispatch_agent')!
    const schema = (spec as unknown as { inputSchema: unknown }).inputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties.name).toEqual({ type: 'string', description: DISPATCH_NAME_PARAM })
    expect(schema.properties.description).toEqual({
      type: 'string',
      description: DISPATCH_DESCRIPTION_PARAM
    })
    expect(schema.required).toEqual(['engine', 'prompt'])
  })
})

describe('codexDynamicToolSpecs — the session tools (slice 2)', () => {
  const sessionSpecs = codexDynamicToolSpecs(true, true).filter((spec) =>
    (SESSION_TOOL_NAMES as readonly string[]).includes(spec.name)
  )

  it('adds the nine, after the others, only when asked', () => {
    expect(sessionSpecs.map((spec) => spec.name)).toEqual([...SESSION_TOOL_NAMES])
    expect(codexDynamicToolSpecs(true, true).map((spec) => spec.name)).toEqual([
      'render_mermaid',
      'create_mockup',
      'show_mockup',
      'dispatch_agent',
      ...SESSION_TOOL_NAMES
    ])
    for (const flags of [
      [true, false],
      [false, false]
    ] as const) {
      expect(
        codexDynamicToolSpecs(flags[0], flags[1]).some((spec) => spec.name.startsWith('session_'))
      ).toBe(false)
    }
    // The one-argument form every older caller uses is unchanged.
    expect(codexDynamicToolSpecs(false).map((spec) => spec.name)).toEqual([
      'render_mermaid',
      'create_mockup',
      'show_mockup'
    ])
  })

  it('are canonical tagged functions with the shared descriptions and closed schemas', () => {
    const descriptions = sessionToolDescriptions({})
    for (const spec of sessionSpecs) {
      expect(spec).toMatchObject({
        type: 'function',
        description: descriptions[spec.name as keyof typeof descriptions],
        inputSchema: { type: 'object', additionalProperties: false }
      })
    }
  })

  it('every name is on the hosted list (the security boundary) and valid for a dynamic tool', () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(CODEX_HOSTED_TOOL_NAMES.has(name)).toBe(true)
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(name.startsWith('mcp')).toBe(false)
    }
  })
})
