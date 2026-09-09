/**
 * @vitest-environment node
 *
 * PiBridgeHost — real http server on an OS-assigned loopback port (no mocks:
 * this is the transport layer itself). See PiSession.test.ts for the gating
 * DECISION logic (permission-engine.ts) tested against a mocked host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// writeBridgeExtension()/writeSubagentExtension() (A2 tests below) redirect
// os.homedir() to a fresh per-test scratch dir — mirrors pi-session-list.
// test.ts's identical os.homedir() redirection technique, so no test ever
// touches the real system home dir (both writers now live under
// `~/.claude/ui/pi-ext` per the audit-residual fix, not os.tmpdir()).
const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn() }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: mockHomedir, default: { ...actual, homedir: mockHomedir } }
})
// '../services/logger' is mocked wholesale (mirrors PiSession.test.ts's
// identical treatment) — the REAL logger.ts computes `LOG_DIR = join(homedir(),
// ...)` at MODULE-TOP-LEVEL, which would otherwise run against whatever
// `mockHomedir` last returned (or hasn't returned yet) and can call
// `mkdirSync` against a bogus path; PiBridgeHost only ever calls
// logger.warn/error, never anything test-observable, so a bare no-op double
// is enough.
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { PiBridgeHost, writeBridgeExtension, writeSubagentExtension } from '../PiBridgeHost'
import type {
  GateDecision,
  PiBridgeAbandoned,
  PiHostedToolPayload,
  PiHostedToolResult,
  PiToolCallPayload
} from '../PiBridgeHost'
import { PI_BRIDGE_EXTENSION_SOURCE, PI_BRIDGE_VERSION } from '../pi-bridge-source'
import { PI_SUBAGENT_EXTENSION_SOURCE, PI_SUBAGENT_VERSION } from '../pi-subagent-source'

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

  it('rejects a WRONG token of the SAME LENGTH as the real one with 401 (exercises timingSafeEqual itself, not just the length-mismatch short-circuit)', async () => {
    host = new PiBridgeHost(async () => ({ behavior: 'allow' }))
    const { url, token } = await host.start()

    // Flip the token's first character but keep IDENTICAL length — 'Bearer
    // wrong-token' (the test above) differs in LENGTH from a real UUID
    // token too, so it never actually exercises timingSafeEqual's byte
    // comparison, only the length-mismatch fast path.
    const sameLengthWrongToken = token[0] === '0' ? '1' + token.slice(1) : '0' + token.slice(1)
    expect(sameLengthWrongToken.length).toBe(token.length)

    const res = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sameLengthWrongToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ toolCallId: 'c1', toolName: 'bash', input: {} })
    })
    expect(res.status).toBe(401)
  })

  it('404s any route other than POST /tool-call, /hosted-tool and their /wait twins', async () => {
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

  it('reassembles a multibyte UTF-8 character split MID-BYTE-SEQUENCE across two TCP-level chunks (A7)', async () => {
    let receivedInput: Record<string, unknown> | null = null
    host = new PiBridgeHost(async (payload) => {
      receivedInput = payload.input
      return { behavior: 'allow' }
    })
    const { url, token } = await host.start()

    // A CJK character ('中') is a 3-byte UTF-8 sequence (0xE4 0xB8 0xAD).
    // Splitting the raw request body's bytes ONE byte into that sequence
    // reproduces a TCP-chunk boundary landing mid-character — decoding each
    // chunk independently (the pre-fix behavior) would corrupt it to U+FFFD
    // and break JSON.parse.
    const marker = '中'
    const bodyBuf = Buffer.from(
      JSON.stringify({
        toolCallId: 'c-multibyte',
        toolName: 'bash',
        input: { command: `echo ${marker} done` }
      }),
      'utf-8'
    )
    const markerByteIdx = bodyBuf.indexOf(Buffer.from(marker, 'utf-8'))
    expect(markerByteIdx).toBeGreaterThan(-1)
    const splitAt = markerByteIdx + 1 // AFTER the marker's first byte only.
    const chunk1 = bodyBuf.subarray(0, splitAt)
    const chunk2 = bodyBuf.subarray(splitAt)

    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const parsed = new URL(url)
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: Number(parsed.port),
            path: '/tool-call',
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => (data += chunk.toString('utf-8')))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
          }
        )
        req.on('error', reject)
        // Delay between writes so the OS delivers them as SEPARATE reads
        // (synchronous back-to-back writes risk being coalesced into one).
        req.write(chunk1, () => {
          setTimeout(() => {
            req.write(chunk2)
            req.end()
          }, 20)
        })
      }
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ behavior: 'allow' })
    expect(receivedInput).toEqual({ command: `echo ${marker} done` })
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

// ---------------------------------------------------------------------------
// Long-poll protocol (2026-09-09) — every exchange is now a sequence of
// BOUNDED requests instead of one held open until the handler settles, because
// Bun's `fetch` inside pi gives up after ~300 s and failed the tool call
// closed. Real server, real sockets; hold/abandon budgets shrunk to
// milliseconds so the state machine is observable in a unit test.
// ---------------------------------------------------------------------------

interface PostResult {
  status: number
  body: Record<string, unknown> | null
}

async function post(
  url: string,
  token: string | null,
  path: string,
  body: unknown
): Promise<PostResult> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json'
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await res.text()
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Poll `/wait` the way the extension does — until the host answers with something other than `{pending:true}`. */
async function pollUntilDecided(
  url: string,
  token: string,
  route: string,
  toolCallId: string,
  maxPolls = 50
): Promise<PostResult> {
  for (let i = 0; i < maxPolls; i++) {
    const res = await post(url, token, `${route}/wait`, { toolCallId })
    if (res.status !== 200 || res.body?.pending !== true) return res
  }
  throw new Error(`still pending after ${maxPolls} polls`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('PiBridgeHost — long-poll protocol', () => {
  let host: PiBridgeHost | null = null
  let abandoned: PiBridgeAbandoned[] = []

  beforeEach(() => {
    abandoned = []
  })

  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('answers {pending:true} when the hold expires, then hands the decision to /tool-call/wait and retires the entry', async () => {
    const gate = deferred<GateDecision>()
    host = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 50,
      abandonMs: 5_000,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    const first = await post(url, token, '/tool-call', {
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' }
    })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ pending: true })

    gate.resolve({ behavior: 'allow' })

    const decided = await pollUntilDecided(url, token, '/tool-call', 'c1')
    expect(decided.status).toBe(200)
    expect(decided.body).toEqual({ behavior: 'allow' })

    // Delivered exactly once — the entry is gone, so a repeat wait 404s.
    const again = await post(url, token, '/tool-call/wait', { toolCallId: 'c1' })
    expect(again.status).toBe(404)
    expect(abandoned).toEqual([])
  })

  it('answers inline (no {pending:true}) when the handler settles inside the hold — the fast path is unchanged', async () => {
    host = new PiBridgeHost(async () => ({ behavior: 'deny', reason: 'nope' }), undefined, {
      holdMs: 5_000,
      abandonMs: 5_000,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    const res = await post(url, token, '/tool-call', {
      toolCallId: 'c-fast',
      toolName: 'bash',
      input: {}
    })
    expect(res.body).toEqual({ behavior: 'deny', reason: 'nope' })
    // Nothing is left in flight, so nothing can be abandoned.
    const wait = await post(url, token, '/tool-call/wait', { toolCallId: 'c-fast' })
    expect(wait.status).toBe(404)
  })

  it('abandons an exchange nobody re-polls after a {pending:true} — once, with settled:false', async () => {
    const gate = deferred<GateDecision>()
    host = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 30,
      abandonMs: 60,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    const first = await post(url, token, '/tool-call', {
      toolCallId: 'c-gone',
      toolName: 'write',
      input: { path: 'a.ts' }
    })
    expect(first.body).toEqual({ pending: true })

    await vi.waitFor(() => expect(abandoned).toHaveLength(1), { timeout: 2_000 })
    expect(abandoned[0]).toEqual({
      route: 'tool-call',
      toolCallId: 'c-gone',
      toolName: 'write',
      settled: false
    })

    // A late handler settlement on an abandoned entry must not resurrect it,
    // re-arm a timer, or fire onAbandoned a second time.
    gate.resolve({ behavior: 'allow' })
    await sleep(150)
    expect(abandoned).toHaveLength(1)
    expect((await post(url, token, '/tool-call/wait', { toolCallId: 'c-gone' })).status).toBe(404)
  })

  it('abandons with settled:true when a decision the handler already produced is never collected', async () => {
    const gate = deferred<GateDecision>()
    host = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 30,
      abandonMs: 200,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    expect(
      (await post(url, token, '/tool-call', { toolCallId: 'c-lost', toolName: 'bash', input: {} }))
        .body
    ).toEqual({ pending: true })

    // Settles with nobody parked → buffered, and abandonment re-armed.
    gate.resolve({ behavior: 'allow' })

    await vi.waitFor(() => expect(abandoned).toHaveLength(1), { timeout: 2_000 })
    expect(abandoned[0]).toMatchObject({ toolCallId: 'c-lost', settled: true })
  })

  it('abandons when the parked client destroys its socket mid-hold', async () => {
    const gate = deferred<GateDecision>()
    host = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 5_000,
      abandonMs: 40,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    const parsed = new URL(url)
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: '/tool-call',
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    })
    req.on('error', () => {
      // Expected — we destroy this request ourselves below.
    })
    req.end(JSON.stringify({ toolCallId: 'c-dead', toolName: 'bash', input: {} }))

    // Give the server time to receive the body and park the response, then
    // vanish the way a killed pi child does.
    await sleep(60)
    req.destroy()

    await vi.waitFor(() => expect(abandoned).toHaveLength(1), { timeout: 2_000 })
    expect(abandoned[0]).toMatchObject({ route: 'tool-call', toolCallId: 'c-dead' })
    gate.resolve({ behavior: 'allow' })
  })

  it('a client that keeps re-polling is never abandoned, and collects the decision on the poll parked when the handler settles', async () => {
    const gate = deferred<GateDecision>()
    host = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 25,
      abandonMs: 1_000,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    expect(
      (await post(url, token, '/tool-call', { toolCallId: 'c-poll', toolName: 'bash', input: {} }))
        .body
    ).toEqual({ pending: true })

    // Settle after a few hold windows have already elapsed.
    setTimeout(() => gate.resolve({ behavior: 'allow', updatedInput: { command: 'ls -la' } }), 90)

    const decided = await pollUntilDecided(url, token, '/tool-call', 'c-poll')
    expect(decided.body).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
    expect(abandoned).toEqual([])
  })

  it('a repeated INITIAL post for a live exchange parks like a wait instead of running the handler again', async () => {
    const gate = deferred<GateDecision>()
    let handlerCalls = 0
    host = new PiBridgeHost(
      () => {
        handlerCalls++
        return gate.promise
      },
      undefined,
      { holdMs: 25, abandonMs: 1_000, onAbandoned: (i) => abandoned.push(i) }
    )
    const { url, token } = await host.start()

    const body = { toolCallId: 'c-idem', toolName: 'bash', input: {} }
    expect((await post(url, token, '/tool-call', body)).body).toEqual({ pending: true })
    expect((await post(url, token, '/tool-call', body)).body).toEqual({ pending: true })
    expect(handlerCalls).toBe(1)

    gate.resolve({ behavior: 'allow' })
    expect((await pollUntilDecided(url, token, '/tool-call', 'c-idem')).body).toEqual({
      behavior: 'allow'
    })
    expect(handlerCalls).toBe(1)
  })

  it('/wait 404s an unknown toolCallId, 400s a malformed body, and 401s without the bearer token', async () => {
    host = new PiBridgeHost(async () => ({ behavior: 'allow' }), undefined, {
      holdMs: 25,
      abandonMs: 1_000,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await host.start()

    expect((await post(url, token, '/tool-call/wait', { toolCallId: 'nope' })).status).toBe(404)
    expect((await post(url, token, '/tool-call/wait', 'not json')).status).toBe(400)
    expect((await post(url, token, '/tool-call/wait', { toolCallId: 7 })).status).toBe(400)
    expect((await post(url, null, '/tool-call/wait', { toolCallId: 'nope' })).status).toBe(401)
    expect((await post(url, token, '/hosted-tool/wait', { toolCallId: 'nope' })).status).toBe(404)
    expect((await post(url, null, '/hosted-tool/wait', { toolCallId: 'nope' })).status).toBe(401)
  })

  it('/hosted-tool long-polls too, and the two routes never share an entry even for the SAME toolCallId', async () => {
    const gate = deferred<GateDecision>()
    const hosted = deferred<PiHostedToolResult>()
    host = new PiBridgeHost(
      () => gate.promise,
      () => hosted.promise,
      { holdMs: 30, abandonMs: 2_000, onAbandoned: (i) => abandoned.push(i) }
    )
    const { url, token } = await host.start()

    // The SAME toolCallId is legitimately in flight on both routes: pi gates a
    // hosted tool through /tool-call and then executes it via /hosted-tool.
    expect(
      (
        await post(url, token, '/tool-call', {
          toolCallId: 'shared',
          toolName: 'dispatch_agent',
          input: {}
        })
      ).body
    ).toEqual({ pending: true })
    expect(
      (
        await post(url, token, '/hosted-tool', {
          toolName: 'dispatch_agent',
          toolCallId: 'shared',
          input: {}
        })
      ).body
    ).toEqual({ pending: true })

    gate.resolve({ behavior: 'allow' })
    hosted.resolve({ content: [{ type: 'text', text: 'child answered' }] })

    expect((await pollUntilDecided(url, token, '/tool-call', 'shared')).body).toEqual({
      behavior: 'allow'
    })
    expect((await pollUntilDecided(url, token, '/hosted-tool', 'shared')).body).toEqual({
      content: [{ type: 'text', text: 'child answered' }]
    })
    expect(abandoned).toEqual([])
  })

  // NOTE: this pins the observable INVARIANT (nothing abandons after
  // teardown), not the mechanism. `remove()`'s identity guard alone is enough
  // to make it hold, so the test still passes if dispose()'s timer-clearing
  // loop is deleted — that loop is hygiene (no orphaned timers/entries
  // outliving the host), and it is not separately observable from out here.
  it('no abandonment fires after dispose(), with both an armed abandon timer and a still-parked response', async () => {
    const gate = deferred<GateDecision>()
    const h = new PiBridgeHost(() => gate.promise, undefined, {
      holdMs: 200,
      abandonMs: 100,
      onAbandoned: (i) => abandoned.push(i)
    })
    const { url, token } = await h.start()

    // Exchange A: awaited to completion, so its hold has definitely expired
    // and its ABANDON timer is armed (it would fire ~100 ms from now).
    expect(
      (
        await post(url, token, '/tool-call', {
          toolCallId: 'c-abandoning',
          toolName: 'bash',
          input: {}
        })
      ).body
    ).toEqual({ pending: true })

    // Exchange B: still PARKED — issued a moment ago, and its 200 ms hold has
    // not expired. So dispose() below has to clear both timer kinds at once,
    // and must not let B's socket destruction arm a fresh abandon.
    const parked = post(url, token, '/tool-call', {
      toolCallId: 'c-parked',
      toolName: 'write',
      input: {}
    }).catch(() => null)
    await sleep(20)

    h.dispose()
    await parked

    // Well past both A's abandon (~100 ms) and B's hold (~180 ms).
    await sleep(500)
    expect(abandoned).toEqual([])
  })
})

describe('writeBridgeExtension (A2 — content-verify against tampering/preplanting; audit-residual A — per-user base dir)', () => {
  let scratchRoot: string

  beforeEach(async () => {
    // vi.importActual bypasses the 'node:os' mock above (which redirects
    // `homedir` for the PRODUCT code under test) to get the GENUINE tmpdir,
    // purely so this test's own scratch dir doesn't depend on itself.
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    scratchRoot = mkdtempSync(join(realOs.tmpdir(), 'pi-bridge-host-test-'))
    mockHomedir.mockReturnValue(scratchRoot)
  })

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  function extensionFilePath(): string {
    return join(
      scratchRoot,
      '.claude',
      'ui',
      'pi-ext',
      'claudeui-pi-bridge',
      PI_BRIDGE_VERSION,
      'claudeui-bridge.ts'
    )
  }

  it('writes the file under ~/.claude/ui/pi-ext (per-user, NOT os.tmpdir()) when absent', () => {
    const file = writeBridgeExtension()

    expect(file).toBe(extensionFilePath())
    expect(readFileSync(file, 'utf-8')).toBe(PI_BRIDGE_EXTENSION_SOURCE)
  })

  it('rewrites when the on-disk content differs from PI_BRIDGE_EXTENSION_SOURCE (tampered/hand-edited)', () => {
    const file = writeBridgeExtension()
    writeFileSync(file, '// TAMPERED — hand-edited content', 'utf-8')

    const secondPath = writeBridgeExtension()

    expect(secondPath).toBe(file)
    expect(readFileSync(file, 'utf-8')).toBe(PI_BRIDGE_EXTENSION_SOURCE)
  })

  it('leaves the file COMPLETELY untouched (no rewrite) when content already matches', () => {
    const file = writeBridgeExtension()
    // Set a deliberately ancient mtime — a real rewrite would bump it to
    // "now" (2020 vs. today is unmistakable, unlike a same-millisecond
    // false-negative risk from comparing against "before this test ran").
    const oldTime = new Date('2020-01-01T00:00:00.000Z')
    utimesSync(file, oldTime, oldTime)

    writeBridgeExtension() // second call — content is already identical.

    expect(statSync(file).mtime.getTime()).toBe(oldTime.getTime())
  })
})

describe('writeSubagentExtension (M5b; audit-residual A — per-user base dir, SAME posture as writeBridgeExtension)', () => {
  let scratchRoot: string

  beforeEach(async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    scratchRoot = mkdtempSync(join(realOs.tmpdir(), 'pi-subagent-host-test-'))
    mockHomedir.mockReturnValue(scratchRoot)
  })

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  function extensionFilePath(): string {
    return join(
      scratchRoot,
      '.claude',
      'ui',
      'pi-ext',
      'claudeui-pi-subagent',
      PI_SUBAGENT_VERSION,
      'claudeui-subagent.ts'
    )
  }

  it('writes the file under ~/.claude/ui/pi-ext (per-user, NOT os.tmpdir()) when absent — a SEPARATE dir from writeBridgeExtension', () => {
    const file = writeSubagentExtension()

    expect(file).toBe(extensionFilePath())
    expect(readFileSync(file, 'utf-8')).toBe(PI_SUBAGENT_EXTENSION_SOURCE)
  })

  it('rewrites when the on-disk content differs from PI_SUBAGENT_EXTENSION_SOURCE (tampered/hand-edited)', () => {
    const file = writeSubagentExtension()
    writeFileSync(file, '// TAMPERED — hand-edited content', 'utf-8')

    const secondPath = writeSubagentExtension()

    expect(secondPath).toBe(file)
    expect(readFileSync(file, 'utf-8')).toBe(PI_SUBAGENT_EXTENSION_SOURCE)
  })

  it('leaves the file COMPLETELY untouched (no rewrite) when content already matches', () => {
    const file = writeSubagentExtension()
    const oldTime = new Date('2020-01-01T00:00:00.000Z')
    utimesSync(file, oldTime, oldTime)

    writeSubagentExtension() // second call — content is already identical.

    expect(statSync(file).mtime.getTime()).toBe(oldTime.getTime())
  })
})
