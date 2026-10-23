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
    expect(findModelReferences({ opencode: { model: 'openai/gpt-5.5' }, engines: {} }, [])).toEqual(
      []
    )
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
      {
        model: 'openai/gpt-5.5',
        label: 'the opencode default model',
        where: 'Default model for opencode — Models & providers › Default models › opencode'
      },
      {
        model: 'openai/gpt-5.6-luna',
        label: 'the opencode small model',
        where: 'Small model for opencode — Models & providers › Default models › opencode'
      }
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

  it('finds an auto-mode FALLBACK judge model, apart from the judge model', () => {
    const refs = findModelReferences(
      {
        engines: {
          pi: {
            autoMode: {
              judgeModel: 'anthropic/claude-haiku-4-5',
              fallbackJudgeModel: 'openai/gpt-5.6-luna'
            }
          }
        }
      },
      GONE
    )
    expect(refs).toEqual([
      {
        model: 'openai/gpt-5.6-luna',
        label: 'the pi auto-mode fallback judge model',
        where: 'Fallback judge for pi — Sessions & autonomy › Auto-mode judge › pi'
      }
    ])
    expect(formatModelReferences(refs)).toBe(
      '"openai/gpt-5.6-luna" is the pi auto-mode fallback judge model — change that first.'
    )
  })

  it('reports the judge and the fallback judge separately when both are removed', () => {
    const refs = findModelReferences(
      {
        engines: {
          opencode: {
            autoMode: { judgeModel: 'openai/gpt-5.5', fallbackJudgeModel: 'openai/gpt-5.6-luna' }
          }
        }
      },
      GONE
    )
    expect(refs.map((r) => r.label)).toEqual([
      'the opencode auto-mode judge model',
      'the opencode auto-mode fallback judge model'
    ])
  })

  it('scopes the fallback judge to its engine like the judge', () => {
    const sources = {
      engines: {
        pi: { autoMode: { fallbackJudgeModel: 'openai/gpt-5.5' } },
        opencode: { autoMode: { fallbackJudgeModel: 'openai/gpt-5.6-luna' } }
      }
    }
    expect(findModelReferences(sources, GONE, 'opencode').map((r) => r.model)).toEqual([
      'openai/gpt-5.6-luna'
    ])
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
    expect(refs).toEqual([
      {
        model: 'openai/gpt-5.5',
        label: 'the pi default model',
        where: 'Default model for pi — Models & providers › Default models › pi'
      }
    ])
  })

  it('says where each dispatch and judge reference lives', () => {
    const refs = findModelReferences(
      {
        engines: {
          opencode: {
            autoMode: { judgeModel: 'openai/gpt-5.5' },
            dispatch: { defaultModel: 'openai/gpt-5.5', allowedModels: ['openai/gpt-5.6-luna'] }
          }
        }
      },
      GONE
    )
    expect(refs.map((r) => r.where)).toEqual([
      'Auto-mode judge for opencode — Sessions & autonomy › Auto-mode judge › opencode',
      'Dispatch default for opencode — Cross-engine dispatch › Dispatch into › opencode',
      'Allowed dispatch model for opencode — Cross-engine dispatch › Dispatch into › opencode'
    ])
  })

  // ADR-074 §2: opencode and pi picker values share a namespace, so an
  // unscoped scan blocked unticking an opencode model because pi's default was
  // spelled the same.
  describe('scoped to one engine', () => {
    const sources = {
      opencode: { model: 'openai/gpt-5.6-luna' },
      engines: {
        pi: { piConfig: { defaultModel: 'openai/gpt-5.5' } },
        opencode: { dispatch: { defaultModel: 'openai/gpt-5.6-luna' } }
      }
    }

    it('an opencode removal is not blocked by a pi default with the same value', () => {
      expect(findModelReferences(sources, ['openai/gpt-5.5'], 'opencode')).toEqual([])
      expect(findModelReferences(sources, ['openai/gpt-5.5'], 'pi')).toHaveLength(1)
    })

    it("reads opencode's native default only for opencode", () => {
      expect(
        findModelReferences(sources, ['openai/gpt-5.6-luna'], 'opencode').map((r) => r.label)
      ).toEqual(['the opencode default model', 'the opencode dispatch default model'])
      expect(findModelReferences(sources, ['openai/gpt-5.6-luna'], 'pi')).toEqual([])
    })

    it('unscoped, every engine still counts', () => {
      expect(findModelReferences(sources, GONE).map((r) => r.label)).toEqual([
        'the opencode default model',
        'the pi default model',
        'the opencode dispatch default model'
      ])
    })
  })

  it('tolerates null/absent config slots', () => {
    expect(findModelReferences({ opencode: null, engines: { opencode: null } }, GONE)).toEqual([])
    expect(findModelReferences({}, GONE)).toEqual([])
  })
})
