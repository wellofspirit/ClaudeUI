/**
 * @vitest-environment node
 *
 * `remote:status-view` — the redacted status read (owner ruling, 2026-08-28).
 *
 * The channel exists so a connected web client can SEE the listener it rides
 * (running state, port, who else is connected) without being able to touch it.
 * Two properties carry that, and both are asserted here:
 *
 *  1. **The redaction is exact.** The view's keys are `RemoteStatusView`'s keys —
 *     no more, no less — and none of `RemoteStatus`'s secret-bearing fields
 *     (`lanUrl` / `tunnelUrl`, which carry channel keys in their fragments, plus
 *     `tunnelError` and `tls.url` / `tls.serveError` / `tls.detectionMessage`,
 *     which are free text naming the tunnel host, the tailnet name or a
 *     device-authorization URL) survives into it — by VALUE, not just by key.
 *  2. **It is a read.** `config` + `query` on both transports, and the only
 *     `remote:*` channel with a registration at all. The absence of the
 *     mutations from the remote surface is pinned in
 *     `remote-handlers.ipc.test.ts`, against the live registry.
 *
 * The audit sink is mocked, as in `automation-commands.test.ts`, so this stays a
 * pure unit test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../../core/services/db', () => ({ appendAuditLog }))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  remoteStatusView,
  remoteViewCommands,
  type RemoteStatusHost
} from '../../../core/ipc/remote-view-commands'
import {
  CommandRegistry,
  makeRemoteConnection,
  AUTH_OFF_GRANTS,
  ENROLL_ONLY_GRANTS
} from '../../../core/ipc/command-registry'
import type { RemoteStatus, RemoteStatusView, RemoteTlsStatusView } from '../../../shared/types'

/**
 * A status with EVERY field populated, and every secret-bearing one carrying a
 * marker string. The absence assertions below search the serialized view for
 * those markers, so a field that leaks through a future edit fails here even if
 * it arrives under a name this file never mentions.
 */
const FULL_STATUS: RemoteStatus = {
  running: true,
  port: 4321,
  lanUrl: 'http://192.168.1.9:4321/remote#k=LANCHANNELKEY',
  tunnelUrl: 'https://calm-fox.trycloudflare.com/remote#k=TUNNELCHANNELKEY',
  tunnelState: 'connected',
  tunnelError: 'calm-fox.trycloudflare.com refused the connection',
  connectedClients: 2,
  clientIps: ['192.168.1.20', '100.64.0.7'],
  clientLogins: [null, 'owner@example.com'],
  tls: {
    mode: 1,
    httpsPort: 443,
    pinnedHttpsPort: 443,
    serveError: {
      reason: 'not-ready',
      message: 'Log in at https://login.tailscale.com/a/DEVICEKEY'
    },
    url: 'https://box.tailscale-name.ts.net',
    detection: 'ok',
    detectionMessage: 'Log in at https://login.tailscale.com/a/DEVICEKEY'
  },
  lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:4321',
  authMethods: ['password', 'tailnet-identity']
}

/**
 * The view's key set, as a MAPPED type over `RemoteStatusView`: the compiler
 * refuses a missing or extra entry, so this literal cannot drift from the type
 * it pins, and the runtime comparison below therefore checks the PICK LIST
 * against the declared shape rather than against a hand-copied list.
 */
const VIEW_KEYS: Record<keyof RemoteStatusView, true> = {
  running: true,
  port: true,
  connectedClients: true,
  clientIps: true,
  clientLogins: true,
  tunnelState: true,
  authMethods: true,
  lastError: true,
  tls: true
}

const TLS_VIEW_KEYS: Record<keyof RemoteTlsStatusView, true> = {
  mode: true,
  httpsPort: true,
  pinnedHttpsPort: true,
  detection: true
}

/** The registry as boot wires it: one declaration, both transports. */
function registryWithView(host: RemoteStatusHost | null): CommandRegistry {
  const registry = new CommandRegistry()
  for (const cmd of remoteViewCommands(host)) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

const hostStub: RemoteStatusHost = { getStatus: () => FULL_STATUS }

beforeEach(() => {
  appendAuditLog.mockClear()
})

describe('remoteStatusView (the redaction)', () => {
  it('picks exactly the keys RemoteStatusView declares', () => {
    const view = remoteStatusView(FULL_STATUS)
    expect(Object.keys(view).sort()).toEqual(Object.keys(VIEW_KEYS).sort())
    expect(Object.keys(view.tls!).sort()).toEqual(Object.keys(TLS_VIEW_KEYS).sort())
  })

  it('copies the readable facts through unchanged', () => {
    expect(remoteStatusView(FULL_STATUS)).toEqual({
      running: true,
      port: 4321,
      connectedClients: 2,
      clientIps: ['192.168.1.20', '100.64.0.7'],
      clientLogins: [null, 'owner@example.com'],
      tunnelState: 'connected',
      authMethods: ['password', 'tailnet-identity'],
      lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:4321',
      tls: { mode: 1, httpsPort: 443, pinnedHttpsPort: 443, detection: 'ok' }
    })
  })

  it('drops lanUrl / tunnelUrl and everything derived from them (GUARD)', () => {
    const view = remoteStatusView(FULL_STATUS) as unknown as Record<string, unknown>
    for (const key of ['lanUrl', 'tunnelUrl', 'tunnelError']) {
      expect(key in view, `${key} must not be on the view`).toBe(false)
    }
    const tls = view.tls as Record<string, unknown>
    for (const key of ['url', 'serveError', 'detectionMessage']) {
      expect(key in tls, `tls.${key} must not be on the view`).toBe(false)
    }
    // By VALUE too: the channel keys, the tunnel hostname, the tailnet name and
    // the device-authorization URL must not reach the wire under ANY key.
    const wire = JSON.stringify(view)
    for (const secret of [
      'LANCHANNELKEY',
      'TUNNELCHANNELKEY',
      'trycloudflare.com',
      'box.tailscale-name.ts.net',
      'DEVICEKEY'
    ]) {
      expect(wire, `${secret} leaked into the view`).not.toContain(secret)
    }
  })

  it('keeps tls null when the run is not in TLS mode', () => {
    expect(remoteStatusView({ ...FULL_STATUS, tls: null }).tls).toBeNull()
  })

  it('copies the client arrays rather than aliasing the server’s', () => {
    const view = remoteStatusView(FULL_STATUS)
    expect(view.clientIps).not.toBe(FULL_STATUS.clientIps)
    expect(view.clientLogins).not.toBe(FULL_STATUS.clientLogins)
    expect(view.authMethods).not.toBe(FULL_STATUS.authMethods)
  })
})

describe('remote:status-view registration', () => {
  it('declares config/query on both transports, and nothing else', () => {
    const registry = registryWithView(hostStub)
    expect(registry.channels('remote')).toEqual(['remote:status-view'])
    expect(registry.channels('desktop')).toEqual(['remote:status-view'])
    expect(registry.declaration('remote:status-view')).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
    // `config` IS in the base grant set: seeing the listener you are already
    // talking to is a read, not administration.
    expect(AUTH_OFF_GRANTS.has('config')).toBe(true)
  })

  it('registers no mutation — the self-kill protection is structural', () => {
    // The declarations this module contributes are exactly one READ. A
    // `remote:start` / `stop` / `set-config` here would be the whole point of
    // the ruling undone, and it would be reachable, because `config` is granted
    // to every authenticated connection.
    for (const cmd of remoteViewCommands(hostStub)) {
      expect(cmd.kind, cmd.channel).toBe('query')
    }
    expect(remoteViewCommands(hostStub).map((c) => c.channel)).toEqual(['remote:status-view'])
  })

  it('answers the redacted view over the remote transport', async () => {
    const registry = registryWithView(hostStub)
    const conn = makeRemoteConnection('password', 'owner@example.com')
    const result = await registry.dispatch('remote:status-view', 'remote', [], conn)
    expect(result).toEqual(remoteStatusView(FULL_STATUS))
    // A query is not audited (sync-core.md: reads have no state effect).
    expect(appendAuditLog).not.toHaveBeenCalled()
  })

  it('is refused without `config` — an enrollment link cannot read it', async () => {
    const registry = registryWithView(hostStub)
    const conn = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)
    await expect(registry.dispatch('remote:status-view', 'remote', [], conn)).rejects.toThrow(
      /requires the "config" capability/
    )
  })

  it('registers but THROWS with no server, rather than claiming "not running"', async () => {
    // The channel set must not depend on runtime configuration (the same rule
    // `webauthn:mint-enroll-token` follows), and a fabricated "stopped" reading
    // would be a claim this process is in no position to make.
    const registry = registryWithView(null)
    expect(registry.channels('remote')).toEqual(['remote:status-view'])
    await expect(
      registry.dispatch(
        'remote:status-view',
        'remote',
        [],
        makeRemoteConnection('password', 'owner@example.com')
      )
    ).rejects.toThrow(/unavailable/)
  })
})
