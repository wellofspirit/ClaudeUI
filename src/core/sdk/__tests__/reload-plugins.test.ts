/**
 * @vitest-environment node
 *
 * query() sends `reload_plugins` once, after the initialize response.
 *
 * cli.js's headless startup never connects the MCP servers of plugins enabled
 * in settings; `reload_plugins` does (docs/protocol-cc/07-control-outbound.md,
 * `reload_plugins`). It replaced the `mcp-status` patch. The request must
 * follow the initialize response, not race it, and must never hold up the
 * first prompt, which is written at spawn.
 *
 * Drives query() with a fake child, like query-drain.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { query } from '../query'
import type { QueryOptions } from '../types'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  written: Array<Record<string, unknown>> = []

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.written.push(JSON.parse(line))
      }
    })
  }

  /** Every control_request subtype written so far, in order. */
  subtypes(): string[] {
    return this.written
      .filter((l) => l.type === 'control_request')
      .map((l) => (l.request as { subtype: string }).subtype)
  }

  requestId(subtype: string): string {
    const line = this.written.find(
      (l) => l.type === 'control_request' && (l.request as { subtype: string }).subtype === subtype
    )
    return line!.request_id as string
  }

  respond(response: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n')
  }

  close(): void {
    this.emit('exit', 0, null)
    this.stdout.end()
    this.emit('close', 0, null)
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const children: FakeChild[] = []

function start(options: QueryOptions = {}): FakeChild {
  const child = new FakeChild()
  children.push(child)
  const handle = query({
    prompt: 'hi',
    options: { ...options, spawnClaudeCodeProcess: () => child as never }
  })
  // Drain the message queue so nothing backs up.
  void (async () => {
    for await (const _ of handle) void _
  })().catch(() => {})
  return child
}

function answerInitialize(child: FakeChild, ok = true): void {
  const request_id = child.requestId('initialize')
  child.respond(
    ok
      ? { subtype: 'success', request_id, response: { commands: [], models: [] } }
      : { subtype: 'error', request_id, error: 'boom' }
  )
}

afterEach(() => {
  for (const c of children.splice(0)) c.close()
  vi.restoreAllMocks()
})

describe('query — reload_plugins after initialize', () => {
  it('sends reload_plugins only once the initialize response has arrived', async () => {
    const child = start()
    await tick()
    // The prompt went out at spawn, alongside initialize; no reload yet.
    expect(child.subtypes()).toEqual(['initialize'])
    expect(child.written.some((l) => l.type === 'user')).toBe(true)

    answerInitialize(child)
    await tick()
    await tick()

    expect(child.subtypes()).toEqual(['initialize', 'reload_plugins'])
    const types = child.written.map((l) => l.type)
    // After the user prompt, so the first turn never waits for it.
    expect(types.indexOf('user')).toBeLessThan(
      child.written.findIndex(
        (l) =>
          l.type === 'control_request' &&
          (l.request as { subtype: string }).subtype === 'reload_plugins'
      )
    )
  })

  it('does not send it when initialize failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const child = start()
    await tick()
    answerInitialize(child, false)
    await tick()
    await tick()
    expect(child.subtypes()).toEqual(['initialize'])
  })

  it('does not send it for a strict MCP config', async () => {
    const child = start({ strictMcpConfig: true })
    await tick()
    answerInitialize(child)
    await tick()
    await tick()
    expect(child.subtypes()).toEqual(['initialize'])
  })

  it('only warns when reload_plugins fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stderr: string[] = []
    const child = start({ stderr: (chunk) => stderr.push(chunk.toString()) })
    await tick()
    answerInitialize(child)
    await tick()
    await tick()

    const request_id = child.requestId('reload_plugins')
    child.respond({ subtype: 'error', request_id, error: 'plugins exploded' })
    await tick()
    await tick()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugins exploded'))
    expect(stderr.join('')).toContain('reload_plugins after initialize failed: plugins exploded')
  })
})
