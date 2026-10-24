/**
 * `makeSessionJudgeTransport` — the owners' one wiring of the HTTP judge. What this pins is the
 * failure report: `onUnavailable` fires for a route that cannot be called AND for a call that
 * fails (HTTP 429, an outage), so the session's one banner says why every gated action is asking
 * the human instead of the call looking like an ordinary permission prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockResolve, mockFetch, capture } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockFetch: vi.fn(),
  capture: { enabled: false, write: vi.fn() }
}))
vi.mock('../judge-route', () => ({ resolveJudgeRoute: mockResolve }))
vi.mock('../judge-usage', () => ({ recordJudgeUsage: vi.fn() }))
vi.mock('../judge-capture', () => ({
  judgeCaptureEnabled: () => capture.enabled,
  writeJudgeCapture: capture.write
}))
vi.mock('../../host', () => ({ hostAppVersion: () => 'test' }))
vi.mock('../judge-http/net', () => ({ pickJudgeFetch: async () => mockFetch }))

import type { JudgeRequest } from '../classifier'
import {
  CHAT_DONE,
  chatDelta,
  chatFinish,
  routeFor,
  sseStream
} from '../judge-http/__tests__/helpers'
import { refreshChatgptAccounts, resetChatgptAccounts } from '../judge-accounts'
import { clearCooldowns, coolingUntil } from '../judge-cooldown'
import { judgeRouteKey } from '../judge-http/transport'
import {
  fallbackJudgeAccountFor,
  fallbackJudgeLabel,
  fallbackJudgeModelFor,
  fallbackUnavailableMessage,
  judgeFallbackMessage,
  judgeRouteUnavailableMessage,
  judgeUnavailableMessage,
  makeFallbackJudge,
  makeSessionJudgeTransport,
  staleJudgeModelMessage
} from '../session-judge'

const REQ: JudgeRequest = { system: 'POLICY', user: 'ACTION', maxTokens: 64, stage: 'fast' }

function setup() {
  const onUnavailable = vi.fn<(reason: string) => void>()
  const transport = makeSessionJudgeTransport({
    engine: 'pi',
    modelValue: () => 'chatgpt/gpt-6-luna',
    sessionId: () => 's1',
    routingId: 'r1',
    onUnavailable
  })
  return { transport, onUnavailable }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearCooldowns()
  resetChatgptAccounts()
  capture.enabled = false
  mockResolve.mockResolvedValue({ ok: true, route: routeFor('chatgpt', 'gpt-6-luna') })
})

describe('makeSessionJudgeTransport — failure reports', () => {
  it('a 429 reports the route, status and reset time (no body) and still throws for classify', async () => {
    const resetsAt = Date.UTC(2026, 9, 28, 13, 34, 58) / 1000
    mockFetch.mockResolvedValue(
      json(429, { error: { type: 'usage_limit_reached', resets_at: resetsAt } })
    )
    const { transport, onUnavailable } = setup()

    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(onUnavailable).toHaveBeenCalledWith(
      'chatgpt · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z).'
    )
    // The banner text an owner shows for it.
    expect(judgeRouteUnavailableMessage('pi', onUnavailable.mock.calls[0][0])).toMatch(
      /^Auto-mode can't judge here: chatgpt · gpt-6-luna: HTTP 429 \(resets at 2026-10-28T13:34:58\.000Z\)\. Every gated action will ask you instead\./
    )
  })

  it('a network error reports too', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    const { transport, onUnavailable } = setup()

    await expect(transport(REQ)).rejects.toThrow(/request failed/)
    expect(onUnavailable).toHaveBeenCalledWith(
      'chatgpt · gpt-6-luna: request failed: fetch failed.'
    )
  })

  it('a missing route is reported once, by the resolver, not again as a failed call', async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      code: 'chatgpt-unavailable',
      reason: 'ChatGPT is signed out.'
    })
    const { transport, onUnavailable } = setup()

    await expect(transport(REQ)).rejects.toThrow(/route unavailable/)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(onUnavailable).toHaveBeenCalledWith('ChatGPT is signed out.')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('an abort (a stage timeout or a cancelled review) reports nothing', async () => {
    const controller = new AbortController()
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { transport, onUnavailable } = setup()

    const call = transport({ ...REQ, signal: controller.signal })
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())
    controller.abort()

    await expect(call).rejects.toThrow('auto-mode judge aborted')
    expect(onUnavailable).not.toHaveBeenCalled()
  })

  it('a call that succeeds reports nothing', async () => {
    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1-mini') })
    mockFetch.mockResolvedValue(
      new Response(sseStream([chatDelta('<block>no</block>'), chatFinish('stop'), CHAT_DONE]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    const { transport, onUnavailable } = setup()

    await expect(transport(REQ)).resolves.toContain('<block>no</block>')
    expect(onUnavailable).not.toHaveBeenCalled()
  })
})

describe('makeSessionJudgeTransport — judge-reply capture', () => {
  const okStream = (): Response =>
    new Response(sseStream([chatDelta('<severity>1</severity>'), chatFinish('stop'), CHAT_DONE]), {
      status: 200
    })

  it('the switch off: nothing is handed to the writer', async () => {
    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1-mini') })
    mockFetch.mockResolvedValue(okStream())
    const { transport } = setup()

    await transport(REQ)
    expect(capture.write).not.toHaveBeenCalled()
  })

  it('the switch on: the writer gets the call with the engine, routing id and session id', async () => {
    capture.enabled = true
    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1-mini') })
    mockFetch.mockResolvedValue(okStream())
    const { transport } = setup()

    await transport({ ...REQ, stopSequences: ['</severity>'] })
    expect(capture.write).toHaveBeenCalledTimes(1)
    expect(capture.write.mock.calls[0][0]).toMatchObject({
      engine: 'pi',
      routingId: 'r1',
      sessionId: 's1',
      route: 'openai · gpt-4.1-mini',
      outcome: 'ok',
      raw: '<severity>1</severity>',
      text: '<severity>1',
      user: 'ACTION',
      system: 'POLICY'
    })
  })

  it('is read per call: switching it on applies to the next call of a live transport', async () => {
    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1-mini') })
    mockFetch.mockImplementation(async () => okStream())
    const { transport } = setup()

    await transport(REQ)
    capture.enabled = true
    await transport(REQ)
    capture.enabled = false
    await transport(REQ)
    expect(capture.write).toHaveBeenCalledTimes(1)
  })

  it('a failed call is captured too, and still throws and reports as before', async () => {
    capture.enabled = true
    mockFetch.mockResolvedValue(json(500, { error: 'boom' }))
    const { transport, onUnavailable } = setup()

    await expect(transport(REQ)).rejects.toThrow(/HTTP 500/)
    expect(capture.write.mock.calls[0][0]).toMatchObject({ outcome: 'error', status: 500 })
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('a missing route makes no record', async () => {
    capture.enabled = true
    mockResolve.mockResolvedValue({ ok: false, code: 'no-credential', reason: 'No key.' })
    const { transport } = setup()

    await expect(transport(REQ)).rejects.toThrow(/route unavailable/)
    expect(capture.write).not.toHaveBeenCalled()
  })
})

describe('makeSessionJudgeTransport — the ChatGPT account', () => {
  const okResponse = (): Response =>
    new Response(sseStream([chatDelta('<block>no</block>'), chatFinish('stop'), CHAT_DONE]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })

  function withAccount(account: () => string | undefined, onUnavailable = vi.fn()) {
    return makeSessionJudgeTransport({
      engine: 'pi',
      modelValue: () => 'openai-codex/gpt-6-luna',
      sessionId: () => 's1',
      routingId: 'r1',
      chatgptAccountId: account,
      onUnavailable
    })
  }

  beforeEach(() => {
    // A chat-completions route, whose reply `okResponse` plays.
    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1-mini') })
    mockFetch.mockImplementation(async () => okResponse())
  })

  it('hands the named account to the resolver on every call, read per call', async () => {
    let account: string | undefined = 'acct-biz'
    const transport = withAccount(() => account)

    await transport(REQ)
    expect(mockResolve).toHaveBeenLastCalledWith(
      'pi',
      'openai-codex/gpt-6-luna',
      {},
      { chatgptAccountId: 'acct-biz' }
    )
    account = 'acct-other'
    await transport(REQ)
    expect(mockResolve).toHaveBeenLastCalledWith(
      'pi',
      'openai-codex/gpt-6-luna',
      {},
      { chatgptAccountId: 'acct-other' }
    )
  })

  it('names no account when there is none: the resolver is asked for the active one', async () => {
    await withAccount(() => undefined)(REQ)
    expect(mockResolve).toHaveBeenLastCalledWith('pi', 'openai-codex/gpt-6-luna')
    await setup().transport(REQ)
    expect(mockResolve).toHaveBeenLastCalledWith('pi', 'chatgpt/gpt-6-luna')
  })

  it('an account the resolver refuses is reported as the route being unavailable, no request', async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      code: 'chatgpt-unavailable',
      reason: 'The fallback ChatGPT account is not signed in.'
    })
    const onUnavailable = vi.fn()
    await expect(withAccount(() => 'gone', onUnavailable)(REQ)).rejects.toThrow(
      /chatgpt-unavailable/
    )
    expect(onUnavailable).toHaveBeenCalledWith('The fallback ChatGPT account is not signed in.')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('makeSessionJudgeTransport — a rate-limited route rests', () => {
  const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)
  const RESETS_AT_S = Date.UTC(2026, 9, 28, 13, 34, 58) / 1000
  const route = routeFor('openai', 'gpt-4.1-mini')
  const usageLimit = (): Response =>
    json(429, { error: { type: 'usage_limit_reached', resets_at: RESETS_AT_S } })
  const answer = (): Response =>
    new Response(sseStream([chatDelta('<block>no</block>'), chatFinish('stop'), CHAT_DONE]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })

  beforeEach(() => {
    // Only the clock: the transport's own timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mockResolve.mockResolvedValue({ ok: true, route })
  })
  afterEach(() => vi.useRealTimers())

  it('a 429 with a reset time puts the route on cooldown until then', async () => {
    mockFetch.mockResolvedValue(usageLimit())
    const { transport } = setup()

    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    expect(coolingUntil(judgeRouteKey(route), NOW)).toBe(RESETS_AT_S * 1000)
  })

  it('the next call is answered without a request, and the reason says when the route recovers', async () => {
    mockFetch.mockResolvedValue(usageLimit())
    const { transport, onUnavailable } = setup()
    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await expect(transport(REQ)).rejects.toThrow(/route unavailable \(rate-limited\)/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(onUnavailable).toHaveBeenCalledTimes(2)
    expect(onUnavailable).toHaveBeenLastCalledWith(
      'openai · gpt-4.1-mini: usage limit, resting until 2026-10-28T13:34:58Z.'
    )
  })

  it('a second transport (another session) is held back by the same cooldown', async () => {
    mockFetch.mockResolvedValue(usageLimit())
    await expect(setup().transport(REQ)).rejects.toThrow(/HTTP 429/)

    await expect(setup().transport(REQ)).rejects.toThrow(/rate-limited/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('the route is back once the reset time has passed', async () => {
    mockFetch.mockResolvedValueOnce(usageLimit()).mockResolvedValueOnce(answer())
    const { transport } = setup()
    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    await expect(transport(REQ)).rejects.toThrow(/rate-limited/)

    vi.setSystemTime(RESETS_AT_S * 1000)
    await expect(transport(REQ)).resolves.toContain('<block>no</block>')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('another route is not held back', async () => {
    mockFetch.mockResolvedValueOnce(usageLimit()).mockResolvedValueOnce(answer())
    const { transport } = setup()
    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)

    mockResolve.mockResolvedValue({ ok: true, route: routeFor('openai', 'gpt-4.1') })
    await expect(transport(REQ)).resolves.toContain('<block>no</block>')
  })

  it('a 429 that names no reset time, and any other failure, rest nothing', async () => {
    mockFetch
      .mockResolvedValueOnce(json(429, { error: 'slow down' }))
      .mockResolvedValueOnce(json(503, { error: 'down' }))
      .mockResolvedValueOnce(answer())
    const { transport } = setup()

    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    await expect(transport(REQ)).rejects.toThrow(/HTTP 503/)
    expect(coolingUntil(judgeRouteKey(route), NOW)).toBeUndefined()
    await expect(transport(REQ)).resolves.toContain('<block>no</block>')
  })

  it('a reset time that is already past rests nothing', async () => {
    mockFetch.mockResolvedValueOnce(json(429, { error: { resets_at: (NOW - 60_000) / 1000 } }))
    const { transport } = setup()
    await expect(transport(REQ)).rejects.toThrow(/HTTP 429/)
    expect(coolingUntil(judgeRouteKey(route), NOW)).toBeUndefined()
  })

  it('a missing route does not consult the cooldown', async () => {
    mockResolve.mockResolvedValue({ ok: false, code: 'no-credential', reason: 'No key.' })
    const { transport, onUnavailable } = setup()
    await expect(transport(REQ)).rejects.toThrow(/no-credential/)
    expect(onUnavailable).toHaveBeenCalledWith('No key.')
  })
})

describe('judgeFallbackMessage', () => {
  it('says why the primary could not judge, who is judging instead, and where to change it', () => {
    expect(
      judgeFallbackMessage(
        'pi',
        'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z).',
        'OpenAI · gpt-4.1-mini'
      )
    ).toBe(
      'Auto-mode judge unavailable: ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z). ' +
        'OpenAI · gpt-4.1-mini is judging instead until it recovers. ' +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (pi).'
    )
  })

  it('names the engine the way the picker does', () => {
    expect(judgeFallbackMessage('opencode', 'No key.', 'x · y')).toMatch(
      /Auto-mode judge \(opencode\)\.$/
    )
  })
})

describe('fallbackJudgeModelFor', () => {
  it('is the configured model, trimmed', () => {
    expect(fallbackJudgeModelFor(' openai/gpt-5.5 ', 'chatgpt/gpt-6-luna')).toBe('openai/gpt-5.5')
  })

  it('is none when unset, blank, or the model already judging', () => {
    expect(fallbackJudgeModelFor(undefined, 'a/b')).toBeUndefined()
    expect(fallbackJudgeModelFor('   ', 'a/b')).toBeUndefined()
    expect(fallbackJudgeModelFor('a/b', 'a/b')).toBeUndefined()
    expect(fallbackJudgeModelFor(' a/b ', 'a/b')).toBeUndefined()
  })

  describe('the same model on another ChatGPT account', () => {
    it('is kept when the fallback account differs from the active one', () => {
      expect(fallbackJudgeModelFor('a/b', 'a/b', 'acct-biz', 'acct-plus')).toBe('a/b')
      expect(fallbackJudgeModelFor(' a/b ', ' a/b', ' acct-biz ', 'acct-plus')).toBe('a/b')
      // No active account known: an explicit account is a different route.
      expect(fallbackJudgeModelFor('a/b', 'a/b', 'acct-biz', null)).toBe('a/b')
    })

    it('is dropped when the account is the active one, blank, or unset', () => {
      expect(fallbackJudgeModelFor('a/b', 'a/b', 'acct-plus', 'acct-plus')).toBeUndefined()
      expect(fallbackJudgeModelFor('a/b', 'a/b', '  ', 'acct-plus')).toBeUndefined()
      expect(fallbackJudgeModelFor('a/b', 'a/b', undefined, 'acct-plus')).toBeUndefined()
    })

    it('reads the active account off the last refresh by default', async () => {
      await refreshChatgptAccounts(async () => ({ activeId: 'acct-plus', accounts: [] }))
      expect(fallbackJudgeModelFor('a/b', 'a/b', 'acct-plus')).toBeUndefined()
      expect(fallbackJudgeModelFor('a/b', 'a/b', 'acct-biz')).toBe('a/b')
    })

    it('does not change a different model, or an unset one', () => {
      expect(fallbackJudgeModelFor('c/d', 'a/b', 'acct-plus', 'acct-plus')).toBe('c/d')
      expect(fallbackJudgeModelFor(undefined, 'a/b', 'acct-biz', 'acct-plus')).toBeUndefined()
    })
  })
})

describe('fallbackJudgeAccountFor', () => {
  it('trims, and is none when unset or blank', () => {
    expect(fallbackJudgeAccountFor(' acct-biz ')).toBe('acct-biz')
    expect(fallbackJudgeAccountFor('')).toBeUndefined()
    expect(fallbackJudgeAccountFor('   ')).toBeUndefined()
    expect(fallbackJudgeAccountFor(undefined)).toBeUndefined()
  })
})

describe('fallbackJudgeLabel', () => {
  it('is the model as picked when no account is named', () => {
    expect(fallbackJudgeLabel('openai/gpt-6-luna', undefined)).toBe('openai/gpt-6-luna')
  })

  it("adds the named account's plan, capitalised, never an email", async () => {
    await refreshChatgptAccounts(async () => ({
      activeId: 'acct-plus',
      accounts: [
        { id: 'acct-plus', planType: 'plus' },
        { id: 'acct-biz', planType: 'business' }
      ]
    }))
    expect(fallbackJudgeLabel('openai/gpt-6-luna', 'acct-biz')).toBe(
      'openai/gpt-6-luna (Business account)'
    )
    expect(fallbackJudgeLabel('openai/gpt-6-luna', 'acct-plus')).toBe(
      'openai/gpt-6-luna (Plus account)'
    )
  })

  it('reads (ChatGPT account) for an account whose plan is not known', () => {
    expect(fallbackJudgeLabel('openai/gpt-6-luna', 'acct-unknown')).toBe(
      'openai/gpt-6-luna (ChatGPT account)'
    )
  })
})

describe('makeFallbackJudge', () => {
  it('pins the transport to the fallback model and labels it with the model as picked', () => {
    const made: Array<{ model: string; sessionId: string | null; routingId: string }> = []
    const transport = vi.fn(async () => 'ok')
    const judge = makeFallbackJudge(
      'openai/gpt-5.5',
      { engine: 'opencode', sessionId: () => 'ses-1', routingId: 'rid-1', onUnavailable: vi.fn() },
      (opts) => {
        made.push({
          model: opts.modelValue(),
          sessionId: opts.sessionId(),
          routingId: opts.routingId
        })
        return transport
      }
    )
    expect(judge).toEqual({ transport, label: 'openai/gpt-5.5' })
    expect(made).toEqual([{ model: 'openai/gpt-5.5', sessionId: 'ses-1', routingId: 'rid-1' }])
  })

  it('passes the ChatGPT account through to the transport and into the label', async () => {
    await refreshChatgptAccounts(async () => ({
      activeId: 'acct-plus',
      accounts: [{ id: 'acct-biz', planType: 'business' }]
    }))
    let seen: (() => string | undefined) | undefined
    const judge = makeFallbackJudge(
      'openai/gpt-6-luna',
      {
        engine: 'opencode',
        sessionId: () => null,
        routingId: 'rid-1',
        chatgptAccountId: () => 'acct-biz',
        onUnavailable: vi.fn()
      },
      (opts) => {
        seen = opts.chatgptAccountId
        return vi.fn(async () => 'ok')
      }
    )
    expect(seen?.()).toBe('acct-biz')
    expect(judge.label).toBe('openai/gpt-6-luna (Business account)')
  })
})

describe('the owners’ banners', () => {
  it('the primary banner is the fallback message when a fallback is in effect, else the original', () => {
    expect(judgeUnavailableMessage('pi', 'No key.', 'x · y')).toBe(
      judgeFallbackMessage('pi', 'No key.', 'x · y')
    )
    expect(judgeUnavailableMessage('pi', 'No key.', undefined)).toBe(
      judgeRouteUnavailableMessage('pi', 'No key.')
    )
  })

  it('the banners name the fallback by its label, the account plan included', () => {
    const label = 'openai/gpt-6-luna (Business account)'
    expect(judgeUnavailableMessage('opencode', 'HTTP 429.', label)).toContain(
      `HTTP 429. ${label} is judging instead until it recovers.`
    )
    expect(fallbackUnavailableMessage('opencode', label, 'No key.')).toContain(
      `fallback ${label}: No key.`
    )
    expect(staleJudgeModelMessage('opencode', 'a/gone', label)).toContain(
      `${label} is judging instead.`
    )
  })

  it('the fallback’s own banner names the fallback model in the reason', () => {
    expect(fallbackUnavailableMessage('opencode', 'x/y', 'No key.')).toBe(
      judgeRouteUnavailableMessage('opencode', 'fallback x/y: No key.')
    )
    expect(fallbackUnavailableMessage('opencode', 'x/y', 'No key.')).toContain(
      "Auto-mode can't judge here: fallback x/y: No key. Every gated action will ask you instead."
    )
  })

  it('a gone judge model says who judges instead, or that the human decides', () => {
    expect(staleJudgeModelMessage('pi', 'a/gone', undefined)).toBe(
      'Auto-mode judge model "a/gone" is no longer available — every gated action will ask you instead. ' +
        'Change it in Settings › Sessions & autonomy › Auto-mode judge (pi).'
    )
    expect(staleJudgeModelMessage('opencode', 'a/gone', 'b/fallback')).toBe(
      'Auto-mode judge model "a/gone" is no longer available — b/fallback is judging instead. ' +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    )
  })
})
