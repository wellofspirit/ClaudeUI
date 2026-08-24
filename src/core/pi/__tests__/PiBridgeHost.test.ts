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
