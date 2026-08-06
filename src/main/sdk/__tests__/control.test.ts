import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { ControlChannel } from '../control'
import { NdjsonWriter, type JsonLine } from '../protocol'

/**
 * Collect every line the ControlChannel writes, so assertions can verify
 * subtype / request_id / payload without having to parse stream output.
 */
function makeSink(): {
  writer: NdjsonWriter
  written: JsonLine[]
} {
  const pass = new PassThrough()
  const written: JsonLine[] = []
  pass.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) written.push(JSON.parse(line))
    }
  })
  return { writer: new NdjsonWriter(pass), written }
}

describe('ControlChannel.request', () => {
  beforeEach(() => vi.useRealTimers())

  it('resolves on a matching success response with the generic type', async () => {
    const { writer, written } = makeSink()
    const c = new ControlChannel(writer)

    const p = c.request<{ port: number }>({ subtype: 'voice_server_start' })
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const request_id = written[0].request_id as string

    c.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id,
        response: { port: 42 }
      }
    })
    const r = await p
    expect(r).toEqual({ port: 42 })
  })

  it('rejects with the error string on error responses', async () => {
    const { writer, written } = makeSink()
    const c = new ControlChannel(writer)
    const p = c.request({ subtype: 'bogus' })
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const request_id = written[0].request_id as string

    c.handleResponse({
      type: 'control_response',
      response: { subtype: 'error', request_id, error: 'nope' }
    })
    await expect(p).rejects.toThrow('nope')
  })

  it('times out when no response arrives within timeoutMs', async () => {
    vi.useFakeTimers()
    const { writer } = makeSink()
    const c = new ControlChannel(writer)
    const p = c.request({ subtype: 'interrupt' }, { timeoutMs: 100 })
    const caught = p.catch((err) => err)
    await vi.advanceTimersByTimeAsync(150)
    const err = (await caught) as Error
    expect(err.message).toMatch(/control_request interrupt/)
    expect(err.message).toMatch(/100ms/)
  })

  it('does not timeout when timeoutMs: 0 is passed', async () => {
    vi.useFakeTimers()
    const { writer, written } = makeSink()
    const c = new ControlChannel(writer)
    const p = c.request({ subtype: 'claude_oauth_wait_for_completion' }, { timeoutMs: 0 })
    const onReject = vi.fn()
    p.catch(onReject)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onReject).not.toHaveBeenCalled()

    // Still resolves when the response eventually arrives.
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const request_id = written[0].request_id as string
    c.handleResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id, response: { done: true } }
    })
    await expect(p).resolves.toEqual({ done: true })
  })

  it('rejects immediately when the write does not land, even for timeoutMs:0 (M-CL2)', async () => {
    // A destroyed stream is unwritable → NdjsonWriter.write returns false. The
    // request must reject NOW rather than staying pending forever (a timeoutMs:0
    // subtype like oauth_wait_for_completion would otherwise stick the auth flow
    // in 'authorizing' when the child died before the call).
    const pass = new PassThrough()
    pass.destroy()
    const writer = new NdjsonWriter(pass)
    const c = new ControlChannel(writer)
    await expect(
      c.request({ subtype: 'claude_oauth_wait_for_completion' }, { timeoutMs: 0 })
    ).rejects.toThrow(/stream not writable/)
  })

  it('NdjsonWriter.write reports whether the line landed', () => {
    const open = new PassThrough()
    expect(new NdjsonWriter(open).write({ type: 'x' })).toBe(true)
    const closed = new PassThrough()
    closed.destroy()
    expect(new NdjsonWriter(closed).write({ type: 'x' })).toBe(false)
  })

  it('fires onPendingPermissionRequests when the error response rides them', async () => {
    const { writer, written } = makeSink()
    const onPending = vi.fn()
    const c = new ControlChannel(writer, { onPendingPermissionRequests: onPending })

    const p = c.request({ subtype: 'set_permission_mode', mode: 'default' })
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const request_id = written[0].request_id as string

    const pendingRequests = [
      {
        type: 'control_request',
        request_id: 'pending-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: {} }
      }
    ]
    c.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id,
        error: 'blocked',
        pending_permission_requests: pendingRequests
      }
    })

    await expect(p).rejects.toThrow('blocked')
    expect(onPending).toHaveBeenCalledOnce()
    expect(onPending).toHaveBeenCalledWith(pendingRequests)
  })

  it('rejectAll clears pending timers and rejects all outstanding requests', async () => {
    vi.useFakeTimers()
    const { writer } = makeSink()
    const c = new ControlChannel(writer)
    const p1 = c.request({ subtype: 'a' }, { timeoutMs: 1_000 })
    const p2 = c.request({ subtype: 'b' }, { timeoutMs: 1_000 })
    const caught1 = p1.catch((e: Error) => e)
    const caught2 = p2.catch((e: Error) => e)

    c.rejectAll('teardown')
    expect(((await caught1) as Error).message).toBe('teardown')
    expect(((await caught2) as Error).message).toBe('teardown')

    // Advancing past the timeouts must NOT produce a second rejection.
    // If timers were not cleared, unhandled-rejection warnings would fire
    // in the vitest env and this test would flag them.
    await vi.advanceTimersByTimeAsync(2_000)
  })

  it('cancelInbound fires the AbortController registered with beginInbound', () => {
    const { writer } = makeSink()
    const c = new ControlChannel(writer)
    const ac = c.beginInbound('rid-1')
    expect(ac.signal.aborted).toBe(false)
    c.cancelInbound('rid-1')
    expect(ac.signal.aborted).toBe(true)
  })

  it('abortAllInbound fires every registered AbortController', () => {
    const { writer } = makeSink()
    const c = new ControlChannel(writer)
    const ac1 = c.beginInbound('rid-1')
    const ac2 = c.beginInbound('rid-2')
    c.abortAllInbound()
    expect(ac1.signal.aborted).toBe(true)
    expect(ac2.signal.aborted).toBe(true)
  })
})
