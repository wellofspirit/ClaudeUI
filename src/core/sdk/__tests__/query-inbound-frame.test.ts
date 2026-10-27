/**
 * @vitest-environment node
 *
 * `onInboundFrame` (session tools, slice 1c): an observer sees every stream frame
 * the child writes, in wire order, BEFORE it is queued for the consumer, and
 * cannot break the stream. It is how the session tools learn which tool_use
 * blocks belong to a subagent ahead of the MCP call that follows the frame on the
 * same pipe. Same fake child as parse-error-skip.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { query } from '../query'
import type { QueryHandle, SDKMessage } from '../types'

function fakeChild(): {
  child: EventEmitter & Record<string, unknown>
  emitLine: (obj: Record<string, unknown>) => void
  finish: () => void
} {
  const stdout = new Readable({ read() {} })
  stdout.setEncoding('utf8')
  const stdin = new Writable({
    write(_chunk: Buffer | string, _enc, cb): void {
      cb()
    }
  })
  const stderr = new Readable({ read() {} })
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (_sig?: string): boolean => true,
    pid: 4243
  }) as unknown as EventEmitter & Record<string, unknown>
  return {
    child,
    emitLine: (obj) => stdout.push(JSON.stringify(obj) + '\n'),
    finish: () => {
      // Real ordering: 'exit', then 'close' once stdout has ended. Without
      // 'close' query() waits out its 2 s closeFallback timer.
      stdout.once('end', () => child.emit('close', 0, null))
      stdout.push(null)
      child.emit('exit', 0, null)
    }
  }
}

describe('query() — onInboundFrame', () => {
  let handles: QueryHandle[] = []
  afterEach(() => {
    for (const h of handles) void h[Symbol.asyncIterator]().return?.(undefined)
    handles = []
  })

  function open(
    onInboundFrame: (frame: Record<string, unknown>) => void
  ): ReturnType<typeof fakeChild> & { received: SDKMessage[]; drained: Promise<void> } {
    const fake = fakeChild()
    const received: SDKMessage[] = []
    const q = query({
      prompt: (async function* () {
        /* no initial prompt */
      })() as AsyncIterable<SDKMessage>,
      options: {
        pathToClaudeCodeExecutable: '/fake/cli.js',
        onInboundFrame,
        spawnClaudeCodeProcess: () =>
          fake.child as unknown as import('node:child_process').ChildProcess
      }
    })
    handles.push(q)
    const drained = (async () => {
      for await (const m of q) received.push(m)
    })()
    return { ...fake, received, drained }
  }

  it('sees each stream frame in wire order, and not the control traffic', async () => {
    const seen: string[] = []
    const { emitLine, finish, received, drained } = open((frame) => {
      seen.push(`${frame.type}:${(frame as { tag?: string }).tag ?? ''}`)
    })
    emitLine({ type: 'assistant', tag: 'a', message: { role: 'assistant', content: [] } })
    emitLine({ type: 'control_response', response: { request_id: 'nobody', subtype: 'success' } })
    emitLine({ type: 'stream_event', tag: 'b', event: { type: 'content_block_start' } })
    await new Promise((r) => setTimeout(r, 20))
    finish()
    await drained
    expect(seen).toEqual(['assistant:a', 'stream_event:b'])
    expect(received.map((m) => m.type)).toEqual(['assistant', 'stream_event'])
  })

  it('an observer that throws does not break the stream', async () => {
    const { emitLine, finish, received, drained } = open(() => {
      throw new Error('observer bug')
    })
    emitLine({ type: 'assistant', message: { role: 'assistant', content: 'one' } })
    emitLine({ type: 'assistant', message: { role: 'assistant', content: 'two' } })
    await new Promise((r) => setTimeout(r, 20))
    finish()
    await drained
    expect(received).toHaveLength(2)
  })
})
