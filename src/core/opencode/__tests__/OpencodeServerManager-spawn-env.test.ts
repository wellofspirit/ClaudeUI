/**
 * Guards the environment `opencode serve` is actually spawned with.
 *
 * The other manager test injects `spawnFn`, which skips the real spawn path
 * entirely — so nothing there covers the env block. This one mocks
 * `node:child_process` instead and lets the DEFAULT spawnFn run, which is the
 * only way to see what the child would receive.
 *
 * Asserted:
 * - OPENCODE_DISABLE_SHARE=1, the kill switch share-next.ts reads at module
 *   load. Config-level `share` is user-overridable; this is not.
 * - OPENCODE_SERVER_PASSWORD is still set (Basic auth on the local server).
 * - OPENCODE_CONFIG_CONTENT carries autoupdate:false (ADR-037).
 * - The parent environment is inherited, not replaced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpHttpHost } from '../mcp-http-host'

const { spawnMock, spawnCalls } = vi.hoisted(() => {
  const spawnCalls: { args: string[]; env: Record<string, string | undefined> }[] = []
  /** Just enough of a ChildProcess for spawnServer's port-parse path. */
  interface FakeChild extends EventEmitter {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => boolean
  }
  const spawnMock = vi.fn((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ args, env: { ...opts.env } })
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    // The manager attaches its stdout listener synchronously after spawn()
    // returns; emit the port line on the next tick so it is heard.
    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:41234\n')
      )
    }, 0)
    return child as unknown as import('node:child_process').ChildProcess
  })
  return { spawnMock, spawnCalls }
})

// Partial mock: OTHER modules in this import graph (src/core/sdk/query.ts …)
// pull real members out of node:child_process, so only `spawn` is replaced.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // `default` must carry the mock too: with CJS interop a consumer's named
  // import can be read off the default export, which would hand back the REAL
  // spawn and actually try to exec the fake binary path.
  const mocked = { ...actual, spawn: spawnMock }
  return { ...mocked, default: mocked }
})

const { OpencodeServerManager } = await import('../OpencodeServerManager')

function fakeMcpHost(): McpHttpHost {
  return { port: 19998, token: 'tok', close: async () => {} }
}

describe('opencode serve spawn environment', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    spawnMock.mockClear()
  })

  async function spawnOnce(): Promise<Record<string, string | undefined>> {
    const manager = new OpencodeServerManager({
      locateBinaryFn: () => '/fake/opencode',
      startMcpHostFn: async (_s: McpServer) => fakeMcpHost()
    })
    await manager.acquire(process.cwd())
    await manager.dispose()
    expect(spawnCalls).toHaveLength(1)
    return spawnCalls[0].env
  }

  it('sets OPENCODE_DISABLE_SHARE=1 (a config file cannot override an env var)', async () => {
    const env = await spawnOnce()
    expect(env.OPENCODE_DISABLE_SHARE).toBe('1')
  })

  it('still sets OPENCODE_SERVER_PASSWORD', async () => {
    const env = await spawnOnce()
    expect(typeof env.OPENCODE_SERVER_PASSWORD).toBe('string')
    expect(env.OPENCODE_SERVER_PASSWORD).not.toBe('')
  })

  it('injects autoupdate:false through OPENCODE_CONFIG_CONTENT', async () => {
    const env = await spawnOnce()
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
    expect(cfg.autoupdate).toBe(false)
  })

  it('inherits the parent environment rather than replacing it', async () => {
    process.env.CLAUDEUI_SPAWN_ENV_PROBE = 'inherited'
    try {
      const env = await spawnOnce()
      expect(env.CLAUDEUI_SPAWN_ENV_PROBE).toBe('inherited')
    } finally {
      delete process.env.CLAUDEUI_SPAWN_ENV_PROBE
    }
  })
})
