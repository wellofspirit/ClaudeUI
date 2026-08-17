/**
 * @vitest-environment node
 *
 * M-CL1 regression: the query loop must drain stdout on child `'close'`, not
 * finish the queue on `'exit'`. cli.js writes its final `result` line and then
 * exits; if the queue is finished on `'exit'` the still-buffered `result`
 * (and any in-flight control_response / crash diagnostics) is discarded and
 * the consumer sees a bare "cli.js exited" instead of the real terminal
 * message.
 *
 * We inject a fake child via `spawnClaudeCodeProcess` and deliver the `result`
 * line AFTER `'exit'` (as a real pipe does), then fire `'close'`.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { query } from '../query'
import type { SDKMessage } from '../types'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('query stdout drain on close (M-CL1)', () => {
  it('delivers the final result line that arrives after exit, before close', async () => {
    const child = new FakeChild()
    const handle = query({
      prompt: 'hi',
      options: {
        spawnClaudeCodeProcess: () => child as never
      }
    })

    const received: SDKMessage[] = []
    const iterate = (async () => {
      for await (const msg of handle) received.push(msg)
    })()

    // Let query() wire the reader + lifecycle handlers.
    await tick()

    // The child exits FIRST; its final `result` is still in the pipe.
    child.emit('exit', 0, null)
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1 }) + '\n')
    child.stdout.end()

    // Real ordering: stdout 'data' + 'end' drain, THEN the process 'close'.
    await tick()
    child.emit('close', 0, null)

    await iterate

    // The terminal result survived the drain and the stream ended cleanly.
    expect(received.some((m) => (m as { type?: string }).type === 'result')).toBe(true)
  })

  it('a non-clean exit still surfaces as an error after draining', async () => {
    const child = new FakeChild()
    const handle = query({
      prompt: 'hi',
      options: { spawnClaudeCodeProcess: () => child as never }
    })

    const received: SDKMessage[] = []
    const iterate = (async () => {
      for await (const msg of handle) received.push(msg)
    })().catch((err: Error) => err)

    await tick()
    child.emit('exit', 1, null)
    child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n')
    child.stdout.end()
    await tick()
    child.emit('close', 1, null)

    const result = await iterate
    // Buffered assistant line was still delivered before the terminal error.
    expect(received.some((m) => (m as { type?: string }).type === 'assistant')).toBe(true)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/code=1/)
  })
})
