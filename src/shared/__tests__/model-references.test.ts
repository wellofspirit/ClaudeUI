/**
 * @vitest-environment node
 *
 * The settings orphan guard's pure core. An edit that removes a set of models
 * must be refused while any configured setting still names one of them —
 * these tests pin exactly which settings count as such a reference.
 */
import { describe, it, expect } from 'vitest'
import { findModelReferences, formatModelReferences } from '../model-references'

const GONE = ['openai/gpt-5.5', 'openai/gpt-5.6-luna']

describe('findModelReferences', () => {
  it('finds nothing when nothing is being removed', () => {
    expect(
      findModelReferences({ opencode: { model: 'openai/gpt-5.5' }, engines: {} }, [])
    ).toEqual([])
  })

  it('finds nothing when the removed models are unreferenced', () => {
    expect(
      findModelReferences(
        {
          opencode: { model: 'anthropic/claude-sonnet-5' },
          engines: { opencode: { autoMode: { judgeModel: 'anthropic/claude-haiku-4-5' } } }
        },
        GONE
      )
    ).toEqual([])
  })

  it("finds opencode's native default and small model", () => {
    const refs = findModelReferences(
      { opencode: { model: 'openai/gpt-5.5', smallModel: 'openai/gpt-5.6-luna' } },
      GONE
    )
    expect(refs).toEqual([
      { model: 'openai/gpt-5.5', label: 'the opencode default model' },
      { model: 'openai/gpt-5.6-luna', label: 'the opencode small model' }
    ])
  })

  it('finds an auto-mode judge model (the owner-named example)', () => {
    const refs = findModelReferences(
      { engines: { opencode: { autoMode: { judgeModel: 'openai/gpt-5.6-luna' } } } },
      GONE
    )
    expect(refs).toHaveLength(1)
    expect(formatModelReferences(refs)).toBe(
      '"openai/gpt-5.6-luna" is the opencode auto-mode judge model — change that first.'
    )
  })

  it('finds dispatch default + allowed models, INCLUDING on another engine', () => {
    // Cross-engine dispatch: claude's config legitimately names opencode models,
    // so a guard that only looked at the opencode engine would miss it.
    const refs = findModelReferences(
      {
        engines: {
          claude: {
            dispatch: {
              defaultModel: 'openai/gpt-5.5',
              allowedModels: ['openai/gpt-5.6-luna', 'anthropic/claude-sonnet-5']
            }
          }
        }
      },
      GONE
    )
    expect(refs.map((r) => r.label)).toEqual([
      'the Claude dispatch default model',
      'an allowed dispatch model for Claude'
    ])
  })

  it("finds pi's configured default model", () => {
    const refs = findModelReferences(
      { engines: { pi: { piConfig: { defaultModel: 'openai/gpt-5.5' } } } },
      GONE
    )
    expect(refs).toEqual([{ model: 'openai/gpt-5.5', label: 'the pi default model' }])
  })

  it('tolerates null/absent config slots', () => {
    expect(findModelReferences({ opencode: null, engines: { opencode: null } }, GONE)).toEqual([])
    expect(findModelReferences({}, GONE)).toEqual([])
  })
})
