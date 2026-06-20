import { describe, it, expect } from 'vitest'
import {
  resolveCapabilities,
  resolveClaudeCapabilities,
  CLAUDE_ENGINE_CAPABILITIES,
  claudeModelCapabilities
} from '../../shared/model-capabilities'

describe('resolveCapabilities — Claude engine × thinking+effort model', () => {
  it('opus-4-8 has both reasoning axes', () => {
    const caps = resolveClaudeCapabilities('claude-opus-4-8')
    expect(caps.reasoning.thinking).toBeDefined()
    expect(caps.reasoning.thinking?.modes).toContain('adaptive')
    expect(caps.reasoning.effort).toBeDefined()
    expect(caps.reasoning.effort?.levels.length).toBeGreaterThan(0)
  })

  it('all engine gates true for Claude', () => {
    const caps = resolveClaudeCapabilities('claude-opus-4-8')
    expect(caps.voice).toBe(true)
    expect(caps.hostedMcp).toBe(true)
    expect(caps.backgroundTasks).toBe(true)
    expect(caps.subagents).toBe(true)
    expect(caps.plan).toBe(true)
    expect(caps.fork).toBe(true)
    expect(caps.forkFromMessage).toBe(true)
    expect(caps.steer).toBe(true)
    expect(caps.queue).toBe(true)
    expect(caps.slashCommands).toBe(true)
    expect(caps.skills).toBe(true)
    expect(caps.sideQuestion).toBe(true)
    expect(caps.interactiveApprovals).toBe(true)
  })

  it('canUseMcp / canUseSubagents / isAgentCapable all true for Claude', () => {
    const caps = resolveClaudeCapabilities('claude-opus-4-8')
    expect(caps.canUseMcp).toBe(true)
    expect(caps.canUseSubagents).toBe(true)
    expect(caps.isAgentCapable).toBe(true)
  })

  it('degraded path: no-toolCalling model → canUseMcp/isAgentCapable false', () => {
    const noToolModel = {
      reasoning: {},
      vision: true,
      toolCalling: false,
      contextWindow: 200000,
      maxOutput: 4096,
      promptCaching: false
    }
    const caps = resolveCapabilities(CLAUDE_ENGINE_CAPABILITIES, noToolModel)
    expect(caps.canUseMcp).toBe(false)
    expect(caps.canUseSubagents).toBe(false)
    expect(caps.isAgentCapable).toBe(false)
    // Engine gates still true
    expect(caps.voice).toBe(true)
    expect(caps.hostedMcp).toBe(true)
  })

  it('sonnet-4-6 has both reasoning axes', () => {
    const caps = resolveClaudeCapabilities('claude-sonnet-4-6')
    expect(caps.reasoning.thinking).toBeDefined()
    expect(caps.reasoning.effort).toBeDefined()
  })

  it('haiku has no reasoning axes (neither thinking nor effort)', () => {
    const model: import('../../shared/model-capabilities').ModelCapabilityInput = {
      value: 'haiku',
      supportsAdaptiveThinking: false,
      supportsEffort: false
    }
    const modelCaps = claudeModelCapabilities(model)
    expect(modelCaps.reasoning.thinking).toBeUndefined()
    expect(modelCaps.reasoning.effort).toBeUndefined()
  })
})
