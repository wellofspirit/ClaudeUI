import { describe, it, expect, vi } from 'vitest'
import {
  JUDGE_COMPLETION_PATH,
  JudgeEndpointUnavailableError,
  makeDirectJudgeTransport,
  makeJudgeTransportWithFallback,
  probeJudgeEndpoint
} from '../judge-transport'
import type { JudgeEndpointProbe } from '../judge-transport'

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

const TARGET = { baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic dGVzdDp0ZXN0' }
const MODEL = { providerID: 'anthropic', modelID: 'claude-x' }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function html(status: number, body = '<!doctype html><html></html>'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } })
}

/** An OpenAPI doc that does/doesn't list the judge route. */
function doc(withJudge: boolean): Response {
  return json(200, {
    openapi: '3.1.0',
    paths: {
      '/session': {},
      ...(withJudge ? { [JUDGE_COMPLETION_PATH]: { post: {} } } : {})
    }
  })
}

describe('makeDirectJudgeTransport', () => {
  it('POSTs the judge payload with auth and returns the text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { text: '<block>no</block>' }))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)

    const out = await transport({
      system: 'POLICY',
      user: 'ACTION',
      maxTokens: 64,
      stopSequences: ['</block>']
    })

    expect(out).toBe('<block>no</block>')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${TARGET.baseUrl}${JUDGE_COMPLETION_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(TARGET.authHeader)
    // maxTokens/stopSequences must go over the wire — the whole reason this
    // transport exists (ADR-023 advisory-fields deviation).
    expect(JSON.parse(init.body)).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
      system: 'POLICY',
      user: 'ACTION',
      maxTokens: 64,
      stopSequences: ['</block>']
    })
  })

  it('omits maxTokens/stopSequences when the classifier did not set them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { text: 'ok' }))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    await transport({ system: 's', user: 'u' })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
      system: 's',
      user: 'u'
    })
  })

  it('treats a 200 text/html answer (unpatched web-UI catch-all) as endpoint-missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(200))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    await expect(transport({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
      JudgeEndpointUnavailableError
    )
  })

  it('treats a non-JSON 404 as endpoint-missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(404, 'Not Found'))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    await expect(transport({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
      JudgeEndpointUnavailableError
    )
  })

  it('treats the patched route’s own ModelNotFoundError 404 as a real failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json(404, { _tag: 'ModelNotFoundError', providerID: 'x', modelID: 'y' }))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    const err = await transport({ system: 's', user: 'u' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(JudgeEndpointUnavailableError)
  })

  it('throws on a 5xx so classify() fails closed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(502, { message: 'upstream boom' }))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    const err = await transport({ system: 's', user: 'u' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(JudgeEndpointUnavailableError)
    expect(String(err)).toContain('502')
  })

  it('throws when the JSON body has no text field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { nope: 1 }))
    const transport = makeDirectJudgeTransport(TARGET, MODEL, fetchImpl as unknown as typeof fetch)
    await expect(transport({ system: 's', user: 'u' })).rejects.toThrow(/no text field/)
  })
})

describe('probeJudgeEndpoint', () => {
  it('is true when /doc lists the route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(doc(true))
    await expect(probeJudgeEndpoint(TARGET, fetchImpl as unknown as typeof fetch)).resolves.toBe(
      true
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(`${TARGET.baseUrl}/doc`)
  })

  it('is false when /doc does not list the route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(doc(false))
    await expect(probeJudgeEndpoint(TARGET, fetchImpl as unknown as typeof fetch)).resolves.toBe(
      false
    )
  })

  it('throws when /doc itself fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(500, 'boom'))
    await expect(probeJudgeEndpoint(TARGET, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /500/
    )
  })
})

describe('makeJudgeTransportWithFallback', () => {
  function build(fetchImpl: unknown, probe: JudgeEndpointProbe = {}) {
    const fallback = vi.fn().mockResolvedValue('FROM-SESSION')
    const transport = makeJudgeTransportWithFallback({
      target: TARGET,
      model: MODEL,
      fallback,
      probe,
      fetchImpl: fetchImpl as typeof fetch
    })
    return { transport, fallback, probe }
  }

  it('probes once and then uses the direct endpoint for every later call', async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(doc(true))
      .mockImplementation(async () => json(200, { text: 'DIRECT' }))
    const { transport, fallback, probe } = build(fetchImpl)

    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('DIRECT')
    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('DIRECT')

    expect(fallback).not.toHaveBeenCalled()
    expect(probe.available).toBe(true)
    // 1 probe + 2 completions — the probe is NOT repeated.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/doc'))).toHaveLength(1)
  })

  it('engages the fallback once the probe says the route is absent, and never re-probes', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => doc(false))
    const { transport, fallback, probe } = build(fetchImpl)

    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('FROM-SESSION')
    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('FROM-SESSION')

    expect(fallback).toHaveBeenCalledTimes(2)
    expect(probe.available).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never sends the prompt to a server that lacks the route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(doc(false))
    const { transport } = build(fetchImpl)
    await transport({ system: 'SECRET-TRANSCRIPT', user: 'SECRET-ACTION' })
    // Only /doc was contacted — no POST carrying the transcript.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/doc')
  })

  it('caches the fallback after a direct call turns out to hit a missing route', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(doc(true))
      .mockResolvedValueOnce(html(200))
      .mockImplementation(async () => json(200, { text: 'SHOULD-NOT-BE-REACHED' }))
    const { transport, fallback, probe } = build(fetchImpl)

    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('FROM-SESSION')
    expect(probe.available).toBe(false)

    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('FROM-SESSION')
    expect(fallback).toHaveBeenCalledTimes(2)
    // probe + one failed direct attempt; the second call went straight to the
    // fallback without another HTTP round-trip.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates a real endpoint error so classify() fails closed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(doc(true))
      .mockImplementation(async () => json(502, { message: 'provider down' }))
    const { transport, fallback, probe } = build(fetchImpl)

    await expect(transport({ system: 's', user: 'u' })).rejects.toThrow(/502/)
    expect(fallback).not.toHaveBeenCalled()
    // A provider outage must not be mistaken for version skew.
    expect(probe.available).toBe(true)
  })

  it('uses the fallback for this call but does not cache when the probe itself fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(doc(true))
      .mockImplementation(async () => json(200, { text: 'DIRECT' }))
    const { transport, fallback, probe } = build(fetchImpl)

    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('FROM-SESSION')
    expect(probe.available).toBeUndefined()

    // Next call re-probes and recovers.
    await expect(transport({ system: 's', user: 'u' })).resolves.toBe('DIRECT')
    expect(probe.available).toBe(true)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
