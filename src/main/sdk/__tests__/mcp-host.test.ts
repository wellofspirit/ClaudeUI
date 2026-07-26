import { describe, it, expect, vi } from 'vitest'
import { McpHost } from '../mcp-host'
import type { SdkMcpServer } from '../types'

/**
 * Fake McpServer whose connect() takes a controllable amount of time. We
 * use it to exercise the race that used to exist when `started = true` was
 * set before Promise.all(connects) resolved — a second concurrent dispatch
 * would slip past the guard before the transport's onmessage was wired.
 */
function makeFakeServer(
  name: string,
  onConnectDelayMs: number
): {
  server: SdkMcpServer
  onMessageCount: () => number
} {
  let connected = false
  let onMessageCount = 0

  const instance = {
    connect: vi.fn(
      async (transport: { onmessage?: (m: unknown) => void; start?: () => Promise<void> }) => {
        await new Promise((r) => setTimeout(r, onConnectDelayMs))
        connected = true
        transport.onmessage = () => {
          onMessageCount++
        }
        await transport.start?.()
      }
    )
  } as unknown as SdkMcpServer['instance']

  return {
    server: {
      type: 'sdk',
      name,
      tools: [],
      instance
    },
    onMessageCount: () => {
      if (!connected) throw new Error(`server ${name} not connected yet`)
      return onMessageCount
    }
  }
}

describe('McpHost.ensureStarted', () => {
  it('concurrent dispatches share a single connect Promise (no race)', async () => {
    const a = makeFakeServer('srv-a', 30)
    const b = makeFakeServer('srv-b', 30)
    const host = new McpHost({ 'srv-a': a.server, 'srv-b': b.server })

    // Both dispatches start before connect() resolves. Previously the
    // second one would race past the boolean `started=true` flag and hit
    // transport.inject() before transport.onmessage was wired.
    const p1 = host.dispatch('srv-a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    })
    const p2 = host.dispatch('srv-a', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    })

    // Neither should have resolved yet — they're waiting for a server
    // response that our fake never sends. Timing is enough to prove the
    // race fix: both must have observed `onmessage` wiring before they
    // returned from inject(). Race with null response is enough signal.
    let settled = 0
    void p1.finally(() => settled++)
    void p2.finally(() => settled++)
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(0)

    // Verify the underlying McpServer.connect was called exactly once per
    // server: a second ensureStarted during the race would re-trigger it.
    await new Promise((r) => setTimeout(r, 60))
    const aConnect = a.server.instance as unknown as { connect: ReturnType<typeof vi.fn> }
    const bConnect = b.server.instance as unknown as { connect: ReturnType<typeof vi.fn> }
    expect(aConnect.connect).toHaveBeenCalledTimes(1)
    expect(bConnect.connect).toHaveBeenCalledTimes(1)
  })

  it('propagates abort: cancels the running handler and settles the dispatch (xhigh#10)', async () => {
    const received: Array<Record<string, unknown>> = []
    // A server whose handler never responds (simulates a long-running tool like
    // dispatch_agent). We capture every message injected into the transport.
    const instance = {
      connect: vi.fn(
        async (transport: { onmessage?: (m: unknown) => void; start?: () => Promise<void> }) => {
          transport.onmessage = (m) => {
            received.push(m as Record<string, unknown>)
          }
          await transport.start?.()
        }
      )
    } as unknown as SdkMcpServer['instance']
    const server: SdkMcpServer = { type: 'sdk', name: 'srv', tools: [], instance }
    const host = new McpHost({ srv: server })

    const ac = new AbortController()
    const p = host.dispatch(
      'srv',
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} },
      { signal: ac.signal }
    )

    // The request reaches the server but never gets a response.
    await new Promise((r) => setTimeout(r, 5))
    expect(received.some((m) => m.id === 7)).toBe(true)

    // Abort — the dispatch settles with a cancellation error AND the server is
    // told to cancel the in-flight request so the tool stops spending.
    ac.abort()
    const res = (await p) as { id?: number; error?: { code: number } }
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32800 } })
    expect(
      received.some(
        (m) =>
          m.method === 'notifications/cancelled' &&
          (m.params as { requestId?: number } | undefined)?.requestId === 7
      )
    ).toBe(true)
  })

  it('returns cancellation without dispatching when the signal is already aborted', async () => {
    const instance = {
      connect: vi.fn(async (transport: { onmessage?: (m: unknown) => void }) => {
        transport.onmessage = () => {
          throw new Error('handler must not be invoked for a pre-aborted dispatch')
        }
      })
    } as unknown as SdkMcpServer['instance']
    const host = new McpHost({ srv: { type: 'sdk', name: 'srv', tools: [], instance } })
    const ac = new AbortController()
    ac.abort()
    const res = (await host.dispatch(
      'srv',
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} },
      { signal: ac.signal }
    )) as { error?: { code: number } }
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32800 } })
  })

  it('returns a jsonrpc error for unknown server names', async () => {
    const host = new McpHost({})
    const resp = await host.dispatch('does-not-exist', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    })
    expect(resp).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601 }
    })
  })
})
