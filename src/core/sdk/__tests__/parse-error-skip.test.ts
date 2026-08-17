/**
 * @vitest-environment node
 *
 * H16 guard: a single malformed (non-JSON) stdout line must NOT tear down a
 * LIVE query. The pre-fix code did `queue.finish(new Error(...))` on any parse
 * error while the child was still running — the for-await consumer's next()
 * then REJECTED, IteratorClose (the handle's return()/killChild) was skipped,
 * and the child + its MCP subprocesses were orphaned to app quit; the next
 * run() spawned a SECOND `--resume` process alongside the orphan.
 *
 * Post-fix the bad line is skipped and the stream keeps flowing. We drive
 * query() against a fake child (spawnClaudeCodeProcess hook, same scaffold as
 * can-use-tool.test.ts), inject a garbage line between two valid messages, and
 * assert BOTH valid messages are delivered and the child is NOT killed.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { query } from '../query'
import type { QueryHandle, SDKMessage } from '../types'

function fakeChild(): {
  child: EventEmitter & Record<string, unknown>
  emitRaw: (line: string) => void
  emitLine: (obj: Record<string, unknown>) => void
  killed: () => boolean
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
  let wasKilled = false
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (_sig?: string): boolean => {
      wasKilled = true
      return true
    },
    pid: 4242
  }) as unknown as EventEmitter & Record<string, unknown>

  return {
    child,
    emitRaw: (line) => stdout.push(line + '\n'),
    emitLine: (obj) => stdout.push(JSON.stringify(obj) + '\n'),
    killed: () => wasKilled,
    finish: () => {
      stdout.push(null)
      child.emit('exit', 0, null)
    }
  }
}

describe('query() — malformed stream-json line (H16)', () => {
  let handles: QueryHandle[] = []
  afterEach(() => {
    for (const h of handles) void h[Symbol.asyncIterator]().return?.(undefined)
    handles = []
  })

  it('skips a non-JSON line, keeps the child alive, and delivers the next valid message', async () => {
    const { child, emitRaw, emitLine, killed, finish } = fakeChild()
    const received: SDKMessage[] = []
    let iterationError: unknown = null

    const q = query({
      prompt: (async function* () {
        /* no initial prompt */
      })() as AsyncIterable<SDKMessage>,
      options: {
        pathToClaudeCodeExecutable: '/fake/cli.js',
        spawnClaudeCodeProcess: () =>
          child as unknown as import('node:child_process').ChildProcess
      }
    })
    handles.push(q)

    const drain = (async () => {
      try {
        for await (const m of q) received.push(m)
      } catch (err) {
        iterationError = err
      }
    })()

    // Valid message, then GARBAGE, then another valid message.
    emitLine({ type: 'assistant', message: { role: 'assistant', content: 'first' } })
    emitRaw('this is not json at all {{{')
    emitLine({ type: 'assistant', message: { role: 'assistant', content: 'second' } })

    // Give the reader a few ticks to process, then close cleanly.
    await new Promise((r) => setTimeout(r, 20))

    // The child must NOT have been killed by the parse error (no orphan / no
    // spurious teardown).
    expect(killed()).toBe(false)

    finish()
    await drain

    // Both valid messages made it through; the garbage line vanished silently.
    expect(iterationError).toBeNull()
    expect(received.map((m) => (m as { type: string }).type)).toEqual(['assistant', 'assistant'])
    expect(
      received.map(
        (m) => ((m as { message?: { content?: string } }).message ?? {}).content
      )
    ).toEqual(['first', 'second'])
  })
})
