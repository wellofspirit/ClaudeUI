/**
 * The reasoning-effort floor: a ChatGPT workspace that refuses stage 1's `none`/`minimal` effort
 * (HTTP 403) is retried once at `low`, and `low` is then that route's floor until restart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JudgeRequest } from '../../classifier'
import { clearEffortFloors } from '../effort-floor'
import { makeHttpJudgeTransport } from '../transport'
import {
  JudgeWireError,
  type JudgeCallCapture,
  type JudgeRouteKind,
  type JudgeRouteResult,
  type ResolvedJudgeRoute
} from '../types'
import { FAKE_ACCOUNT, resp, respDelta, routeFor, sseStream } from './helpers'

const FAST: JudgeRequest = { system: 'POLICY', user: 'ACTION', maxTokens: 64, stage: 'fast' }
const THINKING: JudgeRequest = { ...FAST, stage: 'thinking' }

const REFUSAL = JSON.stringify({
  detail:
    "This reasoning level isn't available for the selected model in your workspace. Choose an available reasoning level or another model."
})

const text = (status: number, body: string) => new Response(body, { status })
const success = () =>
  new Response(
    sseStream([respDelta('<block>no'), resp({ type: 'response.completed', response: {} })]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )

/** Serves the steps in order; any request beyond them fails the test. */
function fakeFetch(...steps: Response[]) {
  const bodies: Array<Record<string, any>> = []
  const headers: Array<Record<string, string>> = []
  const fn = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(init.body as string))
    headers.push(init.headers as Record<string, string>)
    const step = steps.shift()
    if (!step) throw new Error('unexpected extra request')
    return step
  })
  return Object.assign(fn, {
    asFetch: fn as unknown as typeof fetch,
    effort: (i: number): unknown => bodies[i]?.reasoning?.effort,
    auth: (i: number): string | undefined => headers[i]?.authorization
  })
}

const ok = (route: ResolvedJudgeRoute) => async (): Promise<JudgeRouteResult> => ({
  ok: true,
  route
})

const luna = (extra: Parameters<typeof routeFor>[2] = {}) =>
  routeFor('chatgpt', 'gpt-6-luna', extra)

beforeEach(() => clearEffortFloors())

describe('effort floor — step-up on the workspace refusal', () => {
  it('1: stage 1 at none is refused → retried at low, no error, onEffortRaised once', async () => {
    const f = fakeFetch(text(403, REFUSAL), success())
    const onEffortRaised = vi.fn()
    const out = await makeHttpJudgeTransport({
      resolve: ok(luna()),
      fetchImpl: f.asFetch,
      onEffortRaised
    })(FAST)
    expect(out).toBe('<block>no')
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.effort(0)).toBe('none')
    expect(f.effort(1)).toBe('low')
    expect(onEffortRaised).toHaveBeenCalledTimes(1)
    // The route's credential-free label, never the account key.
    expect(onEffortRaised).toHaveBeenCalledWith(luna().label, 'none', 'low')
  })

  it('1: a throwing onEffortRaised never fails the verdict', async () => {
    const f = fakeFetch(text(403, REFUSAL), success())
    const out = await makeHttpJudgeTransport({
      resolve: ok(luna()),
      fetchImpl: f.asFetch,
      onEffortRaised: () => {
        throw new Error('log sink down')
      }
    })(FAST)
    expect(out).toBe('<block>no')
  })

  it('2: the next call on the same route sends low first, with no second notice', async () => {
    const onEffortRaised = vi.fn()
    const first = fakeFetch(text(403, REFUSAL), success())
    const t1 = makeHttpJudgeTransport({
      resolve: ok(luna()),
      fetchImpl: first.asFetch,
      onEffortRaised
    })
    await t1(FAST)
    const second = fakeFetch(success())
    const t2 = makeHttpJudgeTransport({
      resolve: ok(luna()),
      fetchImpl: second.asFetch,
      onEffortRaised
    })
    await t2(FAST)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.effort(0)).toBe('low')
    expect(onEffortRaised).toHaveBeenCalledTimes(1)
  })

  it('3: another account on the same model still sends none first', async () => {
    await makeHttpJudgeTransport({
      resolve: ok(luna()),
      fetchImpl: fakeFetch(text(403, REFUSAL), success()).asFetch
    })(FAST)
    const other: ResolvedJudgeRoute = {
      ...luna(),
      account: { ...FAKE_ACCOUNT, accountKey: 'test-vendor:acct:other' }
    }
    const f = fakeFetch(success())
    await makeHttpJudgeTransport({ resolve: ok(other), fetchImpl: f.asFetch })(FAST)
    expect(f.effort(0)).toBe('none')
  })

  it('4: low refused after the step-up → labelled 403 after exactly two requests', async () => {
    const f = fakeFetch(text(403, REFUSAL), text(403, REFUSAL))
    const err = await makeHttpJudgeTransport({ resolve: ok(luna()), fetchImpl: f.asFetch })(
      FAST
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).status).toBe(403)
    expect((err as JudgeWireError).message).toMatch(/^chatgpt · gpt-6-luna: HTTP 403: /)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.effort(1)).toBe('low')
  })

  it('5: stage 2 (low) refused → no retry', async () => {
    const f = fakeFetch(text(403, REFUSAL))
    const err = await makeHttpJudgeTransport({ resolve: ok(luna()), fetchImpl: f.asFetch })(
      THINKING
    ).catch((e: unknown) => e)
    expect((err as JudgeWireError).status).toBe(403)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.effort(0)).toBe('low')
  })

  it.each<[string, JudgeRouteKind, Response]>([
    ['403 without the phrase', 'chatgpt', text(403, '{"detail":"Forbidden"}')],
    ['non-JSON 403 body', 'chatgpt', text(403, "reasoning level isn't available")],
    ['400 with the phrase', 'chatgpt', text(400, REFUSAL)],
    ['openai route with the phrase', 'openai', text(403, REFUSAL)]
  ])('6: %s → no retry, throws', async (_name, kind, response) => {
    const model = kind === 'openai' ? 'gpt-5.1' : 'gpt-6-luna'
    const f = fakeFetch(response)
    await expect(
      makeHttpJudgeTransport({ resolve: ok(routeFor(kind, model)), fetchImpl: f.asFetch })(FAST)
    ).rejects.toBeInstanceOf(JudgeWireError)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('7: 401 re-authorizes, then the refusal, then success — the last request has the new token and low', async () => {
    const fresh = luna({ headers: { Authorization: 'Bearer tok-test-fresh-000000000000' } })
    const stale = luna({
      headers: { Authorization: 'Bearer tok-test-stale-000000000000' },
      reauthorize: async () => fresh
    })
    const f = fakeFetch(text(401, '{"detail":"expired"}'), text(403, REFUSAL), success())
    await makeHttpJudgeTransport({ resolve: ok(stale), fetchImpl: f.asFetch })(FAST)
    expect(f).toHaveBeenCalledTimes(3)
    expect(f.auth(1)).toBe('Bearer tok-test-fresh-000000000000')
    expect(f.auth(2)).toBe('Bearer tok-test-fresh-000000000000')
    expect([f.effort(0), f.effort(1), f.effort(2)]).toEqual(['none', 'none', 'low'])
  })

  it('8: capture records the effort sent and the refused ones', async () => {
    const records: JudgeCallCapture[] = []
    const run = (f: ReturnType<typeof fakeFetch>) =>
      makeHttpJudgeTransport({
        resolve: ok(luna()),
        fetchImpl: f.asFetch,
        shouldCapture: () => true,
        onCall: (r) => records.push(r)
      })(FAST)
    await run(fakeFetch(text(403, REFUSAL), success()))
    expect(records[0]).toMatchObject({ effort: 'low', refusedEfforts: ['none'], outcome: 'ok' })

    clearEffortFloors()
    records.length = 0
    await run(fakeFetch(success()))
    expect(records[0]?.effort).toBe('none')
    expect(records[0]).not.toHaveProperty('refusedEfforts')
  })

  it('9: stage 2 after a floor is set still sends low, and capsFor is not mutated', async () => {
    const route = luna()
    await makeHttpJudgeTransport({
      resolve: ok(route),
      fetchImpl: fakeFetch(text(403, REFUSAL), success()).asFetch
    })(FAST)
    const f = fakeFetch(success())
    await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(THINKING)
    expect(f.effort(0)).toBe('low')
    expect(route.caps.reasoning.fast).toEqual({ reasoning: { effort: 'none' } })
  })
})
