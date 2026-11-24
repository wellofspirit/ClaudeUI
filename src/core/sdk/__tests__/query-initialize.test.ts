/**
 * @vitest-environment node
 *
 * The `initialize` control request query() writes at spawn: the
 * `perTaskStopAffordance` client capability (docs/protocol-cc/11-cancellation.md).
 *
 * Declared, cli.js's interrupt on this open-input session ends only the turn and
 * spares running background agents; ABSENT, it fails closed and kills them. So
 * the key goes on the wire only as `true`, and is left out (never `false`)
 * otherwise. ClaudeSession sets the option from engines/claude.json
 * (`claudeStopKeepsBackgroundAgents`).
 *
 * Drives query() with a fake child, like reload-plugins.test.ts.
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

  /** The `request` body of the initialize control_request written at spawn. */
  initialize(): Record<string, unknown> {
    const line = this.written.find(
      (l) =>
        l.type === 'control_request' && (l.request as { subtype: string }).subtype === 'initialize'
    )
    expect(line).toBeDefined()
    return line!.request as Record<string, unknown>
  }

  close(): void {
    this.emit('exit', 0, null)
    this.stdout.end()
    this.emit('close', 0, null)
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const children: FakeChild[] = []

async function initializeFor(options: QueryOptions): Promise<Record<string, unknown>> {
  const child = new FakeChild()
  children.push(child)
  const handle = query({
    prompt: 'hi',
    options: { ...options, spawnClaudeCodeProcess: () => child as never }
  })
  void (async () => {
    for await (const _ of handle) void _
  })().catch(() => {})
  await tick()
  return child.initialize()
}

afterEach(() => {
  for (const c of children.splice(0)) c.close()
})

describe('query — perTaskStopAffordance in the initialize request', () => {
  it('declares it when the option is true', async () => {
    const init = await initializeFor({ perTaskStopAffordance: true })
    expect(init.perTaskStopAffordance).toBe(true)
  })

  it('leaves the key out when the option is false — never `false` on the wire', async () => {
    const init = await initializeFor({ perTaskStopAffordance: false })
    expect(init).not.toHaveProperty('perTaskStopAffordance')
  })

  it('leaves the key out when the option is unset', async () => {
    const init = await initializeFor({})
    expect(init).not.toHaveProperty('perTaskStopAffordance')
  })
})
