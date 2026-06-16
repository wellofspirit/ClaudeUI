/**
 * Unit tests for CodexAppServerClient.
 *
 * Mock peer design: two PassThrough streams act as the "server" side.
 *   clientStdin  — what the client writes to (we read this to see what the client sent)
 *   clientStdout — what we write to (the client reads this as incoming server frames)
 *
 *         client                        mock peer
 *   ┌───────────────┐               ┌──────────────────┐
 *   │ CodexApp-     │──clientStdin──▶│ collects frames  │
 *   │ ServerClient  │◀─clientStdout─│ injects frames   │
 *   └───────────────┘               └──────────────────┘
 *
 * The mock peer helper pushes raw NDJSON lines into clientStdout and
 * collects lines from clientStdin, all synchronously in tests (with
 * vi.waitFor for async resolution).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  CodexAppServerClient,
  CodexAppServerError,
  type RequestOptions
} from '../CodexAppServerClient'

// ---------------------------------------------------------------------------
// Mock peer helpers
// ---------------------------------------------------------------------------

function makePeer(): {
  client: CodexAppServerClient
  /** Frames the client has written to its stdin side. */
  sentFrames: Record<string, unknown>[]
  /** Push a raw NDJSON line into the client's stdout. */
  injectLine: (obj: Record<string, unknown>) => void
  /** Push a raw string directly (for malformed-line tests). */
  injectRaw: (s: string) => void
  /** Push a server notification frame. */
  sendNotification: (method: string, params?: unknown) => void
  /** Push a server request frame (returns the id we used). */
  sendServerRequest: (method: string, params?: unknown) => number
  /** Push a success response to a client request with the given id. */
  sendResponse: (id: number, result: unknown) => void
  /** Push an error response to a client request with the given id. */
  sendError: (id: number, code: number, message: string, data?: unknown) => void
  dispose: () => void
} {
  const clientStdin = new PassThrough() // client writes here
  const clientStdout = new PassThrough() // client reads here

  const sentFrames: Record<string, unknown>[] = []
  let serverReqCounter = 10_000

  // Collect what the client sends
  let remainder = ''
  clientStdin.setEncoding('utf8')
  clientStdin.on('data', (chunk: string) => {
    remainder += chunk
    const parts = remainder.split('\n')
    remainder = parts.pop() ?? ''
    for (const line of parts) {
      const t = line.trim()
      if (t) sentFrames.push(JSON.parse(t) as Record<string, unknown>)
    }
  })

  const injectLine = (obj: Record<string, unknown>): void => {
    clientStdout.write(JSON.stringify(obj) + '\n')
  }

  const injectRaw = (s: string): void => {
    clientStdout.write(s + '\n')
  }

  const sendNotification = (method: string, params?: unknown): void => {
    injectLine(params !== undefined ? { method, params } : { method })
  }

  const sendServerRequest = (method: string, params?: unknown): number => {
    const id = serverReqCounter++
    injectLine(params !== undefined ? { id, method, params } : { id, method })
    return id
  }

  const sendResponse = (id: number, result: unknown): void => {
    injectLine({ id, result })
  }

  const sendError = (id: number, code: number, message: string, data?: unknown): void => {
    injectLine(data !== undefined ? { id, error: { code, message, data } } : { id, error: { code, message } })
  }

  const client = new CodexAppServerClient(clientStdin, clientStdout)

  return {
    client,
    sentFrames,
    injectLine,
    injectRaw,
    sendNotification,
    sendServerRequest,
    sendResponse,
    sendError,
    dispose: () => {
      client.dispose()
      clientStdin.destroy()
      clientStdout.destroy()
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAppServerClient — request/response correlation', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })
  afterEach(() => peer.dispose())

  it('resolves with the typed result when the server responds', async () => {
    const p = peer.client.request('account/read', {})
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    const frame = peer.sentFrames[0]
    expect(frame.method).toBe('account/read')
    expect(typeof frame.id).toBe('number')

    peer.sendResponse(frame.id as number, { account: null, requiresOpenaiAuth: false })
    const result = await p
    expect(result.requiresOpenaiAuth).toBe(false)
  })

  it('assigns monotonically increasing integer ids', async () => {
    const p1 = peer.client.request('account/read', {})
    const p2 = peer.client.request('model/list', {})
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(2))
    const [f1, f2] = peer.sentFrames
    expect(typeof f1.id).toBe('number')
    expect(typeof f2.id).toBe('number')
    expect((f2.id as number)).toBeGreaterThan((f1.id as number))

    peer.sendResponse(f1.id as number, { account: null, requiresOpenaiAuth: false })
    peer.sendResponse(f2.id as number, { data: [] })
    await p1
    await p2
  })

  it('rejects with CodexAppServerError on an error response', async () => {
    const p = peer.client.request('account/read', {})
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    peer.sendError(peer.sentFrames[0].id as number, -32600, 'invalid request', { detail: 'x' })

    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodexAppServerError)
    const casted = err as CodexAppServerError
    expect(casted.code).toBe(-32600)
    expect(casted.message).toBe('invalid request')
    expect(casted.data).toEqual({ detail: 'x' })
  })

  it('handles out-of-order responses correctly (correlates by id)', async () => {
    const p1 = peer.client.request('account/read', {})
    const p2 = peer.client.request('model/list', {})
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(2))
    const [f1, f2] = peer.sentFrames

    // Respond in reverse order
    peer.sendResponse(f2.id as number, { data: [] })
    peer.sendResponse(f1.id as number, { account: null, requiresOpenaiAuth: true })

    const r1 = await p1
    const r2 = await p2
    expect(r1.requiresOpenaiAuth).toBe(true)
    expect(r2.data).toEqual([])
  })

  it('omits params field when params is null/undefined', async () => {
    // account/logout has null params in the schema
    const p = peer.client.request('account/logout', null as never)
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    expect('params' in peer.sentFrames[0]).toBe(false)
    peer.sendResponse(peer.sentFrames[0].id as number, {})
    await p
  })
})

describe('CodexAppServerClient — request timeout', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    vi.useFakeTimers()
    peer = makePeer()
  })
  afterEach(() => {
    peer.dispose()
    vi.useRealTimers()
  })

  it('rejects with transport error when timeout expires', async () => {
    const opts: RequestOptions = { timeoutMs: 100 }
    const p = peer.client.request('account/read', {}, opts)
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(150)
    const err = await caught
    expect(err).toBeInstanceOf(CodexAppServerError)
    expect((err as CodexAppServerError).message).toMatch(/timed out after 100ms/)
  })

  it('does not timeout when timeoutMs: 0 is passed', async () => {
    const onReject = vi.fn()
    const p = peer.client.request('account/read', {}, { timeoutMs: 0 })
    p.catch(onReject)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onReject).not.toHaveBeenCalled()

    // Still resolves when the server eventually responds
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    peer.sendResponse(peer.sentFrames[0].id as number, { account: null, requiresOpenaiAuth: false })
    await expect(p).resolves.toBeDefined()
  })

  it('late response after timeout is silently discarded (no double-reject)', async () => {
    const p = peer.client.request('account/read', {}, { timeoutMs: 100 })
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(150)
    await caught

    // Responding after timeout should not throw or cause unhandled rejection
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    expect(() => peer.sendResponse(peer.sentFrames[0].id as number, {})).not.toThrow()
  })

  it('defaultTimeoutMs from constructor options applies when no per-request override', async () => {
    const stdin2 = new PassThrough()
    const stdout2 = new PassThrough()
    const shortClient = new CodexAppServerClient(stdin2, stdout2, { defaultTimeoutMs: 50 })
    const p = shortClient.request('account/read', {})
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(100)
    const err = await caught
    expect((err as CodexAppServerError).message).toMatch(/timed out after 50ms/)
    shortClient.dispose()
    stdin2.destroy()
    stdout2.destroy()
  })
})

describe('CodexAppServerClient — server notifications', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })
  afterEach(() => peer.dispose())

  it('dispatches typed notification to the registered handler', async () => {
    const received: unknown[] = []
    peer.client.handleServerNotification('item/agentMessage/delta', (params) => {
      received.push(params)
    })
    peer.sendNotification('item/agentMessage/delta', {
      delta: 'hello', itemId: 'i1', threadId: 't1', turnId: 'u1'
    })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect((received[0] as { delta: string }).delta).toBe('hello')
  })

  it('dispatches to multiple handlers registered for the same method', async () => {
    const calls: string[] = []
    peer.client.handleServerNotification('item/agentMessage/delta', () => calls.push('a'))
    peer.client.handleServerNotification('item/agentMessage/delta', () => calls.push('b'))
    peer.sendNotification('item/agentMessage/delta', {
      delta: 'x', itemId: 'i1', threadId: 't1', turnId: 'u1'
    })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual(['a', 'b'])
  })

  it('calls the unknown-notification fallback for unregistered methods', async () => {
    const received: [string, unknown][] = []
    peer.client.handleUnknownServerNotification((method, params) => {
      received.push([method, params])
    })
    peer.sendNotification('some/custom/notification', { foo: 'bar' })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0][0]).toBe('some/custom/notification')
    expect((received[0][1] as { foo: string }).foo).toBe('bar')
  })

  it('does not invoke the unknown fallback when a typed handler is registered', async () => {
    const unknownCalled = vi.fn()
    peer.client.handleUnknownServerNotification(unknownCalled)
    const typedCalled = vi.fn()
    peer.client.handleServerNotification('item/agentMessage/delta', typedCalled)
    peer.sendNotification('item/agentMessage/delta', {
      delta: 'x', itemId: 'i1', threadId: 't1', turnId: 'u1'
    })
    await vi.waitFor(() => expect(typedCalled).toHaveBeenCalledOnce())
    expect(unknownCalled).not.toHaveBeenCalled()
  })

  it('silently drops unknown notifications when no fallback is registered', () => {
    // No handlers, no fallback. Should not throw.
    expect(() =>
      peer.sendNotification('totally/unknown/method', { data: 1 })
    ).not.toThrow()
  })
})

describe('CodexAppServerClient — server requests', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })
  afterEach(() => peer.dispose())

  it('typed handler is called and its result is written back as {id, result}', async () => {
    peer.client.handleServerRequest(
      'item/commandExecution/requestApproval',
      async (_params) => ({ decision: 'accept' as const })
    )
    const serverReqId = peer.sendServerRequest('item/commandExecution/requestApproval', {
      itemId: 'item-1', threadId: 't1', turnId: 'u1', startedAtMs: 0
    })
    await vi.waitFor(() => {
      return peer.sentFrames.some(f => f.id === serverReqId)
    })
    const response = peer.sentFrames.find(f => f.id === serverReqId)!
    expect(response.id).toBe(serverReqId)
    expect((response.result as { decision: string }).decision).toBe('accept')
    expect(response.error).toBeUndefined()
  })

  it('writes {id, error} when the handler throws', async () => {
    peer.client.handleServerRequest(
      'item/commandExecution/requestApproval',
      async () => { throw new Error('rejected by user') }
    )
    const serverReqId = peer.sendServerRequest('item/commandExecution/requestApproval', {
      itemId: 'item-1', threadId: 't1', turnId: 'u1', startedAtMs: 0
    })
    await vi.waitFor(() =>
      peer.sentFrames.some(f => f.id === serverReqId && f.error !== undefined)
    )
    const response = peer.sentFrames.find(f => f.id === serverReqId && f.error !== undefined)!
    expect((response.error as { message: string }).message).toBe('rejected by user')
    expect((response.error as { code: number }).code).toBe(-32603)
  })

  it('handler throwing CodexAppServerError preserves the error code', async () => {
    peer.client.handleServerRequest(
      'item/commandExecution/requestApproval',
      async () => { throw new CodexAppServerError('custom error', -32001) }
    )
    const serverReqId = peer.sendServerRequest('item/commandExecution/requestApproval', {
      itemId: 'item-1', threadId: 't1', turnId: 'u1', startedAtMs: 0
    })
    await vi.waitFor(() =>
      peer.sentFrames.some(f => f.id === serverReqId && f.error !== undefined)
    )
    const response = peer.sentFrames.find(f => f.id === serverReqId && f.error !== undefined)!
    expect((response.error as { code: number }).code).toBe(-32001)
  })

  it('unknown server request → method-not-found reply when no fallback', async () => {
    const unknownReqId = peer.sendServerRequest('exotic/method', { x: 1 })
    await vi.waitFor(() =>
      peer.sentFrames.some(f => f.id === unknownReqId && f.error !== undefined)
    )
    const response = peer.sentFrames.find(f => f.id === unknownReqId && f.error !== undefined)!
    expect((response.error as { code: number }).code).toBe(-32601)
    expect((response.error as { message: string }).message).toMatch(/Method not found/)
  })

  it('unknown server request is routed to the fallback handler when registered', async () => {
    peer.client.handleUnknownServerRequest(async (method, _params) => {
      return { handled: method }
    })
    const unknownReqId = peer.sendServerRequest('exotic/method', { x: 1 })
    await vi.waitFor(() =>
      peer.sentFrames.some(f => f.id === unknownReqId && f.result !== undefined)
    )
    const response = peer.sentFrames.find(f => f.id === unknownReqId && f.result !== undefined)!
    expect((response.result as { handled: string }).handled).toBe('exotic/method')
  })
})

describe('CodexAppServerClient — notify (client→server)', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })
  afterEach(() => peer.dispose())

  it('sends a notification frame with no id', async () => {
    peer.client.notify('initialized', undefined)
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    const frame = peer.sentFrames[0]
    expect(frame.method).toBe('initialized')
    expect(frame.id).toBeUndefined()
  })
})

describe('CodexAppServerClient — malformed input tolerance', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })
  afterEach(() => peer.dispose())

  it('survives a non-JSON line and continues processing subsequent valid frames', async () => {
    const received: unknown[] = []
    peer.client.handleServerNotification('item/agentMessage/delta', (p) => received.push(p))

    // Inject a malformed line then a valid one
    peer.injectRaw('NOT VALID JSON {{{')
    peer.sendNotification('item/agentMessage/delta', {
      delta: 'after malformed', itemId: 'i', threadId: 't', turnId: 'u'
    })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect((received[0] as { delta: string }).delta).toBe('after malformed')
  })

  it('does not crash on empty lines', () => {
    expect(() => peer.injectRaw('')).not.toThrow()
    expect(() => peer.injectRaw('   ')).not.toThrow()
  })

  it('handles frames with no recognisable shape gracefully', async () => {
    // A JSON object that has neither method nor id — should be silently discarded
    peer.injectLine({ foo: 'bar' })
    // A subsequent valid request should still work
    const p = peer.client.request('account/read', {})
    await vi.waitFor(() => expect(peer.sentFrames).toHaveLength(1))
    peer.sendResponse(peer.sentFrames[0].id as number, { account: null, requiresOpenaiAuth: false })
    await expect(p).resolves.toBeDefined()
  })
})

describe('CodexAppServerClient — close / dispose', () => {
  let peer: ReturnType<typeof makePeer>

  beforeEach(() => {
    peer = makePeer()
    vi.useRealTimers()
  })

  afterEach(() => {
    // peer may already be disposed by the test
    try { peer.dispose() } catch { /* ignore */ }
  })

  it('close() rejects all pending requests', async () => {
    const p1 = peer.client.request('account/read', {})
    const p2 = peer.client.request('model/list', {})
    const caught1 = p1.catch((e) => e)
    const caught2 = p2.catch((e) => e)

    peer.client.close()
    const [e1, e2] = await Promise.all([caught1, caught2])
    expect(e1).toBeInstanceOf(CodexAppServerError)
    expect(e2).toBeInstanceOf(CodexAppServerError)
    expect((e1 as CodexAppServerError).message).toMatch(/closed/i)
  })

  it('close() is idempotent', () => {
    peer.client.close()
    expect(() => peer.client.close()).not.toThrow()
  })

  it('dispose() is an alias for close()', async () => {
    const p = peer.client.request('account/read', {})
    const caught = p.catch((e) => e)
    peer.client.dispose()
    const err = await caught
    expect(err).toBeInstanceOf(CodexAppServerError)
  })

  it('request() on a closed client rejects immediately without writing a frame', async () => {
    peer.client.close()
    const err = await peer.client.request('account/read', {}).catch((e) => e)
    expect(err).toBeInstanceOf(CodexAppServerError)
    expect((err as CodexAppServerError).message).toMatch(/closed/i)
    expect(peer.sentFrames).toHaveLength(0)
  })

  it('notify() on a closed client is a no-op', () => {
    peer.client.close()
    expect(() => peer.client.notify('initialized', undefined)).not.toThrow()
  })
})
