import { describe, expect, it } from 'vitest'
import {
  formatPiModelList,
  PI_MODEL_LIST_CAP,
  resolvePiAgentModel,
  type PiAgentModelEntry
} from '../pi-agent-model'

const m = (
  provider: string,
  id: string,
  over: Partial<PiAgentModelEntry> = {}
): PiAgentModelEntry => ({
  provider,
  id,
  name: id,
  contextWindow: 200_000,
  reasoning: false,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  ...over
})

const CATALOG: PiAgentModelEntry[] = [
  m('anthropic', 'claude-opus-4-5-20251101'),
  m('anthropic', 'claude-opus-4-1'),
  m('anthropic', 'claude-sonnet-4-5'),
  m('anthropic', 'claude-3-5-haiku-20241022'),
  m('openrouter', 'anthropic/claude-sonnet-4.5'),
  m('openrouter', 'anthropic/claude-opus-5-5'),
  m('openrouter', 'deepseek/deepseek-v4-flash'),
  m('openai-codex', 'gpt-5.6-luna'),
  m('openai', 'gpt-5.6-luna'),
  m('openai', 'o3')
]

const ok = (value: string) => ({ ok: true, value })
const resolve = (requested: string, parent = 'openai-codex/gpt-5.6-luna', cat = CATALOG) =>
  resolvePiAgentModel(requested, cat, parent)

describe('resolvePiAgentModel (S3)', () => {
  it('1. an empty catalog cannot validate: the request passes through unchanged', () => {
    expect(resolvePiAgentModel('whatever/x', [], 'p/q')).toEqual(ok('whatever/x'))
    expect(resolvePiAgentModel('opus', [], 'p/q')).toEqual(ok('opus'))
  })

  it('2. an exact provider/id value, then a case-insensitive one', () => {
    expect(resolve('openai/o3')).toEqual(ok('openai/o3'))
    expect(resolve('OpenAI/O3')).toEqual(ok('openai/o3'))
    // The id may itself contain "/".
    expect(resolve('openrouter/deepseek/deepseek-v4-flash')).toEqual(
      ok('openrouter/deepseek/deepseek-v4-flash')
    )
  })

  it('3. a bare id: one match wins (also an id that contains "/")', () => {
    expect(resolve('o3')).toEqual(ok('openai/o3'))
    expect(resolve('O3')).toEqual(ok('openai/o3'))
    expect(resolve('deepseek/deepseek-v4-flash')).toEqual(
      ok('openrouter/deepseek/deepseek-v4-flash')
    )
  })

  it("3. a bare id on several providers prefers the parent's provider, else errors listing the candidates", () => {
    expect(resolve('gpt-5.6-luna', 'openai/o3')).toEqual(ok('openai/gpt-5.6-luna'))
    expect(resolve('gpt-5.6-luna', 'openai-codex/x')).toEqual(ok('openai-codex/gpt-5.6-luna'))
    const r = resolve('gpt-5.6-luna', 'anthropic/claude-sonnet-4-5')
    expect(r).toEqual({
      ok: false,
      error:
        'Model "gpt-5.6-luna" is ambiguous: it matches openai-codex/gpt-5.6-luna, ' +
        'openai/gpt-5.6-luna. Use the provider/id form.'
    })
  })

  it('3. an ambiguity error lists at most 10 candidates and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => m(`p${String(i).padStart(2, '0')}`, 'same'))
    const r = resolvePiAgentModel('same', many, 'none/x')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.match(/p\d\d\/same/g)).toHaveLength(10)
    expect(r.error).toContain('and 3 more')
  })

  it('4. an alias picks the highest version; a dated id loses to the newer undated one', () => {
    // anthropic provider only (the parent's): opus-4-5-20251101 (4,5) beats opus-4-1 (4,1).
    expect(resolve('opus', 'anthropic/claude-sonnet-4-5')).toEqual(
      ok('anthropic/claude-opus-4-5-20251101')
    )
    // Without the parent's provider, across providers: openrouter's opus-5-5 is newest overall.
    expect(resolve('opus', 'openai/o3')).toEqual(ok('openrouter/anthropic/claude-opus-5-5'))
  })

  it("4. an alias prefers the parent's provider before the version", () => {
    // openrouter's sonnet-4.5 (4,5) ties anthropic's sonnet-4-5 (4,5): the parent's provider decides.
    expect(resolve('sonnet', 'openrouter/x')).toEqual(ok('openrouter/anthropic/claude-sonnet-4.5'))
    expect(resolve('sonnet', 'anthropic/x')).toEqual(ok('anthropic/claude-sonnet-4-5'))
    // The parent has none → falls back to every provider.
    expect(resolve('haiku', 'openai/o3')).toEqual(ok('anthropic/claude-3-5-haiku-20241022'))
  })

  it('4. the old claude-3-5-haiku form matches; the alias is case-insensitive and whole-input only', () => {
    expect(resolve('HAIKU')).toEqual(ok('anthropic/claude-3-5-haiku-20241022'))
    // "opus-ish" is not the alias: unknown.
    expect(resolve('opus-ish').ok).toBe(false)
  })

  it('4. version tie → the undated, then the shortest id, then the later date', () => {
    const cat = [
      m('anthropic', 'claude-opus-4-5-20251101'),
      m('anthropic', 'claude-opus-4-5'),
      m('anthropic', 'claude-opus-4-5-latest')
    ]
    expect(resolve('opus', 'anthropic/x', cat)).toEqual(ok('anthropic/claude-opus-4-5'))
    expect(
      resolve('opus', 'anthropic/x', [
        m('anthropic', 'claude-opus-4-5-20251101'),
        m('anthropic', 'claude-opus-4-5-20250101')
      ])
    ).toEqual(ok('anthropic/claude-opus-4-5-20251101'))
  })

  it('4. a variant suffix (-1m, -v2, :thinking) is not a version: the plain model wins, and a genuinely newer version still beats a variant', () => {
    const pick = (ids: string[], alias = 'sonnet') =>
      [ids, [...ids].reverse()].map((order) =>
        resolve(
          alias,
          'anthropic/x',
          order.map((id) => m('anthropic', id))
        )
      )
    // Either input order gives the same answer.
    for (const r of pick(['claude-sonnet-4-5-1m', 'claude-sonnet-4-5'])) {
      expect(r).toEqual(ok('anthropic/claude-sonnet-4-5'))
    }
    for (const r of pick(['claude-sonnet-4-5-v2', 'claude-sonnet-4-5'])) {
      expect(r).toEqual(ok('anthropic/claude-sonnet-4-5'))
    }
    for (const r of pick(['claude-sonnet-4-5-1m', 'claude-sonnet-4-6'])) {
      expect(r).toEqual(ok('anthropic/claude-sonnet-4-6'))
    }
    // openrouter style: "thinking" is not numeric either, so the shorter id wins.
    for (const r of pick(['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5:thinking'])) {
      expect(r).toEqual(ok('anthropic/anthropic/claude-sonnet-4.5'))
    }
    // A dated variant of the same version still loses to the undated plain id.
    for (const r of pick(['claude-sonnet-4-5-20250929-1m', 'claude-sonnet-4-5'])) {
      expect(r).toEqual(ok('anthropic/claude-sonnet-4-5'))
    }
  })

  it('4. an alias with no matching model is an error pointing at list_models', () => {
    expect(resolve('fable')).toEqual({
      ok: false,
      error:
        'No model matches the alias "fable". Call list_models to see the models available to agents.'
    })
  })

  it('5. anything else is unknown, never substituted', () => {
    expect(resolve('gpt-9')).toEqual({
      ok: false,
      error: 'Unknown model "gpt-9". Call list_models to see the models available to agents.'
    })
    expect(resolve('anthropic/nope').ok).toBe(false)
  })
})

describe('formatPiModelList (S3)', () => {
  const sample: PiAgentModelEntry[] = [
    m('openai', 'o3', {
      name: 'o3',
      contextWindow: 200_000,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }
    }),
    m('anthropic', 'claude-sonnet-4-5', {
      name: 'Claude Sonnet 4.5',
      contextWindow: 1_000_000,
      input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
    }),
    m('anthropic', 'claude-3-5-haiku', {
      name: 'Claude Haiku 3.5',
      contextWindow: 200_000,
      cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 }
    }),
    m('local', 'llama-3', {
      name: 'Llama 3',
      contextWindow: 8_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
  ]

  it('first line names the session model; then one line per model sorted by provider then id', () => {
    expect(formatPiModelList({ catalog: sample, currentModel: 'openai/o3' })).toBe(
      [
        'Current session model: openai/o3',
        'anthropic/claude-3-5-haiku — Claude Haiku 3.5 · 200k ctx · $0.8/$4 per M tokens',
        'anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 · 1000k ctx · $3/$15 per M tokens · vision',
        'local/llama-3 — Llama 3 · 8k ctx',
        'openai/o3 — o3 · 200k ctx · $2/$8 per M tokens · reasoning · vision'
      ].join('\n')
    )
  })

  it('query is a case-insensitive substring over value and display name', () => {
    const out = formatPiModelList({ catalog: sample, query: 'HAIKU', currentModel: 'p/x' })
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('anthropic/claude-3-5-haiku')
    // The display name matches too.
    expect(formatPiModelList({ catalog: sample, query: 'llama 3', currentModel: 'p/x' })).toContain(
      'local/llama-3'
    )
    expect(
      formatPiModelList({ catalog: sample, query: 'anthropic/', currentModel: 'p/x' }).split('\n')
    ).toHaveLength(3)
  })

  it('caps at 100 lines with a trailing count; zero matches says so and suggests a broader query', () => {
    const big = Array.from({ length: 130 }, (_, i) => m('p', `model-${String(i).padStart(3, '0')}`))
    const lines = formatPiModelList({ catalog: big, currentModel: 'p/x' }).split('\n')
    expect(lines).toHaveLength(1 + PI_MODEL_LIST_CAP + 1)
    expect(lines[lines.length - 1]).toBe('… 30 more — pass query to narrow.')
    expect(lines[1]).toContain('p/model-000')
    expect(lines[PI_MODEL_LIST_CAP]).toContain('p/model-099')

    expect(formatPiModelList({ catalog: sample, query: 'zzz', currentModel: 'p/x' })).toBe(
      'Current session model: p/x\nNo model matches "zzz". Try a broader query, or omit it to list everything.'
    )
  })

  it('an empty catalog says nothing could be listed (and the model is then unchecked)', () => {
    expect(formatPiModelList({ catalog: [], currentModel: 'p/x' })).toContain(
      'No models could be listed'
    )
  })
})
