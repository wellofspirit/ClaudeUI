/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for `RemoteDispatcher`.
 *
 * The dispatcher is a pure routing layer: `register(channel, handler)` + `handle(msg)`.
 * All tests run in-process with no network; we construct a fresh dispatcher per test
 * and assert its externally observable behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RemoteDispatcher } from '../remote-dispatcher'
import type { WsInvokeRequest } from '../../../shared/remote-protocol'

// The dispatcher calls logger.error() on handler exceptions.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

function req(channel: string, args: unknown[] = [], id = 'req-1'): WsInvokeRequest {
  return { type: 'invoke', id, channel, args }
}

describe('RemoteDispatcher', () => {
  let dispatcher: RemoteDispatcher

  beforeEach(() => {
    dispatcher = new RemoteDispatcher()
  })

  describe('routing', () => {
    it('routes a registered channel to its handler', async () => {
      const handler = vi.fn().mockResolvedValue({ hello: 'world' })
      dispatcher.register('session:list', handler)

      const result = await dispatcher.handle(req('session:list', ['arg1', 'arg2']))

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('arg1', 'arg2')
      expect(result).toEqual({ hello: 'world' })
    })

    it('throws a typed Error for an unregistered channel (caller serializes, does not crash)', async () => {
      const handleP = dispatcher.handle(req('unknown:channel'))

      await expect(handleP).rejects.toBeInstanceOf(Error)
      await expect(handleP).rejects.toThrow(/Channel not available: unknown:channel/)
    })
  })

  describe('blocklist', () => {
    // Each of these channels is listed in RemoteDispatcher.BLOCKED. The contract
    // is: calling register() for a blocked channel is a no-op (silently skipped),
    // and later dispatch() to that channel behaves exactly like an unknown channel.
    const BLOCKED_CHANNELS = [
      'window:minimize',
      'window:maximize',
      'window:close',
      'session:pick-folder',
      'app:quit-confirm',
      'app:open-in-vscode',
      'terminal:create',
      'terminal:write',
      'terminal:resize',
      'terminal:kill',
      'terminal:kill-by-cwd',
      // Remote-server config + credential (Phase 1 of remote auth) — a remote
      // client must never read/rotate its own auth credential or flip
      // transport/autostart flags.
      'remote:get-config',
      'remote:set-config',
      'remote:set-password',
      'remote:clear-password'
    ] as const

    it.each(BLOCKED_CHANNELS)(
      'refuses to register or dispatch blocked channel "%s"',
      async (channel) => {
        const handler = vi.fn().mockResolvedValue('should-not-be-called')
        dispatcher.register(channel, handler)

        expect(dispatcher.has(channel)).toBe(false)
        expect(dispatcher.channels()).not.toContain(channel)

        await expect(dispatcher.handle(req(channel))).rejects.toThrow(/Channel not available/)
        expect(handler).not.toHaveBeenCalled()
      }
    )
  })

  describe('handler outcomes', () => {
    it('resolves with handler return value on success (envelope built by caller)', async () => {
      dispatcher.register('echo', async (x: unknown) => ({ ok: true, data: x }))
      const result = await dispatcher.handle(req('echo', ['hello']))
      expect(result).toEqual({ ok: true, data: 'hello' })
    })

    it('propagates handler exceptions with a serializable string error', async () => {
      dispatcher.register('broken', async () => {
        throw new Error('boom')
      })

      let caught: unknown
      try {
        await dispatcher.handle(req('broken'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('boom')
      // The caller (RemoteServer.handleInvoke) JSON.stringifies .message, so
      // anything that survives round-trip through `String()` is acceptable.
      expect(String(caught)).toContain('boom')
    })
  })

  describe('robustness', () => {
    it('gracefully rejects a malformed request (no channel) without crashing the dispatcher', async () => {
      const malformed = { type: 'invoke', id: 'x', args: [] } as unknown as WsInvokeRequest
      await expect(dispatcher.handle(malformed)).rejects.toThrow(/Channel not available/)

      // Dispatcher must remain usable for subsequent real requests.
      dispatcher.register('ping', async () => 'pong')
      await expect(dispatcher.handle(req('ping'))).resolves.toBe('pong')
    })

    it('routes concurrent requests independently without cross-talk', async () => {
      // Two handlers that resolve on different ticks — interleave to catch
      // any accidental shared state (e.g. "last request" variables).
      let resolveA: (v: string) => void = () => {}
      let resolveB: (v: string) => void = () => {}
      dispatcher.register('A', () => new Promise<string>((r) => (resolveA = r)))
      dispatcher.register('B', () => new Promise<string>((r) => (resolveB = r)))

      const pA = dispatcher.handle(req('A', [], 'id-a'))
      const pB = dispatcher.handle(req('B', [], 'id-b'))

      // Resolve in reverse order to ensure ids aren't confused.
      resolveB('result-b')
      resolveA('result-a')

      const [a, b] = await Promise.all([pA, pB])
      expect(a).toBe('result-a')
      expect(b).toBe('result-b')
    })
  })
})

// ---------------------------------------------------------------------------
// Guard: RemoteStatus stays desktop-only.
//
// `RemoteServer.notifyStatus()` pushes `remote:status` via
// `win.webContents.send` (the real desktop window, not the RemoteBridge), and
// `remote-handlers.ts` registers NO `remote:*` channel on the RemoteDispatcher —
// which is a denylist over an EXPLICIT registration set, so an unregistered
// channel is unreachable. Together that means widening `RemoteStatus`
// (Phase 2 added `authMethods`; Phase 3 adds tls/clientLogins) cannot leak
// server internals or one remote user's identity to another.
//
// This is a source-level assertion on purpose: importing remote-handlers.ts
// pulls in the SDK + every service, which a unit test must not do.
// ---------------------------------------------------------------------------

describe('remote-handlers registration surface (guard)', () => {
  const HANDLERS_PATH = resolve(__dirname, '../../ipc/remote-handlers.ts')

  it('registers no remote:* channel on the RemoteDispatcher', () => {
    const src = readFileSync(HANDLERS_PATH, 'utf-8')
    // Every registration in that file goes through `.register('<channel>'`.
    const registered = [...src.matchAll(/\.register\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(registered.length).toBeGreaterThan(50) // non-vacuity: we did parse it
    expect(registered.filter((c) => c.startsWith('remote:'))).toEqual([])
  })

  it('registers no remote:* channel via a template/computed channel name either', () => {
    const src = readFileSync(HANDLERS_PATH, 'utf-8')
    // A backtick channel or a `'remote:' + x` concatenation would slip past the
    // literal scan above.
    expect(src).not.toMatch(/\.register\(\s*`remote:/)
    expect(src).not.toMatch(/['"`]remote:['"`]\s*\+/)
  })
})
