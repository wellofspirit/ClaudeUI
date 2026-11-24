/**
 * Layer 1: the judge candidate rules `AutoModeSection` and the replace dialog
 * share. `AutoModeSection`'s own behaviour is pinned by its component tests; this
 * pins the extracted rules themselves, so the two surfaces cannot drift.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import {
  fallbackJudgePatch,
  fallbackSameAsJudge,
  judgeCandidates,
  useJudgeModelSupport,
  type JudgeSupportMap
} from '../judge-model-rules'
import type { JudgeModelSupport, ModelInfo } from '../../../../../shared/types'

const model = (value: string): ModelInfo =>
  ({ value, displayName: value, description: '', engineId: 'pi' }) as ModelInfo
const ok = (chatgpt = false): JudgeModelSupport => ({ ok: true, chatgpt }) as JudgeModelSupport
const refused: JudgeModelSupport = { ok: false, reason: 'no route' } as JudgeModelSupport

afterEach(cleanup)

describe('judgeCandidates', () => {
  const models = [model('a'), model('b'), model('c')]

  it('lists everything while the answer is unknown', () => {
    expect(judgeCandidates(models, null)).toEqual(models)
  })

  it('drops only an explicit refusal; an unanswered value stays listed', () => {
    const support: JudgeSupportMap = { a: ok(), b: refused }
    expect(judgeCandidates(models, support).map((m) => m.value)).toEqual(['a', 'c'])
  })
})

describe('fallbackJudgePatch', () => {
  it('clears the account with an emptied choice', () => {
    expect(fallbackJudgePatch('', null)).toEqual({
      fallbackJudgeModel: undefined,
      fallbackJudgeAccount: undefined
    })
    expect(fallbackJudgePatch('', null)).toHaveProperty('fallbackJudgeAccount')
  })

  it('clears the account for a model known NOT to route through ChatGPT', () => {
    const patch = fallbackJudgePatch('m', { m: ok(false) })
    expect(patch.fallbackJudgeModel).toBe('m')
    expect(patch).toHaveProperty('fallbackJudgeAccount', undefined)
  })

  it('leaves the account alone for a ChatGPT model, an unknown one, or no answer', () => {
    expect(fallbackJudgePatch('m', { m: ok(true) })).toEqual({ fallbackJudgeModel: 'm' })
    expect(fallbackJudgePatch('m', { other: ok(false) })).toEqual({ fallbackJudgeModel: 'm' })
    expect(fallbackJudgePatch('m', null)).toEqual({ fallbackJudgeModel: 'm' })
    expect(fallbackJudgePatch('m', { m: ok(true) })).not.toHaveProperty('fallbackJudgeAccount')
  })
})

describe('fallbackSameAsJudge', () => {
  const base = {
    judge: 'm',
    fallback: 'm',
    fallbackAccount: '',
    activeAccountId: 'acct-1',
    support: { m: ok(true) } as JudgeSupportMap | null
  }

  it('is the same model with no account of its own', () => {
    expect(fallbackSameAsJudge(base)).toBe(true)
  })

  it('is not a clash with no fallback, or a different model', () => {
    expect(fallbackSameAsJudge({ ...base, fallback: '', judge: '' })).toBe(false)
    expect(fallbackSameAsJudge({ ...base, fallback: 'n' })).toBe(false)
  })

  it('another ChatGPT account makes it a new route; the active account does not', () => {
    expect(fallbackSameAsJudge({ ...base, fallbackAccount: 'acct-2' })).toBe(false)
    expect(fallbackSameAsJudge({ ...base, fallbackAccount: 'acct-1' })).toBe(true)
  })

  it('an account on a model known not to be ChatGPT-routed is no second route', () => {
    expect(
      fallbackSameAsJudge({ ...base, fallbackAccount: 'acct-2', support: { m: ok(false) } })
    ).toBe(true)
  })

  it('unknown support counts as ChatGPT-routed, so another account still helps', () => {
    expect(fallbackSameAsJudge({ ...base, fallbackAccount: 'acct-2', support: null })).toBe(false)
  })
})

describe('useJudgeModelSupport', () => {
  const setApi = (judgeModelSupport: unknown): void => {
    ;(window as unknown as { api: Record<string, unknown> }).api = { judgeModelSupport }
  }

  it('is loading, then answered; asked once for a new array of the same values', async () => {
    const ask = vi.fn(async () => ({ a: ok() }))
    setApi(ask)
    const { result, rerender } = renderHook(({ models }) => useJudgeModelSupport('pi', models), {
      initialProps: { models: [model('a')] }
    })
    expect(result.current).toEqual({ status: 'loading', support: null })
    await waitFor(() => expect(result.current.status).toBe('answered'))
    expect(result.current.support).toEqual({ a: ok() })
    rerender({ models: [model('a')] })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith('pi', ['a'])
  })

  it('reports a failed ask, with nothing known', async () => {
    setApi(
      vi.fn(async () => {
        throw new Error('nope')
      })
    )
    const { result } = renderHook(() => useJudgeModelSupport('pi', [model('a')]))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current.support).toBeNull()
  })

  it('never asks about an empty list', () => {
    const ask = vi.fn(async () => ({}))
    setApi(ask)
    const { result } = renderHook(() => useJudgeModelSupport('pi', []))
    expect(ask).not.toHaveBeenCalled()
    expect(result.current.status).toBe('loading')
  })

  it('goes back to loading when the engine changes, and asks again', async () => {
    const ask = vi.fn(async () => ({ a: ok() }))
    setApi(ask)
    const { result, rerender } = renderHook(
      ({ engine }: { engine: 'pi' | 'opencode' }) => useJudgeModelSupport(engine, [model('a')]),
      { initialProps: { engine: 'pi' as 'pi' | 'opencode' } }
    )
    await waitFor(() => expect(result.current.status).toBe('answered'))
    rerender({ engine: 'opencode' })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('answered'))
    expect(ask).toHaveBeenLastCalledWith('opencode', ['a'])
  })
})
