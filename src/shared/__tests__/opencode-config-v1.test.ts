// @vitest-environment node
/**
 * The 1.x → 2.x config entry migration (ADR-097 S8): upstream's own
 * `ConfigMigrateV1` at v2.0.24, plus ClaudeUI's mapping of the capability keys
 * 2.x drops (`attachment`, `reasoning`).
 */
import { describe, expect, it } from 'vitest'
import {
  isLegacyAgentFrontmatter,
  migrateAgentV1,
  migrateModelV1,
  migrateProviderV1,
  modelSelectionV1,
  nativeProviderEntry,
  normalizeActionV1,
  permissionRulesV1,
  providerIsLegacyOnly,
  selectionToString,
  toolRulesV1
} from '../opencode-config-v1'

describe('model keys 2.x drops stay inert on a move (S8 review F4)', () => {
  it('attachment / reasoning / temperature are dropped, exactly as 2.x reads them', () => {
    expect(migrateModelV1({ attachment: false })).toEqual({})
    expect(migrateModelV1({ attachment: true, reasoning: false, temperature: true })).toEqual({})
  })

  it('modalities and tool_call map as upstream (defaults filled in)', () => {
    expect(
      migrateModelV1({ attachment: true, modalities: { input: ['text'] } }).capabilities
    ).toEqual({ tools: true, input: ['text'], output: ['text'] })
  })

  it('explicit variants map as upstream', () => {
    expect(migrateModelV1({ reasoning: false, variants: { high: { effort: 'h' } } })).toEqual({
      variants: [{ id: 'high', settings: { effort: 'h' } }]
    })
  })

  it('drops temperature/release_date/experimental; maps status, interleaved, provider.api', () => {
    expect(
      migrateModelV1({
        temperature: true,
        release_date: 'x',
        experimental: true,
        status: 'deprecated',
        interleaved: { field: 'reasoning_content' },
        provider: { npm: '@ai-sdk/anthropic', api: 'http://m/v1' },
        limit: { context: 10.7, output: 2 }
      })
    ).toEqual({
      compatibility: { reasoningField: 'reasoning_content' },
      package: 'aisdk:@ai-sdk/anthropic',
      settings: { baseURL: 'http://m/v1' },
      disabled: true,
      limit: { context: 10, output: 2 }
    })
  })
})

describe('migrateProviderV1', () => {
  it('splits options into settings/headers/body and api into settings.baseURL', () => {
    expect(
      migrateProviderV1('p', {
        api: 'http://api',
        npm: '@ai-sdk/openai',
        env: ['P_KEY'],
        id: 'dropped',
        options: { apiKey: 'k', headers: { a: '1', n: 2 }, body: { b: 1 } }
      })
    ).toEqual({
      env: ['P_KEY'],
      package: 'aisdk:@ai-sdk/openai',
      settings: { apiKey: 'k', baseURL: 'http://api' },
      headers: { a: '1' },
      body: { b: 1 }
    })
  })

  it('refuses the retired ids 2.x renames', () => {
    expect(() => migrateProviderV1('azure-cognitive-services', {})).toThrow(/retired/)
  })

  it('nativeProviderEntry prefers the 2.x entry, else migrates the 1.x one', () => {
    const config = {
      provider: { a: { name: 'A1' }, b: { name: 'B1' } },
      providers: { a: { name: 'A2' } }
    }
    expect(nativeProviderEntry(config, 'a')).toEqual({ name: 'A2' })
    expect(nativeProviderEntry(config, 'b')).toEqual({ name: 'B1' })
    expect(providerIsLegacyOnly(config, 'a')).toBe(false)
    expect(providerIsLegacyOnly(config, 'b')).toBe(true)
  })
})

describe('migrateAgentV1', () => {
  it('maps every 1.x agent field as upstream does', () => {
    expect(
      migrateAgentV1({
        model: 'anthropic/claude',
        variant: 'high',
        temperature: 0.3,
        top_p: 0.8,
        prompt: 'P',
        tools: { bash: false, write: true },
        permission: { bash: 'ask', webfetch: { 'https://x/*': 'deny' } },
        disable: true,
        maxSteps: 4,
        color: 'accent',
        options: { seed: 1 },
        extra: 'x'
      })
    ).toEqual({
      model: { providerID: 'anthropic', model: 'claude', variant: 'high' },
      request: { body: { seed: 1, extra: 'x', temperature: 0.3, top_p: 0.8 } },
      system: 'P',
      color: '#aaaaaa',
      steps: 4,
      disabled: true,
      // tools first, the explicit permission over it key-wise (bash keeps its slot)
      permissions: [
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'webfetch', resource: 'https://x/*', effect: 'deny' }
      ]
    })
  })

  it('a bare permission action applies to everything', () => {
    expect(migrateAgentV1({ permission: 'deny' }).permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' }
    ])
  })

  it('front matter with any non-2.x key is read by 2.x as 1.x', () => {
    expect(isLegacyAgentFrontmatter({ mode: 'all', permissions: [] })).toBe(false)
    expect(isLegacyAgentFrontmatter({ mode: 'all', variant: 'high' })).toBe(false)
    expect(isLegacyAgentFrontmatter({ mode: 'all', temperature: 0.2 })).toBe(true)
    expect(isLegacyAgentFrontmatter({ disable: true })).toBe(true)
  })
})

describe('small helpers', () => {
  it('normalizeActionV1 / rules', () => {
    expect(['bash', 'task', 'write', 'patch', 'read'].map(normalizeActionV1)).toEqual([
      'shell',
      'subagent',
      'edit',
      'edit',
      'read'
    ])
    expect(toolRulesV1({ bash: false, x: 'no' })).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' }
    ])
    expect(permissionRulesV1('ask')).toEqual([{ action: '*', resource: '*', effect: 'ask' }])
  })

  it('model selections', () => {
    expect(modelSelectionV1('a/b/c')).toEqual({ providerID: 'a', model: 'b/c' })
    expect(modelSelectionV1('nope')).toBeUndefined()
    expect(selectionToString({ providerID: 'a', model: 'b', variant: 'v' })).toBe('a/b#v')
    expect(selectionToString('a/b')).toBe('a/b')
  })
})
