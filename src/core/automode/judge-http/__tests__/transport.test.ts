/**
 * `makeHttpJudgeTransport` against a fake `fetch` returning real `Response`
 * objects over `ReadableStream` bodies — no network. Covers the request it
 * sends, the 401 re-authorization retry, HTTP error copy, usage reporting,
 * aborts, and the end-to-end fail-closed path through `classify()`.
 */
import { describe, it, expect, vi } from 'vitest'
import { classify, STAGE1_TIMEOUT_MS, type JudgeRequest } from '../../classifier'
import { judgeCacheKey } from '../caps'
import { JudgeRouteUnavailableError, makeHttpJudgeTransport } from '../transport'
import { JudgeWireError, type JudgeRouteResult, type ResolvedJudgeRoute } from '../types'
import {
  CHAT_DONE,
  FAKE_KEY,
  chat,
  chatDelta,
  chatFinish,
  resp,
  respDelta,
  routeFor,
  sseStream
} from './helpers'

const REQ: JudgeRequest = {
  system: 'POLICY',
  user: 'ACTION',
  maxTokens: 64,
  stopSequences: ['</block>'],
  stage: 'fast'
}

const CHAT_USAGE = chat({
  usage: {
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 80 },
    completion_tokens: 5,
    completion_tokens_details: { reasoning_tokens: 0 },
    cost: 0.0001
  }
})
const CHAT_OK = [chatDelta('<block>no</block>'), chatFinish('stop'), CHAT_USAGE, CHAT_DONE]

function sse(chunks: string[], init: ResponseInit = {}): Response {
  return new Response(sseStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init
  })
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } })
}

type Step = Response | ((init: RequestInit) => Response | Promise<Response>)

/** A fetch that answers with each step in turn and records every call. */
function fakeFetch(...steps: Step[]) {
  const fn = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const step = steps.shift()
    if (!step) throw new Error('fakeFetch: unexpected extra call')
    return typeof step === 'function' ? step(init) : step
  })
  return Object.assign(fn, {
    asFetch: fn as unknown as typeof fetch,
    headers: (i: number) => fn.mock.calls[i][1].headers as Record<string, string>,
    body: (i: number) => JSON.parse(fn.mock.calls[i][1].body as string) as Record<string, unknown>
  })
}

const ok = (route: ResolvedJudgeRoute) => async (): Promise<JudgeRouteResult> => ({
  ok: true,
  route
})

describe('makeHttpJudgeTransport — requests', () => {
  it('POSTs the chat body with our headers plus the route headers, and returns the text', async () => {
    const route = routeFor('openai', 'gpt-4.1-mini')
    const f = fakeFetch(sse(CHAT_OK))
    const onUsage = vi.fn()
    const transport = makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch, onUsage })

    expect(await transport(REQ)).toBe('<block>no')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(route.url)
    expect(init.method).toBe('POST')
    expect(f.headers(0)).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'ClaudeUI',
      authorization: `Bearer ${FAKE_KEY}`
    })
    expect(f.body(0)).toMatchObject({ model: 'gpt-4.1-mini', stream: true, stop: ['</block>'] })
    expect(onUsage).toHaveBeenCalledWith(
      {
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 5,
        reasoningTokens: 0,
        costUsd: 0.0001
      },
      route
    )
  })

  it('sends the cache key as the affinity header (x-session-id on OpenRouter)', async () => {
    const route = routeFor('openrouter', 'z-ai/glm-4.6')
    const f = fakeFetch(sse(CHAT_OK))
    await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(REQ)
    expect(f.headers(0)['x-session-id']).toBe(judgeCacheKey('POLICY'))
  })

  it('chatgpt: Responses body, session-id = prompt_cache_key, route headers win over ours', async () => {
    const route = routeFor('chatgpt', 'gpt-5.1-codex-mini', {
      headers: {
        Authorization: 'Bearer tok-test-0000000000000000',
        'ChatGPT-Account-Id': 'acct-test',
        originator: 'opencode',
        'User-Agent': 'opencode/test'
      }
    })
    const f = fakeFetch(
      sse([respDelta('<block>no</block>'), resp({ type: 'response.completed', response: {} })])
    )
    const out = await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(REQ)
    expect(out).toBe('<block>no')
    const headers = f.headers(0)
    expect(headers['session-id']).toBe(judgeCacheKey('POLICY'))
    expect(headers['chatgpt-account-id']).toBe('acct-test')
    expect(headers.originator).toBe('opencode')
    // One user-agent, the route's — not a doubled "ClaudeUI, opencode/test".
    expect(headers['user-agent']).toBe('opencode/test')
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1)
    const body = f.body(0)
    expect(body.prompt_cache_key).toBe(headers['session-id'])
    expect(body.instructions).toBe('POLICY')
    expect(body).not.toHaveProperty('max_output_tokens')
  })

  it('a custom userAgent replaces the default', async () => {
    const f = fakeFetch(sse(CHAT_OK))
    await makeHttpJudgeTransport({
      resolve: ok(routeFor('custom-chat', 'm', { headers: {} })),
      fetchImpl: f.asFetch,
      userAgent: 'ClaudeUI/3.6.0'
    })(REQ)
    expect(f.headers(0)['user-agent']).toBe('ClaudeUI/3.6.0')
    expect(f.headers(0)).not.toHaveProperty('authorization')
  })

  it('resolves the route on EVERY call (rotation, refresh)', async () => {
    const resolve = vi.fn(ok(routeFor('custom-chat', 'm')))
    const f = fakeFetch(sse(CHAT_OK), sse(CHAT_OK))
    const transport = makeHttpJudgeTransport({ resolve, fetchImpl: f.asFetch })
    await transport(REQ)
    await transport(REQ)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('derives the character budget from maxTokens (16 chars per token)', async () => {
    const f = fakeFetch(sse([chatDelta('x'.repeat(17)), CHAT_DONE]))
    const transport = makeHttpJudgeTransport({
      resolve: ok(routeFor('custom-chat', 'm')),
      fetchImpl: f.asFetch
    })
    await expect(transport({ system: 'S', user: 'U', maxTokens: 1 })).rejects.toThrow(
      'custom-chat · m: judge output exceeded its budget'
    )
  })
})

describe('makeHttpJudgeTransport — unavailable routes and HTTP errors', () => {
  it('resolve() unavailable → JudgeRouteUnavailableError, and nothing is sent', async () => {
    const f = fakeFetch()
    const transport = makeHttpJudgeTransport({
      resolve: async () => ({
        ok: false,
        code: 'no-shared-provider',
        reason: 'GitHub Copilot keys stay inside opencode'
      }),
      fetchImpl: f.asFetch
    })
    const err = await transport(REQ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeRouteUnavailableError)
    expect(err).toMatchObject({
      code: 'no-shared-provider',
      reason: 'GitHub Copilot keys stay inside opencode'
    })
    expect(f).not.toHaveBeenCalled()
  })

  it('401 → reauthorize → one retry with the FRESH route → success', async () => {
    const fresh = routeFor('chatgpt', 'gpt-5.1-codex-mini', {
      headers: { Authorization: 'Bearer tok-test-fresh-000000000000' }
    })
    const reauthorize = vi.fn(async () => fresh)
    const stale = routeFor('chatgpt', 'gpt-5.1-codex-mini', {
      headers: { Authorization: 'Bearer tok-test-stale-000000000000' },
      reauthorize
    })
    const f = fakeFetch(
      text(401, '{"detail":"token expired"}'),
      sse([respDelta('<block>no'), resp({ type: 'response.completed', response: {} })])
    )
    const out = await makeHttpJudgeTransport({ resolve: ok(stale), fetchImpl: f.asFetch })(REQ)
    expect(out).toBe('<block>no')
    expect(reauthorize).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.headers(0).authorization).toBe('Bearer tok-test-stale-000000000000')
    expect(f.headers(1).authorization).toBe('Bearer tok-test-fresh-000000000000')
  })

  it('401 twice → throws; reauthorize is called once, never looped', async () => {
    const fresh: ResolvedJudgeRoute = {
      ...routeFor('chatgpt', 'gpt-5.1-codex-mini'),
      reauthorize: vi.fn(async () => null)
    }
    const reauthorize = vi.fn(async () => fresh)
    const route = routeFor('chatgpt', 'gpt-5.1-codex-mini', { reauthorize })
    const f = fakeFetch(text(401, 'nope'), text(401, 'still nope'))
    const err = await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(
      REQ
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).message).toBe(
      'chatgpt · gpt-5.1-codex-mini: HTTP 401: still nope'
    )
    expect((err as JudgeWireError).status).toBe(401)
    expect(reauthorize).toHaveBeenCalledTimes(1)
    expect(fresh.reauthorize).not.toHaveBeenCalled()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('401 with no reauthorize → throws at once', async () => {
    const f = fakeFetch(text(401, '{"error":{"message":"Incorrect API key"}}'))
    await expect(
      makeHttpJudgeTransport({
        resolve: ok(routeFor('openai', 'gpt-5-mini')),
        fetchImpl: f.asFetch
      })(REQ)
    ).rejects.toThrow('openai · gpt-5-mini: HTTP 401: {"error":{"message":"Incorrect API key"}}')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('401 whose refresh fails (reauthorize → null) throws the 401', async () => {
    const route = routeFor('chatgpt', 'gpt-5.1', { reauthorize: async () => null })
    const f = fakeFetch(text(401, 'expired'))
    await expect(
      makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(REQ)
    ).rejects.toThrow('HTTP 401: expired')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('401 whose refresh THROWS is treated as a failed refresh: the labelled 401 surfaces', async () => {
    const route = routeFor('chatgpt', 'gpt-5.1', {
      reauthorize: async () => {
        throw new Error('refresh endpoint said: invalid_grant for tok-test-refresh-0000')
      }
    })
    const f = fakeFetch(text(401, 'expired'))
    const err = await makeHttpJudgeTransport({ resolve: ok(route), fetchImpl: f.asFetch })(
      REQ
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).message).toBe('chatgpt · gpt-5.1: HTTP 401: expired')
    expect((err as JudgeWireError).status).toBe(401)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 carries retry-after and resets_at, and is not retried', async () => {
    const resetsAt = Date.UTC(2026, 8, 28, 12, 0, 0) / 1000
    const f = fakeFetch(
      text(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: resetsAt } }), {
        'retry-after': '120'
      })
    )
    const err = await makeHttpJudgeTransport({
      resolve: ok(routeFor('chatgpt', 'gpt-5.1', { reauthorize: vi.fn() })),
      fetchImpl: f.asFetch
    })(REQ).catch((e: unknown) => e)
    expect((err as Error).message).toContain(
      'HTTP 429 (retry-after 120, resets at 2026-09-28T12:00:00.000Z)'
    )
    expect((err as JudgeWireError).status).toBe(429)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('the body excerpt is capped at 2 KB and scrubbed of anything from the request headers', async () => {
    const echoed = `{"echo":"Authorization: Bearer ${FAKE_KEY}","pad":"${'p'.repeat(5000)}"}`
    const f = fakeFetch(text(400, echoed))
    const err = await makeHttpJudgeTransport({
      resolve: ok(routeFor('openai', 'gpt-4.1-mini')),
      fetchImpl: f.asFetch
    })(REQ).catch((e: unknown) => e)
    const message = (err as Error).message
    expect(message).not.toContain(FAKE_KEY)
    expect(message).toContain('[redacted]')
    expect(message.length).toBeLessThan(2048 + 100)
  })

  it('an empty error body still says what happened', async () => {
    const f = fakeFetch(new Response(null, { status: 503 }))
    await expect(
      makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })(
        REQ
      )
    ).rejects.toThrow('custom-chat · m: HTTP 503: (empty body)')
  })

  it('a network failure is labelled, with no URL or header in the message', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const route = routeFor('custom-chat', 'm', { url: 'https://judge.test/v1/chat/completions' })
    const err = await makeHttpJudgeTransport({
      resolve: ok(route),
      fetchImpl: f as unknown as typeof fetch
    })(REQ).catch((e: unknown) => e)
    expect((err as Error).message).toBe('custom-chat · m: request failed: fetch failed')
  })
})

describe('makeHttpJudgeTransport — usage', () => {
  it('a throwing onUsage never fails the verdict', async () => {
    const f = fakeFetch(sse(CHAT_OK))
    const transport = makeHttpJudgeTransport({
      resolve: ok(routeFor('openrouter', 'z-ai/glm-4.6')),
      fetchImpl: f.asFetch,
      onUsage: () => {
        throw new Error('db locked')
      }
    })
    expect(await transport(REQ)).toBe('<block>no')
  })

  it('no usage in the stream → onUsage is not called', async () => {
    const onUsage = vi.fn()
    const f = fakeFetch(sse([chatDelta('<block>no'), CHAT_DONE]))
    await makeHttpJudgeTransport({
      resolve: ok(routeFor('custom-chat', 'm')),
      fetchImpl: f.asFetch,
      onUsage
    })(REQ)
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('a mid-stream error AFTER usage still reports the usage, then throws (labelled)', async () => {
    const onUsage = vi.fn()
    const f = fakeFetch(
      sse([
        chatDelta('<block>'),
        CHAT_USAGE,
        chat({ error: { code: 'overloaded', message: 'busy' } })
      ])
    )
    const err = await makeHttpJudgeTransport({
      resolve: ok(routeFor('openrouter', 'z-ai/glm-4.6')),
      fetchImpl: f.asFetch,
      onUsage
    })(REQ).catch((e: unknown) => e)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).message).toBe(
      'openrouter · z-ai/glm-4.6: judge stream error (overloaded): busy'
    )
    expect((err as JudgeWireError).code).toBe('overloaded')
  })
})

describe('makeHttpJudgeTransport — abort', () => {
  it('an already-aborted signal throws without sending anything', async () => {
    const f = fakeFetch()
    const ac = new AbortController()
    ac.abort()
    await expect(
      makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })({
        ...REQ,
        signal: ac.signal
      })
    ).rejects.toThrow(/^auto-mode judge aborted$/)
    expect(f).not.toHaveBeenCalled()
  })

  it('passes the signal to fetch, and an abort mid-stream surfaces as one message', async () => {
    const enc = new TextEncoder()
    const f = fakeFetch((init) => {
      const signal = init.signal!
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(chatDelta('<block>')))
          signal.addEventListener('abort', () =>
            controller.error(new DOMException('This operation was aborted', 'AbortError'))
          )
        }
      })
      return new Response(body, { status: 200 })
    })
    const ac = new AbortController()
    const p = makeHttpJudgeTransport({
      resolve: ok(routeFor('custom-chat', 'm')),
      fetchImpl: f.asFetch
    })({ ...REQ, signal: ac.signal })
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[0][1].signal).toBe(ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/^auto-mode judge aborted$/)
  })

  it('fetch rejecting with AbortError surfaces as the same message', async () => {
    const ac = new AbortController()
    const f = fakeFetch(() => {
      ac.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    await expect(
      makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })({
        ...REQ,
        signal: ac.signal
      })
    ).rejects.toThrow(/^auto-mode judge aborted$/)
  })
})

describe('makeHttpJudgeTransport through classify()', () => {
  const input = {
    messages: [],
    action: { toolName: 'bash', input: { command: 'ls' } },
    environment: { cwd: '/repo' }
  }

  it('a clean stage-1 allow returns the verdict', async () => {
    // Stage 1 in `both` mode is a severity grade (ADR-083 §2); the stop
    // sequence eats the closing tag.
    const f = fakeFetch(sse([chatDelta('<severity>3'), chatFinish('stop'), CHAT_USAGE, CHAT_DONE]))
    const r = await classify(
      input,
      makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })
    )
    expect(r).toMatchObject({ block: false, stage: 'fast', severity: 3 })
    // Stage 1's budget and stop sequence really went over the wire.
    expect(f.body(0)).toMatchObject({ max_tokens: 64, stop: ['</severity>'] })
  })

  it('a provider error is unavailable (→ the human), never a BLOCK verdict', async () => {
    // The defect the engine session judge had: a provider error became an
    // empty reply, which classify() reads as an unparseable block.
    const f = fakeFetch(sse([chat({ error: { code: 500, message: 'provider exploded' } })]))
    const r = await classify(
      input,
      makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })
    )
    expect(r).toMatchObject({ block: true, stage: 'error', unavailable: true })
    expect(r.error).toContain('provider exploded')
  })

  it('an unroutable judge model is unavailable too', async () => {
    const r = await classify(
      input,
      makeHttpJudgeTransport({
        resolve: async () => ({ ok: false, code: 'unsupported-protocol', reason: 'no route' }),
        fetchImpl: fakeFetch().asFetch
      })
    )
    expect(r).toMatchObject({ stage: 'error', unavailable: true })
  })

  it('a stage timeout aborts the in-flight request', async () => {
    vi.useFakeTimers()
    try {
      let seen: AbortSignal | undefined
      const f = fakeFetch(
        (init) =>
          new Promise<Response>((_resolve, reject) => {
            seen = init.signal ?? undefined
            seen?.addEventListener('abort', () =>
              reject(new DOMException('This operation was aborted', 'AbortError'))
            )
          })
      )
      const p = classify(
        { ...input, twoStageMode: 'fast' },
        makeHttpJudgeTransport({ resolve: ok(routeFor('custom-chat', 'm')), fetchImpl: f.asFetch })
      )
      await vi.advanceTimersByTimeAsync(STAGE1_TIMEOUT_MS)
      expect(seen?.aborted).toBe(true)
      expect((await p).error).toBe(`auto-mode judge timed out after ${STAGE1_TIMEOUT_MS} ms`)
    } finally {
      vi.useRealTimers()
    }
  })
})
