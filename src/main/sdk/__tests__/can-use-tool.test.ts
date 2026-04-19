/**
 * Contract test for the `can_use_tool` control_response shape.
 *
 * cli.js validates our response with a Zod discriminated union keyed on
 * `behavior` (see iC5 in vendor/claude-cli/cli.js ~char 4957497):
 *
 *   { behavior: 'allow', updatedInput?, updatedPermissions?, toolUseID? }
 *   { behavior: 'deny', message: string, interrupt?, toolUseID? }
 *
 * An earlier revision emitted `{ permitted: boolean }` — the legacy
 * stdin-tool shape — which cli.js rejects with a ZodError and the tool
 * call hangs forever. These tests guard against that regression.
 *
 * We can't easily import `handleCanUseTool` directly (it's a private
 * helper); instead we spin up `query()` against a tiny NDJSON echo child,
 * feed it a synthetic `can_use_tool` control_request, and assert the
 * response that lands on the fake child's stdin.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { query } from '../query'
import type { CanUseTool, QueryHandle, SDKMessage } from '../types'

/**
 * Minimal fake ChildProcess that behaves enough like node:child_process's
 * return value for `query()` to attach reader/writer. stdout is driven
 * by `emitLine()`; stdin collects everything as JSON-parsed lines.
 */
function fakeChild(): {
  child: EventEmitter & Record<string, unknown>
  emitLine: (obj: Record<string, unknown>) => void
  stdinLines: Record<string, unknown>[]
  finish: () => void
} {
  const stdout = new Readable({ read() {} })
  stdout.setEncoding('utf8')
  const stdinLines: Record<string, unknown>[] = []
  const stdin = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const line of s.split('\n')) {
        if (line.trim()) stdinLines.push(JSON.parse(line))
      }
      cb()
    },
  })
  const stderr = new Readable({ read() {} })
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (_sig?: string): boolean => true,
    pid: 12345,
  }) as unknown as EventEmitter & Record<string, unknown>

  return {
    child,
    emitLine: (obj) => stdout.push(JSON.stringify(obj) + '\n'),
    stdinLines,
    finish: () => {
      stdout.push(null)
      child.emit('exit', 0, null)
    },
  }
}

describe('can_use_tool control_response shape', () => {
  let handles: QueryHandle[] = []
  afterEach(() => {
    for (const h of handles) {
      // Ensure the iterator is torn down — prevents the test process from
      // hanging on a dangling async iterator. `return()` is standardized.
      void h[Symbol.asyncIterator]().return?.(undefined)
    }
    handles = []
  })

  async function runWith(canUseTool: CanUseTool | undefined): Promise<{
    stdinLines: Record<string, unknown>[]
    emitLine: (obj: Record<string, unknown>) => void
    finish: () => void
  }> {
    const { child, emitLine, stdinLines, finish } = fakeChild()
    const q = query({
      prompt: (async function* () {
        /* no initial prompt */
      })() as AsyncIterable<SDKMessage>,
      options: {
        canUseTool,
        // Skip Electron's `app.getAppPath()` in locateCliJs — not available
        // under vitest/jsdom. The path is never actually used because our
        // spawnClaudeCodeProcess hook takes over.
        pathToClaudeCodeExecutable: '/fake/cli.js',
        spawnClaudeCodeProcess: () => child as unknown as import('node:child_process').ChildProcess,
      },
    })
    handles.push(q)
    // Drain messages in the background so the iterator doesn't block.
    void (async () => {
      try {
        for await (const _ of q) void _
      } catch {
        /* channel closed by finish() */
      }
    })()
    return { stdinLines, emitLine, finish }
  }

  async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = fn()
      if (v !== undefined) return v
      if (Date.now() > deadline) throw new Error('waitFor timeout')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('allow-branch response uses behavior:"allow" (not permitted:true)', async () => {
    const canUseTool: CanUseTool = async (_name, input) => ({
      behavior: 'allow',
      updatedInput: { ...input, patched: true },
    })
    const { stdinLines, emitLine } = await runWith(canUseTool)

    emitLine({
      type: 'control_request',
      request_id: 'r1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { cmd: 'ls' },
        tool_use_id: 'toolu_abc',
      },
    })

    const resp = await waitFor(() =>
      stdinLines.find(
        (l) =>
          l.type === 'control_response' &&
          (l.response as { request_id?: string } | undefined)?.request_id === 'r1',
      ),
    )
    const inner = (resp.response as { response: Record<string, unknown> }).response
    expect(inner).toMatchObject({
      behavior: 'allow',
      updatedInput: { cmd: 'ls', patched: true },
      toolUseID: 'toolu_abc',
    })
    // Legacy shape must not leak through.
    expect(inner).not.toHaveProperty('permitted')
  })

  it('deny-branch response uses behavior:"deny" with message (not permitted:false)', async () => {
    const canUseTool: CanUseTool = async () => ({
      behavior: 'deny',
      message: 'user refused',
      interrupt: true,
    })
    const { stdinLines, emitLine } = await runWith(canUseTool)

    emitLine({
      type: 'control_request',
      request_id: 'r2',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { cmd: 'rm -rf /' },
        tool_use_id: 'toolu_xyz',
      },
    })

    const resp = await waitFor(() =>
      stdinLines.find(
        (l) =>
          l.type === 'control_response' &&
          (l.response as { request_id?: string } | undefined)?.request_id === 'r2',
      ),
    )
    const inner = (resp.response as { response: Record<string, unknown> }).response
    expect(inner).toMatchObject({
      behavior: 'deny',
      message: 'user refused',
      interrupt: true,
      toolUseID: 'toolu_xyz',
    })
    expect(inner).not.toHaveProperty('permitted')
  })

  it('deny without explicit message still ships a string (cli.js requires it)', async () => {
    // cli.js's schema has `message: z.string()` on the deny branch — no
    // `.optional()`. A canUseTool callback that omits it must not break
    // the channel; we coerce to a default.
    const canUseTool: CanUseTool = async () => ({ behavior: 'deny' } as never)
    const { stdinLines, emitLine } = await runWith(canUseTool)

    emitLine({
      type: 'control_request',
      request_id: 'r3',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: {},
        tool_use_id: 'toolu_fff',
      },
    })

    const resp = await waitFor(() =>
      stdinLines.find(
        (l) =>
          l.type === 'control_response' &&
          (l.response as { request_id?: string } | undefined)?.request_id === 'r3',
      ),
    )
    const inner = (resp.response as { response: Record<string, unknown> }).response
    expect(inner.behavior).toBe('deny')
    expect(typeof inner.message).toBe('string')
    expect((inner.message as string).length).toBeGreaterThan(0)
  })

  it('no canUseTool callback: auto-allow with behavior:"allow"', async () => {
    const { stdinLines, emitLine } = await runWith(undefined)

    emitLine({
      type: 'control_request',
      request_id: 'r4',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { cmd: 'ls' },
        tool_use_id: 'toolu_no_cb',
      },
    })

    const resp = await waitFor(() =>
      stdinLines.find(
        (l) =>
          l.type === 'control_response' &&
          (l.response as { request_id?: string } | undefined)?.request_id === 'r4',
      ),
    )
    const inner = (resp.response as { response: Record<string, unknown> }).response
    expect(inner).toMatchObject({ behavior: 'allow', toolUseID: 'toolu_no_cb' })
    expect(inner).not.toHaveProperty('permitted')
  })
})
