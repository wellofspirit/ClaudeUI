/**
 * Slice A of ADR-033 (cross-engine dispatch): `createSdkMcpServer()` now
 * threads the MCP SDK's second callback arg (`RequestHandlerExtra`) through
 * to tool handlers as `SdkToolExtra` — an abort signal + a `sendNotification`
 * escape hatch (used by `sendProgress()` for long-running dispatched turns).
 *
 * Verified against the REAL MCP SDK (Client + McpServer over
 * `InMemoryTransport.createLinkedPair()`), not a hand-rolled stub — the
 * abort-propagation and progress-notification wiring live entirely inside
 * `@modelcontextprotocol/sdk`'s `Protocol` class, so a stub would prove
 * nothing about the real contract.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSdkMcpServer, tool, sendProgress } from '../create-sdk-mcp'
import type { SdkMcpTool } from '../types'

type CallToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> }

/** Wire one SdkMcpTool up to a fresh Client over a linked in-memory transport pair. */
async function connect(t: SdkMcpTool): Promise<{ client: Client }> {
  const server = createSdkMcpServer({ name: 'test-server', tools: [t] })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.instance!.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '0.0.0' }, {})
  await client.connect(clientTransport)
  return { client }
}

describe('createSdkMcpServer — SdkToolExtra threading (ADR-033 Slice A)', () => {
  const clients: Client[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
  })

  it('a legacy one-arg handler (mermaid/mockup shape) still works unchanged', async () => {
    const legacyTool = tool(
      'legacy_echo',
      'Echoes the input — one-arg handler, ignores extra entirely.',
      { x: z.string() },
      async ({ x }) => ({ content: [{ type: 'text' as const, text: `got ${x}` }] })
    )
    const { client } = await connect(legacyTool)
    clients.push(client)

    const result = (await client.callTool({
      name: 'legacy_echo',
      arguments: { x: 'hi' }
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe('got hi')
  })

  it('handler receives extra.signal, which fires when the client cancels the call', async () => {
    let observedAbort = false
    const slowTool = tool(
      'slow_tool',
      'Waits until aborted or a 5s safety timeout, whichever comes first.',
      {},
      async (_input, extra) => {
        await new Promise<void>((resolve) => {
          const done = (): void => resolve()
          extra!.signal.addEventListener('abort', () => {
            observedAbort = true
            done()
          })
          // Safety net so a failing test doesn't hang the suite.
          setTimeout(done, 5000)
        })
        return { content: [{ type: 'text' as const, text: 'done' }] }
      }
    )
    const { client } = await connect(slowTool)
    clients.push(client)

    const controller = new AbortController()
    const callPromise = client.callTool(
      { name: 'slow_tool', arguments: {} },
      undefined,
      { signal: controller.signal }
    )

    // Let the request reach the server (and the handler start awaiting) before
    // cancelling — otherwise we could abort before the abort-listener is wired.
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()

    await expect(callPromise).rejects.toThrow()
    // Give the server-side abort listener a tick to run.
    await new Promise((r) => setTimeout(r, 20))
    expect(observedAbort).toBe(true)
  })

  it('sendProgress() emits notifications/progress carrying the caller-supplied token', async () => {
    const progressTool = tool(
      'progress_tool',
      'Emits one progress notification, then returns.',
      {},
      async (_input, extra) => {
        await sendProgress(extra, { progress: 1, total: 2, message: 'halfway' })
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      }
    )
    const { client } = await connect(progressTool)
    clients.push(client)

    const progressEvents: Array<{ progress: number; total?: number; message?: string }> = []
    const result = (await client.callTool(
      { name: 'progress_tool', arguments: {} },
      undefined,
      { onprogress: (p) => progressEvents.push(p) }
    )) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(progressEvents).toHaveLength(1)
    expect(progressEvents[0]).toMatchObject({ progress: 1, total: 2, message: 'halfway' })
  })

  it('sendProgress() no-ops when the caller did not request progress (no progressToken)', async () => {
    // Guard: without this, a handler that always calls sendProgress would
    // throw (or send a malformed notification) on a plain callTool() with no
    // onprogress callback — the common case for every existing tool caller.
    const progressTool = tool(
      'progress_tool_no_listener',
      'Calls sendProgress with an extra that lacks a progressToken.',
      {},
      async (_input, extra) => {
        await sendProgress(extra, { progress: 1 })
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      }
    )
    const { client } = await connect(progressTool)
    clients.push(client)

    const result = (await client.callTool({
      name: 'progress_tool_no_listener',
      arguments: {}
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe('ok')
  })

  it('sendProgress() sends when progressToken is 0 (falsy but legitimate)', async () => {
    // The MCP TS SDK client derives tokens from its message-ID counter, which
    // starts at 0 — a truthiness guard would silently drop the first token.
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    await sendProgress(
      { signal: new AbortController().signal, progressToken: 0, sendNotification },
      { progress: 1 }
    )

    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toEqual({
      method: 'notifications/progress',
      params: { progressToken: 0, progress: 1 }
    })
  })
})
