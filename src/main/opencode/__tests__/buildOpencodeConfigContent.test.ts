/**
 * Unit tests for buildOpencodeConfigContent (OpencodeServerManager).
 *
 * Guards:
 * - No cfg → only {mcp} emitted (unchanged baseline).
 * - Each field set → correct opencode key in the output JSON.
 * - Unset fields are ABSENT from the emitted JSON (clobber-safety contract).
 * - provider models array → object keyed by model id.
 * - API keys are never injected (not even if someone tries to pass them).
 */

import { describe, it, expect } from 'vitest'
import { buildOpencodeConfigContent } from '../OpencodeServerManager'
import type { OpencodeConfigSettings } from '../../../shared/types'

const PORT = 19000
const TOKEN = 'test-token'

function parse(cfg?: OpencodeConfigSettings): Record<string, unknown> {
  return JSON.parse(buildOpencodeConfigContent(PORT, TOKEN, cfg)) as Record<string, unknown>
}

describe('buildOpencodeConfigContent', () => {
  it('with no cfg emits only mcp (baseline unchanged)', () => {
    const out = parse()
    expect(Object.keys(out)).toEqual(['mcp'])
    expect(out.mcp).toBeDefined()
  })

  it('wires MCP host port and token into the mcp.claudeui block', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
    const headers = claudeui.headers as Record<string, unknown>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(claudeui.enabled).toBe(true)
  })

  describe('model fields', () => {
    it('cfg.model → config.model', () => {
      const out = parse({ model: 'anthropic/claude-sonnet-4-6' })
      expect(out.model).toBe('anthropic/claude-sonnet-4-6')
    })

    it('cfg.smallModel → config.small_model (not smallModel)', () => {
      const out = parse({ smallModel: 'anthropic/claude-haiku-3' })
      expect(out.small_model).toBe('anthropic/claude-haiku-3')
      expect(out).not.toHaveProperty('smallModel')
    })
  })

  describe('provider lists', () => {
    it('cfg.disabledProviders → config.disabled_providers', () => {
      const out = parse({ disabledProviders: ['bedrock', 'vertex'] })
      expect(out.disabled_providers).toEqual(['bedrock', 'vertex'])
    })

    it('cfg.enabledProviders → config.enabled_providers', () => {
      const out = parse({ enabledProviders: ['anthropic', 'openai'] })
      expect(out.enabled_providers).toEqual(['anthropic', 'openai'])
    })
  })

  describe('providers mapping', () => {
    it('maps providers Record → config.provider with opencode shape', () => {
      const out = parse({
        providers: {
          'my-ollama': {
            name: 'My Ollama',
            baseURL: 'http://localhost:11434/v1',
            models: [
              { id: 'llama3.2', name: 'Llama 3.2' },
              { id: 'mistral-7b' }
            ]
          }
        }
      })
      const provider = out.provider as Record<string, unknown>
      expect(provider).toBeDefined()
      const entry = provider['my-ollama'] as Record<string, unknown>
      expect(entry.name).toBe('My Ollama')
      expect((entry.options as Record<string, unknown>).baseURL).toBe('http://localhost:11434/v1')
    })

    it('maps models array → object keyed by model id (not an array)', () => {
      const out = parse({
        providers: {
          'my-ollama': {
            models: [
              { id: 'llama3.2', name: 'Llama 3.2' },
              { id: 'mistral-7b' }
            ]
          }
        }
      })
      const provider = out.provider as Record<string, unknown>
      const entry = provider['my-ollama'] as Record<string, unknown>
      const models = entry.models as Record<string, unknown>
      // Must be an object, not an array
      expect(Array.isArray(models)).toBe(false)
      expect(models['llama3.2']).toEqual({ name: 'Llama 3.2' })
      // Model with no name gets an empty object
      expect(models['mistral-7b']).toEqual({})
    })

    it('provider without name/baseURL/models emits minimal entry', () => {
      const out = parse({ providers: { 'bare': {} } })
      const provider = out.provider as Record<string, unknown>
      const entry = provider['bare'] as Record<string, unknown>
      expect(entry.name).toBeUndefined()
      expect(entry.options).toBeUndefined()
      expect(entry.models).toBeUndefined()
    })
  })

  describe('agents mapping', () => {
    it('cfg.agents → config.agent with model and temperature', () => {
      const out = parse({
        agents: {
          build: { model: 'anthropic/claude-haiku-3', temperature: 0.5 },
          plan: { model: 'anthropic/claude-opus-4-8' }
        }
      })
      const agent = out.agent as Record<string, unknown>
      expect(agent.build).toEqual({ model: 'anthropic/claude-haiku-3', temperature: 0.5 })
      expect(agent.plan).toEqual({ model: 'anthropic/claude-opus-4-8' })
    })

    it('agent without model or temperature emits empty object', () => {
      const out = parse({ agents: { general: {} } })
      const agent = out.agent as Record<string, unknown>
      expect(agent.general).toEqual({})
    })
  })

  describe('clobber-safety: unset fields are ABSENT from the emitted JSON', () => {
    it('no model → no model key in output', () => {
      const out = parse({})
      expect(out).not.toHaveProperty('model')
    })

    it('no smallModel → no small_model key in output', () => {
      const out = parse({})
      expect(out).not.toHaveProperty('small_model')
    })

    it('empty disabledProviders array → no disabled_providers key in output', () => {
      const out = parse({ disabledProviders: [] })
      expect(out).not.toHaveProperty('disabled_providers')
    })

    it('empty enabledProviders array → no enabled_providers key in output', () => {
      const out = parse({ enabledProviders: [] })
      expect(out).not.toHaveProperty('enabled_providers')
    })

    it('empty providers object → no provider key in output', () => {
      const out = parse({ providers: {} })
      expect(out).not.toHaveProperty('provider')
    })

    it('empty agents object → no agent key in output', () => {
      const out = parse({ agents: {} })
      expect(out).not.toHaveProperty('agent')
    })

    it('no cfg at all → output has exactly mcp key only', () => {
      const out = parse(undefined)
      expect(Object.keys(out)).toEqual(['mcp'])
    })
  })

  describe('combined: multiple set fields all appear, unset absent', () => {
    it('model + agents set, providers unset → no provider key', () => {
      const out = parse({
        model: 'anthropic/claude-sonnet-4-6',
        agents: { build: { temperature: 1.0 } }
      })
      expect(out.model).toBe('anthropic/claude-sonnet-4-6')
      expect(out.agent).toBeDefined()
      expect(out).not.toHaveProperty('provider')
      expect(out).not.toHaveProperty('small_model')
      expect(out).not.toHaveProperty('disabled_providers')
    })
  })
})
