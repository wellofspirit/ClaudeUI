/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for `RemoteDispatcher`.
 *
 * Post-SyncCore-phase-1 the dispatcher is a thin transport adapter over the
 * shared command registry: `handle(msg, connection)` resolves the channel for
 * the `remote` transport, checks the declared capability against the
 * connection's grants, and dispatches. These tests drive a PRIVATE registry
 * instance so they never see production registrations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import {
  CommandRegistry,
  AUTH_OFF_GRANTS,
  PINNED_CAPABILITIES,
  makeRemoteConnection
} from '../../../core/ipc/command-registry'
import type { WsInvokeRequest } from '../../../shared/remote-protocol'

// The dispatcher calls logger.error() on handler exceptions.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Keep the audit sink out of a pure routing unit test (it would open SQLite).
vi.mock('../../../core/services/db', () => ({ appendAuditLog: vi.fn() }))

function req(channel: string, args: unknown[] = [], id = 'req-1'): WsInvokeRequest {
  return { type: 'invoke', id, channel, args }
}

/** A remote connection with the legacy-policy grants — what phase 1 issues. */
const remoteConn = makeRemoteConnection('password', null)

describe('RemoteDispatcher', () => {
  let registry: CommandRegistry
  let dispatcher: RemoteDispatcher

  /** Register a `chat`-capability remote handler (chat is granted). */
  const register = (
    channel: string,
    handler: (...args: any[]) => unknown,
    capability: 'chat' | 'admin' | 'shell' | 'host' = 'chat'
  ): void => {
    registry.register({ channel, capability, kind: 'query', transport: 'remote', handler })
  }

  beforeEach(() => {
    registry = new CommandRegistry()
    dispatcher = new RemoteDispatcher(registry)
  })

  describe('routing', () => {
    it('routes a registered channel to its handler', async () => {
      const handler = vi.fn().mockResolvedValue({ hello: 'world' })
      register('session:list', handler)

      const result = await dispatcher.handle(req('session:list', ['arg1', 'arg2']), remoteConn)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('arg1', 'arg2')
      expect(result).toEqual({ hello: 'world' })
    })

    it('throws a typed Error for an unregistered channel (caller serializes, does not crash)', async () => {
      const handleP = dispatcher.handle(req('unknown:channel'), remoteConn)

      await expect(handleP).rejects.toBeInstanceOf(Error)
      await expect(handleP).rejects.toThrow(/Channel not available: unknown:channel/)
    })

    it('does not expose a channel registered only for the desktop transport', async () => {
      registry.register({
        channel: 'desktop:only',
        capability: 'chat',
        kind: 'query',
        transport: 'desktop',
        handler: vi.fn()
      })

      expect(dispatcher.has('desktop:only')).toBe(false)
      await expect(dispatcher.handle(req('desktop:only'), remoteConn)).rejects.toThrow(
        /Channel not available/
      )
    })
  })

  describe('capability gating (replaces the deleted BLOCKED denylist)', () => {
    // The pre-phase-1 dispatcher carried a hand-maintained denylist. Its effect
    // is now a property of the capability model: each of these channels is
    // pinned to a capability no remote connection holds, so even a future edit
    // that mistakenly registers one for the remote transport cannot expose it.
    const HISTORICALLY_BLOCKED = [
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
      // ADR-056 REMOVED `auth:*`, `account:*` and `usage:refresh-prices` from
      // this list. They declare `config` now — `admin` shrank to exactly the
      // session-security area — so a PIN would be a contradiction rather than a
      // guarantee (the pin table's one invariant is that every entry names a
      // capability the base grant set does not hold). What keeps them off the
      // remote surface is the other half of the reachability rule: they have no
      // remote registration at all, which `remote-handlers.ipc.test.ts` pins
      // channel by channel. See ENGINE_VENDOR_DESKTOP_ONLY below.
      'remote:get-config',
      'remote:set-config',
      'remote:set-password',
      'remote:clear-password',
      'remote:tailscale-detect',
      'remote:force-reserve'
    ] as const

    it.each(HISTORICALLY_BLOCKED)(
      'pins "%s" to a capability remote is never granted',
      (channel) => {
        const pinned = PINNED_CAPABILITIES[channel]
        expect(pinned).toBeDefined()
        expect(AUTH_OFF_GRANTS.has(pinned)).toBe(false)
      }
    )

    it.each(HISTORICALLY_BLOCKED)(
      'refuses to dispatch "%s" even when it is registered for remote',
      async (channel) => {
        const handler = vi.fn().mockResolvedValue('should-not-be-called')
        // Register it with its pinned capability — the only capability the
        // registry will accept for these channels.
        registry.register({
          channel,
          capability: PINNED_CAPABILITIES[channel],
          kind: 'query',
          transport: 'remote',
          handler
        })

        await expect(dispatcher.handle(req(channel), remoteConn)).rejects.toThrow(
          /Permission denied/
        )
        expect(handler).not.toHaveBeenCalled()
      }
    )

    /**
     * The engine-vendor channels ADR-056 moved from `admin` to `config`.
     *
     * S4 (ADR-057) then REGISTERED them on the remote transport too (the S1b
     * sweep had deferred this last family), so they are no longer desktop-only —
     * but the invariant this block pins is unchanged and independent of
     * registration: a `config` channel is grantable, and a grantable capability
     * may NEVER be pinned (the pin table's one guarantee is that every entry
     * names a capability the base grant set lacks). So none of these appear in
     * `PINNED_CAPABILITIES`, before or after they became remote-reachable.
     */
    const ENGINE_VENDOR_NEVER_PINNED = [
      'auth:sign-in',
      'auth:submit-code',
      'auth:cancel',
      'account:set-enabled',
      'account:add',
      'account:switch',
      'account:delete',
      'usage:refresh-prices'
    ] as const

    it.each(ENGINE_VENDOR_NEVER_PINNED)(
      '"%s" is not PINNED — a grantable capability may never be pinned',
      (channel) => {
        expect(PINNED_CAPABILITIES[channel]).toBeUndefined()
      }
    )

    it('refuses to register a pinned channel under a granted capability', () => {
      expect(() =>
        registry.register({
          channel: 'terminal:create',
          capability: 'chat',
          kind: 'command',
          transport: 'remote',
          handler: vi.fn()
        })
      ).toThrow(/pinned to "shell"/)
    })

    it('names the missing capability in the refusal', async () => {
      register('needs:admin', vi.fn(), 'admin')
      await expect(dispatcher.handle(req('needs:admin'), remoteConn)).rejects.toThrow(
        /requires the "admin" capability/
      )
    })
  })

  describe('handler outcomes', () => {
    it('resolves with handler return value on success (envelope built by caller)', async () => {
      register('echo', async (x: unknown) => ({ ok: true, data: x }))
      const result = await dispatcher.handle(req('echo', ['hello']), remoteConn)
      expect(result).toEqual({ ok: true, data: 'hello' })
    })

    it('propagates handler exceptions with a serializable string error', async () => {
      register('broken', async () => {
        throw new Error('boom')
      })

      let caught: unknown
      try {
        await dispatcher.handle(req('broken'), remoteConn)
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
      await expect(dispatcher.handle(malformed, remoteConn)).rejects.toThrow(
        /Channel not available/
      )

      // Dispatcher must remain usable for subsequent real requests.
      register('ping', async () => 'pong')
      await expect(dispatcher.handle(req('ping'), remoteConn)).resolves.toBe('pong')
    })

    it('routes concurrent requests independently without cross-talk', async () => {
      // Two handlers that resolve on different ticks — interleave to catch
      // any accidental shared state (e.g. "last request" variables).
      let resolveA: (v: string) => void = () => {}
      let resolveB: (v: string) => void = () => {}
      register('A', () => new Promise<string>((r) => (resolveA = r)))
      register('B', () => new Promise<string>((r) => (resolveB = r)))

      const pA = dispatcher.handle(req('A', [], 'id-a'), remoteConn)
      const pB = dispatcher.handle(req('B', [], 'id-b'), remoteConn)

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
// Guard: the FULL RemoteStatus stays desktop-only.
//
// `RemoteServer.notifyStatus()` pushes `remote:status` via
// `win.webContents.send` (the real desktop window, not the RemoteBridge), and
// no `remote:*` channel is registered for the remote transport EXCEPT the
// redacted `remote:status-view` (owner ruling, 2026-08-28) — and unregistered
// channels are unreachable. Together that means widening `RemoteStatus`
// (Phase 2 added `authMethods`; Phase 3 added tls/clientLogins) cannot leak
// server internals or one remote user's identity to another: the new field is
// invisible remotely until somebody adds it to `remoteStatusView()`'s explicit
// pick list, which is a reviewed edit.
//
// The scan covers BOTH files that can contribute a remote registration in this
// namespace — the registrar and the shared declaration module it spreads —
// because a scan that only read the registrar would report "no remote:*" while
// a spread quietly added one.
//
// This is a source-level assertion on purpose: importing remote-handlers.ts
// pulls in the SDK + every service, which a unit test must not do.
// ---------------------------------------------------------------------------

describe('remote-handlers registration surface (guard)', () => {
  const HANDLERS_PATH = resolve(__dirname, '../../../core/ipc/remote-handlers.ts')
  const VIEW_PATH = resolve(__dirname, '../../../core/ipc/remote-view-commands.ts')
  const sources = (): string[] => [HANDLERS_PATH, VIEW_PATH].map((p) => readFileSync(p, 'utf-8'))

  it('registers exactly one remote:* channel — the redacted read — for the remote transport', () => {
    const src = sources().join('\n')
    // Every registration in these files goes through `channel: '<channel>'`.
    const registered = [...src.matchAll(/channel:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(registered.length).toBeGreaterThan(50) // non-vacuity: we did parse it
    // A `query` carrying no link fields. Every MUTATION in the namespace —
    // start/stop/set-config/set-password/clear-password/force-reserve — stays
    // raw `ipcMain.handle` on the host anchor, which is what keeps a remote
    // client from cutting the connection it is riding.
    expect(registered.filter((c) => c.startsWith('remote:'))).toEqual(['remote:status-view'])
  })

  it('registers no remote:* channel via a template/computed channel name either', () => {
    for (const src of sources()) {
      // A backtick channel or a `'remote:' + x` concatenation would slip past the
      // literal scan above.
      expect(src).not.toMatch(/channel:\s*`remote:/)
      expect(src).not.toMatch(/['"`]remote:['"`]\s*\+/)
    }
  })
})
