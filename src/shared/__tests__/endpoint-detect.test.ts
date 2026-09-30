/**
 * Unit tests for endpoint-detect: what the custom-endpoint form does with a
 * Detect result — blanks filled, a suggested max output, provenance, the
 * Apply / Ignore diff of a second Detect, and the output warning.
 */
import { describe, it, expect } from 'vitest'
import {
  OPENCODE_DEFAULT_MAX_OUTPUT,
  PI_DEFAULT_MAX_OUTPUT,
  applyChanges,
  fieldSource,
  importModels,
  mergeProbe,
  modelFromProbe,
  outputWarning,
  suggestMaxOutput
} from '../endpoint-detect'
import type { EndpointProbeDetected, SharedProviderModel } from '../shared-provider'

const AT = '2026-09-30T10:00:00.000Z'
const LATER = '2026-09-30T11:00:00.000Z'

const sglang = (models: EndpointProbeDetected['models']): EndpointProbeDetected => ({
  status: 'detected',
  server: 'sglang',
  models
})
const vllm = (models: EndpointProbeDetected['models']): EndpointProbeDetected => ({
  status: 'detected',
  server: 'vllm',
  models
})

describe('suggestMaxOutput', () => {
  it('is a quarter of the context, capped at 32,768', () => {
    expect(suggestMaxOutput(32_768)).toBe(8_192)
    expect(suggestMaxOutput(131_072)).toBe(32_768)
    expect(suggestMaxOutput(1_000_000)).toBe(32_768)
    expect(suggestMaxOutput(10_001)).toBe(2_500)
  })
})

describe('modelFromProbe', () => {
  it('fills every reported fact, suggests an output, and records exactly what it filled', () => {
    expect(
      modelFromProbe(
        { id: 'qwen3', contextWindow: 32_768, vision: true, reasoning: false },
        'sglang',
        AT
      )
    ).toEqual({
      id: 'qwen3',
      contextWindow: 32_768,
      maxTokens: 8_192,
      vision: true,
      reasoning: false,
      detected: {
        server: 'sglang',
        at: AT,
        contextWindow: 32_768,
        maxTokens: 8_192,
        vision: true,
        reasoning: false
      }
    })
  })

  it('never suggests an output without a context, and fills nothing unreported', () => {
    expect(modelFromProbe({ id: 'ids-only' }, 'openai-compatible', AT)).toEqual({
      id: 'ids-only',
      detected: { server: 'openai-compatible', at: AT }
    })
  })

  it('suggests nothing for a context too small to yield a positive output', () => {
    const model = modelFromProbe({ id: 'tiny', contextWindow: 3 }, 'vllm', AT)
    expect(model.contextWindow).toBe(3)
    expect(model.maxTokens).toBeUndefined()
    expect(model.detected?.maxTokens).toBeUndefined()
  })
})

describe('fieldSource', () => {
  const model: SharedProviderModel = {
    id: 'm',
    contextWindow: 32_768,
    maxTokens: 8_192,
    vision: false,
    detected: { server: 'sglang', at: AT, contextWindow: 32_768, maxTokens: 8_192, vision: false }
  }

  it('server for a value equal to its baseline, suggested for the output', () => {
    expect(fieldSource(model, 'contextWindow')).toBe('server')
    expect(fieldSource(model, 'maxTokens')).toBe('suggested')
    expect(fieldSource(model, 'vision')).toBe('server')
  })

  it('default for an unset field, booleans included', () => {
    expect(fieldSource(model, 'reasoning')).toBe('default')
    expect(fieldSource({ id: 'bare' }, 'vision')).toBe('default')
  })

  it('manual for a value that differs from its baseline, or has none', () => {
    expect(fieldSource({ ...model, maxTokens: 4_096 }, 'maxTokens')).toBe('manual')
    expect(fieldSource({ ...model, vision: true }, 'vision')).toBe('manual')
    expect(fieldSource({ id: 'hand', contextWindow: 8_000 }, 'contextWindow')).toBe('manual')
    expect(fieldSource({ id: 'hand', reasoning: false }, 'reasoning')).toBe('manual')
  })
})

describe('mergeProbe', () => {
  it('auto-imports the served models into a fresh draft of blank rows', () => {
    const probe = vllm([{ id: 'a', contextWindow: 65_536 }, { id: 'b' }])
    const outcome = mergeProbe([{ id: '' }, { id: '  ' }], probe, AT)
    expect(outcome).toEqual({
      models: [
        modelFromProbe(probe.models[0], 'vllm', AT),
        modelFromProbe(probe.models[1], 'vllm', AT)
      ],
      changes: [],
      newModelIds: [],
      notServedIds: []
    })
  })

  it('auto-imports into an empty list too', () => {
    expect(mergeProbe([], vllm([{ id: 'a' }]), AT).models.map((model) => model.id)).toEqual(['a'])
  })

  it('a server serving nothing leaves the draft as it is, blank row included', () => {
    expect(mergeProbe([{ id: '' }], vllm([]), AT)).toEqual({
      models: [{ id: '' }],
      changes: [],
      newModelIds: [],
      notServedIds: []
    })
  })

  it('fills blanks on a matched model and records them; leaves unreported fields alone', () => {
    const outcome = mergeProbe(
      [{ id: 'a', name: 'A', vision: true }],
      vllm([{ id: 'a', contextWindow: 32_768 }]),
      AT
    )
    expect(outcome.changes).toEqual([])
    expect(outcome.models).toEqual([
      {
        id: 'a',
        name: 'A',
        vision: true,
        contextWindow: 32_768,
        maxTokens: 8_192,
        detected: { server: 'vllm', at: AT, contextWindow: 32_768, maxTokens: 8_192 }
      }
    ])
  })

  it('an equal value refreshes the baseline without a change', () => {
    // Typed by hand before any Detect: equal to what the server reports, so it
    // becomes the server's value.
    const outcome = mergeProbe(
      [{ id: 'a', contextWindow: 32_768, maxTokens: 8_192 }],
      vllm([{ id: 'a', contextWindow: 32_768 }]),
      AT
    )
    expect(outcome.changes).toEqual([])
    expect(outcome.models[0].detected).toEqual({
      server: 'vllm',
      at: AT,
      contextWindow: 32_768,
      maxTokens: 8_192
    })
    expect(fieldSource(outcome.models[0], 'contextWindow')).toBe('server')
    expect(fieldSource(outcome.models[0], 'maxTokens')).toBe('suggested')
  })

  it('a server-owned value the server changed is a change, not edited, and not applied', () => {
    const first = mergeProbe(
      [{ id: 'llama' }, { id: 'other' }],
      vllm([{ id: 'llama', contextWindow: 32_768 }]),
      AT
    ).models
    const outcome = mergeProbe(first, vllm([{ id: 'llama', contextWindow: 65_536 }]), LATER)
    // The output suggestion follows the NEW context into the diff.
    expect(outcome.changes).toEqual([
      { modelId: 'llama', field: 'contextWindow', from: 32_768, to: 65_536, edited: false },
      { modelId: 'llama', field: 'maxTokens', from: 8_192, to: 16_384, edited: false }
    ])
    const llama = outcome.models[0]
    expect(llama.contextWindow).toBe(32_768)
    expect(llama.maxTokens).toBe(8_192)
    // The baseline keeps the old values, so ignoring the diff still badges them "server".
    expect(llama.detected).toEqual({
      server: 'vllm',
      at: LATER,
      contextWindow: 32_768,
      maxTokens: 8_192
    })
    expect(fieldSource(llama, 'contextWindow')).toBe('server')
  })

  it('the user’s own edit of a server fact is a change marked edited, never overwritten', () => {
    const [detected] = mergeProbe(
      [{ id: 'llama' }, { id: 'x' }],
      vllm([{ id: 'llama', contextWindow: 32_768 }]),
      AT
    ).models
    const edited = { ...detected, contextWindow: 16_000 }
    const outcome = mergeProbe([edited], vllm([{ id: 'llama', contextWindow: 32_768 }]), LATER)
    expect(outcome.changes).toEqual([
      { modelId: 'llama', field: 'contextWindow', from: 16_000, to: 32_768, edited: true }
    ])
    expect(outcome.models[0].contextWindow).toBe(16_000)
    expect(fieldSource(outcome.models[0], 'contextWindow')).toBe('manual')
  })

  describe('a max output the user set never enters the diff (GUARD)', () => {
    // Detected at 32K (suggestion 8,192), then the user set their own output.
    const editedAt32K = (): SharedProviderModel => ({
      ...mergeProbe(
        [{ id: 'llama' }, { id: 'x' }],
        vllm([{ id: 'llama', contextWindow: 32_768 }]),
        AT
      ).models[0],
      maxTokens: 4_096
    })

    it('same context: no changes at all', () => {
      const outcome = mergeProbe(
        [editedAt32K()],
        vllm([{ id: 'llama', contextWindow: 32_768 }]),
        LATER
      )
      expect(outcome.changes).toEqual([])
      expect(outcome.models[0].maxTokens).toBe(4_096)
      expect(fieldSource(outcome.models[0], 'maxTokens')).toBe('manual')
    })

    it('changed context: only the context change', () => {
      const outcome = mergeProbe(
        [editedAt32K()],
        vllm([{ id: 'llama', contextWindow: 65_536 }]),
        LATER
      )
      expect(outcome.changes).toEqual([
        { modelId: 'llama', field: 'contextWindow', from: 32_768, to: 65_536, edited: false }
      ])
      expect(outcome.models[0].maxTokens).toBe(4_096)
    })
  })

  it('merges booleans by the same rules: fill, confirm, or report', () => {
    const outcome = mergeProbe(
      [
        { id: 'blank' },
        { id: 'same', vision: true, reasoning: true },
        {
          id: 'owned',
          vision: false,
          detected: { server: 'sglang', at: AT, vision: false }
        },
        { id: 'hand', reasoning: false }
      ],
      sglang(
        ['blank', 'same', 'owned', 'hand'].map((id) => ({ id, vision: true, reasoning: true }))
      ),
      LATER
    )
    expect(outcome.models[0]).toMatchObject({ vision: true, reasoning: true })
    expect(outcome.models[1].detected).toMatchObject({ vision: true, reasoning: true })
    expect(outcome.models[2]).toMatchObject({ vision: false, reasoning: true })
    expect(outcome.models[3]).toMatchObject({ vision: true, reasoning: false })
    expect(outcome.changes).toEqual([
      { modelId: 'owned', field: 'vision', from: false, to: true, edited: false },
      { modelId: 'hand', field: 'reasoning', from: false, to: true, edited: true }
    ])
  })

  it('updates server and time on every matched model, and on no other', () => {
    const outcome = mergeProbe(
      [
        { id: 'a', detected: { server: 'openai-compatible', at: AT } },
        { id: 'gone', detected: { server: 'openai-compatible', at: AT } }
      ],
      sglang([{ id: 'a' }]),
      LATER
    )
    expect(outcome.models[0].detected).toEqual({ server: 'sglang', at: LATER })
    expect(outcome.models[1].detected).toEqual({ server: 'openai-compatible', at: AT })
  })

  it('names served models the list lacks, and listed models the server lacks', () => {
    const outcome = mergeProbe(
      [{ id: 'a' }, { id: 'retired' }, { id: '' }],
      vllm([{ id: 'a' }, { id: 'new-1' }, { id: 'new-2' }]),
      AT
    )
    expect(outcome.newModelIds).toEqual(['new-1', 'new-2'])
    // A blank row being typed is not a model the server "lacks".
    expect(outcome.notServedIds).toEqual(['retired'])
  })

  it('does not mutate its input', () => {
    const models: SharedProviderModel[] = [{ id: 'a' }, { id: 'b', contextWindow: 1_000 }]
    const snapshot = structuredClone(models)
    mergeProbe(
      models,
      vllm([
        { id: 'a', contextWindow: 8_000 },
        { id: 'b', contextWindow: 2_000 }
      ]),
      AT
    )
    expect(models).toEqual(snapshot)
  })
})

describe('applyChanges', () => {
  it('writes each probed value and makes it the baseline', () => {
    const first = mergeProbe(
      [{ id: 'llama' }, { id: 'keep' }],
      vllm([{ id: 'llama', contextWindow: 32_768 }]),
      AT
    ).models
    const outcome = mergeProbe(first, vllm([{ id: 'llama', contextWindow: 65_536 }]), LATER)
    const applied = applyChanges(outcome.models, outcome.changes)
    // The context and the suggestion that follows it move together.
    expect(applied[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 16_384 })
    expect(applied[0].detected).toMatchObject({ contextWindow: 65_536, maxTokens: 16_384 })
    expect(fieldSource(applied[0], 'contextWindow')).toBe('server')
    expect(fieldSource(applied[0], 'maxTokens')).toBe('suggested')
    expect(applied[1]).toBe(outcome.models[1])
  })

  it('leaves a max output the user set where it is when the new context is applied', () => {
    const first = mergeProbe(
      [{ id: 'llama' }, { id: 'keep' }],
      vllm([{ id: 'llama', contextWindow: 32_768 }]),
      AT
    ).models
    const edited = [{ ...first[0], maxTokens: 4_096 }, first[1]]
    const outcome = mergeProbe(edited, vllm([{ id: 'llama', contextWindow: 65_536 }]), LATER)
    const [applied] = applyChanges(outcome.models, outcome.changes)
    expect(applied).toMatchObject({ contextWindow: 65_536, maxTokens: 4_096 })
    expect(fieldSource(applied, 'contextWindow')).toBe('server')
    expect(fieldSource(applied, 'maxTokens')).toBe('manual')
  })

  it('applies booleans', () => {
    const models: SharedProviderModel[] = [
      { id: 'a', vision: false, detected: { server: 'sglang', at: AT, vision: false } }
    ]
    const [applied] = applyChanges(models, [
      { modelId: 'a', field: 'vision', from: false, to: true, edited: false }
    ])
    expect(applied.vision).toBe(true)
    expect(applied.detected?.vision).toBe(true)
  })
})

describe('importModels', () => {
  it('appends the named served models, skipping ones already listed', () => {
    const probe = vllm([{ id: 'a' }, { id: 'b', contextWindow: 16_384 }, { id: 'c' }])
    const models = importModels([{ id: 'a', name: 'Mine' }], probe, ['a', 'b'], AT)
    expect(models).toEqual([{ id: 'a', name: 'Mine' }, modelFromProbe(probe.models[1], 'vllm', AT)])
  })
})

describe('outputWarning', () => {
  const both = { pi: { enabled: true }, opencode: { enabled: true } }
  const piOnly = { pi: { enabled: true }, opencode: { enabled: false } }
  const opencodeOnly = { pi: { enabled: false }, opencode: { enabled: true } }
  const none = { pi: { enabled: false }, opencode: { enabled: false } }

  it('names the engine defaults it measures a blank output by', () => {
    expect(OPENCODE_DEFAULT_MAX_OUTPUT).toBe(32_000)
    expect(PI_DEFAULT_MAX_OUTPUT).toBe(16_384)
  })

  it('warns on a 32K context with a blank output while opencode is on', () => {
    expect(outputWarning({ id: 'm', contextWindow: 32_768 }, both)).toEqual({ suggested: 8_192 })
    expect(outputWarning({ id: 'm', contextWindow: 32_768 }, opencodeOnly)).toEqual({
      suggested: 8_192
    })
  })

  it('does not warn on a 128K context with a blank output', () => {
    expect(outputWarning({ id: 'm', contextWindow: 131_072 }, both)).toBeNull()
  })

  it('pi alone on a 32K context: 16,384 is exactly half, no warning', () => {
    expect(outputWarning({ id: 'm', contextWindow: 32_768 }, piOnly)).toBeNull()
  })

  it('measures a set output regardless of routes', () => {
    expect(outputWarning({ id: 'm', contextWindow: 32_768, maxTokens: 20_000 }, piOnly)).toEqual({
      suggested: 8_192
    })
    expect(outputWarning({ id: 'm', contextWindow: 32_768, maxTokens: 20_000 }, none)).toEqual({
      suggested: 8_192
    })
    expect(outputWarning({ id: 'm', contextWindow: 32_768, maxTokens: 8_192 }, both)).toBeNull()
  })

  it('stays quiet without a context, or with a blank output no engine uses', () => {
    expect(outputWarning({ id: 'm' }, both)).toBeNull()
    expect(outputWarning({ id: 'm', maxTokens: 999_999 }, both)).toBeNull()
    expect(outputWarning({ id: 'm', contextWindow: 32_768 }, none)).toBeNull()
  })
})
