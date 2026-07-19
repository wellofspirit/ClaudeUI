/**
 * @vitest-environment node
 *
 * PiBridgeHost — real http server on an OS-assigned loopback port (no mocks:
 * this is the transport layer itself). See PiSession.test.ts for the gating
 * DECISION logic (permission-engine.ts) tested against a mocked host.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { PiBridgeHost } from '../PiBridgeHost'
import type { GateDecision, PiHostedToolPayload, PiHostedToolResult, PiToolCallPayload } from '../PiBridgeHost'

describe('PiBridgeHost', () => {
  let host: PiBridgeHost | null = null

  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('starts on 127.0.0.1 with a fresh token and round-trips an allow decision', async () => {
    host = new PiBridgeHost(async () => ({ behavior: 'allow' }))
    const { url, token } = await host.start()

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toMatch(/^[0-9a-f-]{36}$/i)

    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } })
    })

    expect(res.status).toBe(200)
    expect((await res.json()) as GateDecision).toEqual({ behavior: 'allow' })
  })

  it('round-trips a deny decision with reason, and forwards the payload the handler receives', async () => {
    let received: PiToolCallPayload | null = null
    host = new PiBridgeHost(async (payload) => {
      received = payload
      return { behavior: 'deny', reason: 'nope' }
    })
    const { url, token } = await host.start()

    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c2', toolName: 'edit', input: { path: '/a.ts' } })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ behavior: 'deny', reason: 'nope' })
    expect(received).toEqual({ toolCallId: 'c2', toolName: 'edit', input: { path: '/a.ts' } })
  })

  it('rejects a missing/wrong bearer token with 401 and never invokes the handler', async () => {
    let called = false
    host = new PiBridgeHost(async () => {
      called = true
      return { behavior: 'allow' }
    })
    const { url } = await host.start()

    const noAuth = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: {} })
    })
    expect(noAuth.status).toBe(401)

    const wrongAuth = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: {} })
    })
    expect(wrongAuth.status).toBe(401)
    expect(called).toBe(false)
  })

  it('404s any route other than POST /tool-call or POST /hosted-tool', async () => {
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )
    const { url, token } = await host.start()

    const wrongPath = await fetch(`${url}/other`, { headers: { authorization: `Bearer ${token}` } })
    expect(wrongPath.status).toBe(404)

    const wrongMethod = await fetch(`${url}/tool-call`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(wrongMethod.status).toBe(404)

    const wrongMethodHosted = await fetch(`${url}/hosted-tool`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(wrongMethodHosted.status).toBe(404)
  })

  it('fails closed (responds deny) when the handler throws — defense in depth', async () => {
    host = new PiBridgeHost(async () => {
      throw new Error('boom')
    })
    const { url, token } = await host.start()

    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: {} })
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as GateDecision
    expect(body.behavior).toBe('deny')
  })

  it('rejects a malformed JSON body with 400 without invoking the handler', async () => {
    let called = false
    host = new PiBridgeHost(async () => {
      called = true
      return { behavior: 'allow' }
    })
    const { url, token } = await host.start()

    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not json'
    })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('rejects a body over the ~2MB cap with 413 without invoking the handler', async () => {
    let called = false
    host = new PiBridgeHost(async () => {
      called = true
      return { behavior: 'allow' }
    })
    const { url, token } = await host.start()

    const bigCommand = 'x'.repeat(3 * 1024 * 1024)
    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: { command: bigCommand } })
    }).catch((err) => err as Error)

    // Node's fetch may surface the mid-stream 413 as either a resolved response
    // or a connection-reset rejection (req.destroy() after writeHead) depending
    // on how much of the body had already been flushed — both are an accepted
    // "the cap was enforced" outcome; only a clean 200 (handler ran) would fail this test.
    if (res instanceof Response) {
      expect(res.status).toBe(413)
    } else {
      expect(res).toBeInstanceOf(Error)
    }
    expect(called).toBe(false)
  })

  it('dispose() closes the server so further requests fail to connect', async () => {
    const h = new PiBridgeHost(async () => ({ behavior: 'allow' }))
    const { url, token } = await h.start()
    h.dispose()

    await expect(
      fetch(`${url}/tool-call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}'
      })
    ).rejects.toThrow()
  })

  it('dispose() is idempotent (safe to call twice)', async () => {
    host = new PiBridgeHost(async () => ({ behavior: 'allow' }))
    await host.start()
    expect(() => {
      host!.dispose()
      host!.dispose()
    }).not.toThrow()
  })
})

describe('PiBridgeHost — POST /hosted-tool (M4a+b)', () => {
  let host: PiBridgeHost | null = null

  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('round-trips a successful {content} result, and forwards the exact payload the handler receives', async () => {
    let received: PiHostedToolPayload | null = null
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async (payload) => {
        received = payload
        return { content: [{ type: 'text', text: 'Diagram rendered successfully.' }] }
      }
    )
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolName: 'render_mermaid',
        toolCallId: 'call_1',
        input: { source: 'graph TD; A-->B' }
      })
    })

    expect(res.status).toBe(200)
    expect((await res.json()) as PiHostedToolResult).toEqual({
      content: [{ type: 'text', text: 'Diagram rendered successfully.' }]
    })
    expect(received).toEqual({
      toolName: 'render_mermaid',
      toolCallId: 'call_1',
      input: { source: 'graph TD; A-->B' }
    })
  })

  it('round-trips an isError result verbatim', async () => {
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => ({ content: [{ type: 'text', text: 'Dispatch failed: boom' }], isError: true })
    )
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'dispatch_agent', toolCallId: 'call_2', input: {} })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      content: [{ type: 'text', text: 'Dispatch failed: boom' }],
      isError: true
    })
  })

  it('rejects a missing/wrong bearer token with 401 and never invokes the handler', async () => {
    let called = false
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => {
        called = true
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    )
    const { url } = await host.start()

    const noAuth = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'render_mermaid', toolCallId: 'c1', input: {} })
    })
    expect(noAuth.status).toBe(401)

    const wrongAuth = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'render_mermaid', toolCallId: 'c1', input: {} })
    })
    expect(wrongAuth.status).toBe(401)
    expect(called).toBe(false)
  })

  it('fails closed (isError:true, still HTTP 200) when the handler throws — defense in depth', async () => {
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => {
        throw new Error('boom')
      }
    )
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'render_mermaid', toolCallId: 'c1', input: {} })
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as PiHostedToolResult
    expect(body.isError).toBe(true)
  })

  it('fails closed with a 200 isError result (not a crash) when constructed WITHOUT a hostedToolHandler', async () => {
    // Back-compat: every EXISTING single-arg `new PiBridgeHost(handler)` call
    // site/test double must keep working unchanged — a stray /hosted-tool
    // request against one must never crash the process.
    host = new PiBridgeHost(async () => ({ behavior: 'allow' }))
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'render_mermaid', toolCallId: 'c1', input: {} })
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as PiHostedToolResult
    expect(body.isError).toBe(true)
  })

  it('rejects a malformed JSON body with 400 without invoking the handler', async () => {
    let called = false
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => {
        called = true
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    )
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not json'
    })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('rejects a body missing toolName/toolCallId with 400', async () => {
    host = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )
    const { url, token } = await host.start()

    const res = await fetch(`${url}/hosted-tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} })
    })
    expect(res.status).toBe(400)
  })

  it('dispose() closes the server so further /hosted-tool requests fail to connect', async () => {
    const h = new PiBridgeHost(
      async () => ({ behavior: 'allow' }),
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )
    const { url, token } = await h.start()
    h.dispose()

    await expect(
      fetch(`${url}/hosted-tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}'
      })
    ).rejects.toThrow()
  })
})
