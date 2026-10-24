/**
 * The judge-reply capture seam of `makeHttpJudgeTransport` (`onCall` / `shouldCapture`) and the
 * reader taps behind it (`onDelta`, `onReasoningDelta`). Capture is diagnostics: it must report
 * what the model wrote — including the text the verdict path throws away — without changing the
 * request, the verdict or any error.
 */
import { describe, it, expect, vi } from 'vitest'
import type { JudgeRequest } from '../../classifier'
import { judgeCacheKey } from '../caps'
import { JUDGE_OVER_BUDGET_MESSAGE } from '../stream-text'
import { makeHttpJudgeTransport } from '../transport'
import {
  JUDGE_CAPTURE_REASONING_MAX_CHARS,
  type JudgeCallCapture,
  type JudgeRouteResult,
  type ResolvedJudgeRoute
} from '../types'
import { readChatStream } from '../wire-chat'
import { readResponsesStream } from '../wire-responses'
import {
  CHAT_DONE,
  chat,
  chatDelta,
  chatFinish,
  framesOf,
  resp,
  respDelta,
  routeFor,
  sseStream
} from './helpers'

/** Stage 1 of `both` mode: 64 tokens → 1,024 characters, cut at `</severity>`. */
const REQ: JudgeRequest = {
  system: 'POLICY',
  user: 'ACTION',
  maxTokens: 64,
  stopSequences: ['</severity>'],
  stage: 'fast'
}
const MAX_CHARS = 64 * 16

const COMPLETED = resp({ type: 'response.completed', response: {} })

function sse(chunks: string[]): Response {
  return new Response(sseStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const ok = (route: ResolvedJudgeRoute) => async (): Promise<JudgeRouteResult> => ({
  ok: true,
  route
})

function fetchOf(
  ...steps: Array<Response | ((init: RequestInit) => Response | Promise<Response>)>
) {
  const fn = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const step = steps.shift()
    if (!step) throw new Error('unexpected extra call')
    return typeof step === 'function' ? step(init) : step
  })
  return Object.assign(fn, { asFetch: fn as unknown as typeof fetch })
}

function capturing(route: ResolvedJudgeRoute, f: ReturnType<typeof fetchOf>) {
  const records: JudgeCallCapture[] = []
  const transport = makeHttpJudgeTransport({
    resolve: ok(route),
    fetchImpl: f.asFetch,
    shouldCapture: () => true,
    onCall: (r) => records.push(r)
  })
  return { transport, records }
}

describe('capture — switched off', () => {
  it('shouldCapture() false: onCall is never called, success or failure', async () => {
    const onCall = vi.fn()
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const f = fetchOf(
      sse([respDelta('<severity>1'), COMPLETED]),
      new Response('no', { status: 500 })
    )
    const transport = makeHttpJudgeTransport({
      resolve: ok(route),
      fetchImpl: f.asFetch,
      shouldCapture: () => false,
      onCall
    })

    expect(await transport(REQ)).toBe('<severity>1')
    await expect(transport(REQ)).rejects.toThrow(/HTTP 500/)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('no onCall: shouldCapture is not even consulted', async () => {
    const shouldCapture = vi.fn(() => true)
    const f = fetchOf(sse([respDelta('<severity>1'), COMPLETED]))
    const transport = makeHttpJudgeTransport({
      resolve: ok(routeFor('chatgpt', 'gpt-6-luna')),
      fetchImpl: f.asFetch,
      shouldCapture
    })

    expect(await transport(REQ)).toBe('<severity>1')
    expect(shouldCapture).not.toHaveBeenCalled()
  })

  it('shouldCapture is read per call: flipping it applies to the next call', async () => {
    let on = false
    const records: JudgeCallCapture[] = []
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const f = fetchOf(
      sse([respDelta('a</severity>'), COMPLETED]),
      sse([respDelta('b</severity>'), COMPLETED])
    )
    const transport = makeHttpJudgeTransport({
      resolve: ok(route),
      fetchImpl: f.asFetch,
      shouldCapture: () => on,
      onCall: (r) => records.push(r)
    })

    await transport(REQ)
    on = true
    await transport(REQ)
    expect(records.map((r) => r.text)).toEqual(['b'])
  })

  it('a throwing shouldCapture reads as off and never fails the call', async () => {
    const onCall = vi.fn()
    const f = fetchOf(sse([respDelta('a</severity>'), COMPLETED]))
    const transport = makeHttpJudgeTransport({
      resolve: ok(routeFor('chatgpt', 'gpt-6-luna')),
      fetchImpl: f.asFetch,
      shouldCapture: () => {
        throw new Error('boom')
      },
      onCall
    })

    expect(await transport(REQ)).toBe('a')
    expect(onCall).not.toHaveBeenCalled()
  })

  it('capture does not change the request: the same body and headers with and without', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const seen: Array<{ body: unknown; headers: unknown }> = []
    const spy = (init: RequestInit): Response => {
      seen.push({ body: init.body, headers: init.headers })
      return sse([respDelta('a</severity>'), COMPLETED])
    }
    await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: fetchOf(spy).asFetch })(REQ)
    await makeHttpJudgeTransport({
      resolve: ok(route),
      fetchImpl: fetchOf(spy).asFetch,
      shouldCapture: () => true,
      onCall: () => {}
    })(REQ)

    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
  })
})

describe('capture — what is reported', () => {
  it('an over-budget ChatGPT reply still fails exactly as before, with the whole reply in `raw`', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const first = 'a'.repeat(600)
    const second = 'b'.repeat(600) // pushes the kept text past 1,024: this delta overflows
    const f = fetchOf(
      sse([respDelta(first), respDelta(second), respDelta('never read'), COMPLETED])
    )
    const { transport, records } = capturing(route, f)

    await expect(transport(REQ)).rejects.toThrow(
      `chatgpt · gpt-6-luna: ${JUDGE_OVER_BUDGET_MESSAGE}`
    )

    expect(records).toHaveLength(1)
    const [r] = records
    expect(r.outcome).toBe('error')
    expect(r.error).toBe(`chatgpt · gpt-6-luna: ${JUDGE_OVER_BUDGET_MESSAGE}`)
    expect(r.raw).toBe(first + second)
    expect(r.text).toBeUndefined()
    expect(r.finish).toBeUndefined()
    expect(r).toMatchObject({
      route: 'chatgpt · gpt-6-luna',
      model: 'gpt-6-luna',
      wire: 'responses',
      stage: 'fast',
      maxTokens: 64,
      maxChars: MAX_CHARS,
      stopSequences: ['</severity>'],
      systemHash: judgeCacheKey('POLICY'),
      system: 'POLICY',
      user: 'ACTION'
    })
    expect(Date.parse(r.ts)).not.toBeNaN()
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('the same over-budget stream on the chat wire keeps the overflowing delta too', async () => {
    const route = routeFor('openrouter', 'z-ai/glm-4.6')
    const f = fetchOf(sse([chatDelta('x'.repeat(700)), chatDelta('y'.repeat(700)), CHAT_DONE]))
    const { transport, records } = capturing(route, f)

    await expect(transport(REQ)).rejects.toThrow(JUDGE_OVER_BUDGET_MESSAGE)
    expect(records[0].raw).toBe('x'.repeat(700) + 'y'.repeat(700))
  })

  it('a stop-cut success returns the same verdict text and `raw` holds the trailing text too', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const usage = resp({
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 7 } }
    })
    const f = fetchOf(
      sse([respDelta('<severity>'), respDelta('2</severity> because'), respDelta(' more'), usage])
    )
    const { transport, records } = capturing(route, f)

    expect(await transport(REQ)).toBe('<severity>2')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      outcome: 'ok',
      text: '<severity>2',
      raw: '<severity>2</severity> because more',
      finish: 'stop',
      usage: { inputTokens: 10, outputTokens: 7 }
    })
    expect(records[0].error).toBeUndefined()
    expect(records[0].status).toBeUndefined()
  })

  it('records the effective budget when the request names no maxTokens', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const f = fetchOf(sse([respDelta('hello'), COMPLETED]))
    const { transport, records } = capturing(route, f)

    await transport({ system: 'S', user: 'U' })
    expect(records[0]).toMatchObject({
      maxTokens: null,
      maxChars: 8192 * 16,
      stage: null,
      stopSequences: []
    })
  })

  it('a non-2xx reply is one record with the status and the labelled error', async () => {
    const route = routeFor('openai', 'gpt-4.1-mini')
    const f = fetchOf(new Response('{"error":"slow down"}', { status: 429 }))
    const { transport, records } = capturing(route, f)

    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', status: 429, raw: '' })
    expect(records[0].error).toMatch(/^openai · gpt-4\.1-mini: HTTP 429: /)
  })

  it('a 401 that is re-authorized reports the FINAL attempt only', async () => {
    const fresh = routeFor('chatgpt', 'gpt-6-luna', { headers: { Authorization: 'Bearer fresh' } })
    const route = routeFor('chatgpt', 'gpt-6-luna', { reauthorize: async () => fresh })
    const f = fetchOf(
      new Response('expired', { status: 401 }),
      sse([respDelta('v</severity>'), COMPLETED])
    )
    const { transport, records } = capturing(route, f)

    expect(await transport(REQ)).toBe('v')
    expect(f).toHaveBeenCalledTimes(2)
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('ok')
    expect(records[0].status).toBeUndefined()
  })

  it('a 401 whose refresh fails is one error record carrying 401', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna', { reauthorize: async () => null })
    const f = fetchOf(new Response('expired', { status: 401 }))
    const { transport, records } = capturing(route, f)

    await expect(transport(REQ)).rejects.toThrow(/HTTP 401/)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', status: 401 })
  })

  it('a request that cannot be sent is an error record without a status', async () => {
    const f = fetchOf(() => {
      throw new TypeError('fetch failed')
    })
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    await expect(transport(REQ)).rejects.toThrow(/request failed/)
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('error')
    expect(records[0].status).toBeUndefined()
  })

  it('a wire error after text arrived keeps that text in `raw`', async () => {
    const f = fetchOf(
      sse([
        respDelta('partial '),
        resp({ type: 'response.failed', response: { error: { message: 'overloaded' } } })
      ])
    )
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    await expect(transport(REQ)).rejects.toThrow(/overloaded/)
    expect(records[0]).toMatchObject({ outcome: 'error', raw: 'partial ' })
  })

  it('an abort after the request was sent is one `aborted` record', async () => {
    const ac = new AbortController()
    const f = fetchOf((init) => {
      ac.abort()
      expect(init.signal).toBe(ac.signal)
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    await expect(transport({ ...REQ, signal: ac.signal })).rejects.toThrow(
      /^auto-mode judge aborted$/
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'aborted', error: 'auto-mode judge aborted' })
  })

  it('an abort mid-stream keeps the text received so far', async () => {
    const ac = new AbortController()
    const f = fetchOf(() => {
      const enc = new TextEncoder()
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(enc.encode(respDelta('half a verd')))
              return
            }
            ac.abort()
            controller.error(new DOMException('This operation was aborted', 'AbortError'))
          }
        }),
        { status: 200 }
      )
    })
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    await expect(transport({ ...REQ, signal: ac.signal })).rejects.toThrow(
      /^auto-mode judge aborted$/
    )
    expect(records[0]).toMatchObject({ outcome: 'aborted', raw: 'half a verd' })
  })

  it('an already-aborted signal and an unresolved route send nothing, so report nothing', async () => {
    const onCall = vi.fn()
    const f = fetchOf()
    const ac = new AbortController()
    ac.abort()
    await expect(
      makeHttpJudgeTransport({
        resolve: ok(routeFor('chatgpt', 'gpt-6-luna')),
        fetchImpl: f.asFetch,
        shouldCapture: () => true,
        onCall
      })({ ...REQ, signal: ac.signal })
    ).rejects.toThrow(/aborted/)

    await expect(
      makeHttpJudgeTransport({
        resolve: async () => ({ ok: false, code: 'no-credential', reason: 'No key.' }),
        fetchImpl: f.asFetch,
        shouldCapture: () => true,
        onCall
      })(REQ)
    ).rejects.toThrow(/route unavailable/)

    expect(f).not.toHaveBeenCalled()
    expect(onCall).not.toHaveBeenCalled()
  })

  it('a throwing onCall never fails or changes the verdict', async () => {
    const f = fetchOf(
      sse([respDelta('v</severity>'), COMPLETED]),
      new Response('x', { status: 500 })
    )
    const transport = makeHttpJudgeTransport({
      resolve: ok(routeFor('chatgpt', 'gpt-6-luna')),
      fetchImpl: f.asFetch,
      shouldCapture: () => true,
      onCall: () => {
        throw new Error('disk full')
      }
    })

    expect(await transport(REQ)).toBe('v')
    await expect(transport(REQ)).rejects.toThrow(/HTTP 500/)
  })

  it('carries no credential: the record names the route label, never a header value', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna', {
      headers: {
        Authorization: 'Bearer tok-secret-0000000000000000',
        'ChatGPT-Account-Id': 'acct-1'
      }
    })
    const f = fetchOf(sse([respDelta('v</severity>'), COMPLETED]))
    const { transport, records } = capturing(route, f)

    await transport(REQ)
    const json = JSON.stringify(records[0])
    expect(json).not.toContain('tok-secret')
    expect(json).not.toContain('acct-1')
  })
})

describe('capture — reasoning', () => {
  it('chat: delta.reasoning and delta.reasoning_content land in `reasoning`, the verdict is untouched', async () => {
    const route = routeFor('openrouter', 'z-ai/glm-4.6')
    const f = fetchOf(
      sse([
        chat({ choices: [{ index: 0, delta: { reasoning: 'think ' }, finish_reason: null }] }),
        chat({
          choices: [{ index: 0, delta: { reasoning_content: 'more' }, finish_reason: null }]
        }),
        chatDelta('<severity>1</severity>'),
        chatFinish('stop'),
        CHAT_DONE
      ])
    )
    const { transport, records } = capturing(route, f)

    expect(await transport(REQ)).toBe('<severity>1')
    expect(records[0].reasoning).toBe('think more')
    expect(records[0].reasoningTruncated).toBeUndefined()
    expect(records[0].raw).toBe('<severity>1</severity>')
  })

  it('chat: an empty `reasoning` beside a non-empty `reasoning_content` still captures the text', async () => {
    const route = routeFor('openrouter', 'z-ai/glm-4.6')
    const f = fetchOf(
      sse([
        chat({
          choices: [
            {
              index: 0,
              delta: { reasoning: '', reasoning_content: 'RC-only' },
              finish_reason: null
            }
          ]
        }),
        chatDelta('<severity>1</severity>'),
        chatFinish('stop'),
        CHAT_DONE
      ])
    )
    const { transport, records } = capturing(route, f)

    expect(await transport(REQ)).toBe('<severity>1')
    expect(records[0].reasoning).toBe('RC-only')
  })

  it('responses: reasoning_summary_text.delta and reasoning_text.delta land in `reasoning`', async () => {
    const route = routeFor('chatgpt', 'gpt-6-luna')
    const f = fetchOf(
      sse([
        resp({ type: 'response.reasoning_summary_text.delta', delta: 'summary ' }),
        resp({ type: 'response.reasoning_text.delta', delta: 'raw thought' }),
        respDelta('<severity>3</severity>'),
        COMPLETED
      ])
    )
    const { transport, records } = capturing(route, f)

    expect(await transport(REQ)).toBe('<severity>3')
    expect(records[0].reasoning).toBe('summary raw thought')
  })

  it('no reasoning on the wire: the field is absent', async () => {
    const f = fetchOf(sse([respDelta('v</severity>'), COMPLETED]))
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    await transport(REQ)
    expect('reasoning' in records[0]).toBe(false)
  })

  it('caps `reasoning` at the limit and says so', async () => {
    const big = 'r'.repeat(JUDGE_CAPTURE_REASONING_MAX_CHARS - 10)
    const f = fetchOf(
      sse([
        resp({ type: 'response.reasoning_text.delta', delta: big }),
        resp({ type: 'response.reasoning_text.delta', delta: 'x'.repeat(100) }),
        resp({ type: 'response.reasoning_text.delta', delta: 'dropped' }),
        respDelta('v</severity>'),
        COMPLETED
      ])
    )
    const { transport, records } = capturing(routeFor('chatgpt', 'gpt-6-luna'), f)

    expect(await transport(REQ)).toBe('v')
    expect(records[0].reasoning).toHaveLength(JUDGE_CAPTURE_REASONING_MAX_CHARS)
    expect(records[0].reasoning?.endsWith('r'.repeat(10) + 'x'.repeat(10))).toBe(true)
    expect(records[0].reasoningTruncated).toBe(true)
  })
})

describe('reader taps', () => {
  it('onDelta sees every delta: the overflowing one and every post-stop one, in order', async () => {
    const seen: string[] = []
    // Stop at '!', budget 5: 'ab!' cuts; the drain then counts 'cdef' (4) and 'gh' (6 > 5) ends it.
    const out = await readResponsesStream(
      framesOf([
        respDelta('ab!'),
        respDelta('cdef'),
        respDelta('gh'),
        respDelta('unread'),
        COMPLETED
      ]),
      { stopSequences: ['!'], maxChars: 5, onDelta: (d) => seen.push(d) }
    )

    expect(out.text).toBe('ab')
    expect(seen).toEqual(['ab!', 'cdef', 'gh'])
  })

  it('onDelta sees the overflowing delta on the chat reader before it throws', async () => {
    const seen: string[] = []
    await expect(
      readChatStream(framesOf([chatDelta('abc'), chatDelta('defg'), CHAT_DONE]), {
        maxChars: 5,
        onDelta: (d) => seen.push(d)
      })
    ).rejects.toThrow(JUDGE_OVER_BUDGET_MESSAGE)
    expect(seen).toEqual(['abc', 'defg'])
  })

  it('the taps are optional: readers behave as before without them', async () => {
    const out = await readChatStream(
      framesOf([
        chat({ choices: [{ index: 0, delta: { reasoning: 'hmm' }, finish_reason: null }] }),
        chatDelta('ok'),
        chatFinish('stop'),
        CHAT_DONE
      ]),
      { maxChars: 100 }
    )
    expect(out).toMatchObject({ text: 'ok', finish: 'stop' })
  })
})
