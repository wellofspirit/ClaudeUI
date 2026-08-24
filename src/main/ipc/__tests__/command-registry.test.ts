/**
 * @vitest-environment node
 *
 * SyncCore phase 1 — the command registry: fail-closed registration, capability
 * gating, and the audit interceptor.
 *
 * The audit sink (db.appendAuditLog) is mocked so these stay pure unit tests;
 * the repository itself is covered in services/__tests__/db-audit-log.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../../core/services/db', () => ({ appendAuditLog }))

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({ logger: loggerSpies }))

import {
  CommandRegistry,
  AUTH_OFF_GRANTS,
  ALL_GRANTS,
  PINNED_CAPABILITIES,
  hostConnection,
  makeRemoteConnection,
  type CommandRegistration
} from '../../../core/ipc/command-registry'
import { isEnrollNotPermittedError } from '../../../shared/remote-protocol'

let registry: CommandRegistry

beforeEach(() => {
  registry = new CommandRegistry()
  appendAuditLog.mockClear()
  loggerSpies.error.mockClear()
})

const remoteConn = makeRemoteConnection('password', 'owner@example.com')

/** Register with sane defaults; `reg` overrides any field. */
function reg(overrides: Partial<CommandRegistration> = {}): CommandRegistration {
  return {
    channel: 'test:channel',
    capability: 'chat',
    kind: 'command',
    transport: 'remote',
    handler: vi.fn(async () => 'ok'),
    ...overrides
  } as CommandRegistration
}

describe('registration is fail-closed', () => {
  it('throws when no capability is declared (the compile error is belt; this is braces)', () => {
    // A JS caller — or an `as any` — can still omit it at runtime.
    expect(() => registry.register({ ...reg(), capability: undefined as any })).toThrow(
      /a declared capability is required/
    )
  })

  it('throws on an unknown capability', () => {
    expect(() => registry.register({ ...reg(), capability: 'superuser' as any })).toThrow(
      /a declared capability is required/
    )
  })

  it('throws on an invalid kind', () => {
    expect(() => registry.register({ ...reg(), kind: 'mutation' as any })).toThrow(
      /kind must be 'command' or 'query'/
    )
  })

  it('throws when a handler is missing', () => {
    expect(() => registry.register({ ...reg(), handler: undefined as any })).toThrow(
      /handler must be a function/
    )
  })

  it('refuses a capability that contradicts the pinned one', () => {
    expect(() => registry.register(reg({ channel: 'terminal:write', capability: 'chat' }))).toThrow(
      /pinned to "shell"/
    )
    // The pinned capability itself registers fine.
    expect(() =>
      registry.register(reg({ channel: 'terminal:write', capability: 'shell' }))
    ).not.toThrow()
  })

  it('refuses a second transport that disagrees about the declaration', () => {
    registry.register(reg({ channel: 'x:y', capability: 'git', kind: 'command' }))
    expect(() =>
      registry.register(reg({ channel: 'x:y', capability: 'config', transport: 'desktop' }))
    ).toThrow(/declaration conflicts/)
    expect(() =>
      registry.register(
        reg({ channel: 'x:y', capability: 'git', kind: 'query', transport: 'desktop' })
      )
    ).toThrow(/declaration conflicts/)
    // Agreeing is fine — that's the shared-channel case.
    expect(() =>
      registry.register(
        reg({ channel: 'x:y', capability: 'git', kind: 'command', transport: 'desktop' })
      )
    ).not.toThrow()
  })

  it('replaces the handler when the same (channel, transport) re-registers', async () => {
    const first = vi.fn(async () => 'first')
    const second = vi.fn(async () => 'second')
    registry.register(reg({ handler: first }))
    registry.register(reg({ handler: second }))
    await expect(registry.dispatch('test:channel', 'remote', [], remoteConn)).resolves.toBe(
      'second'
    )
    expect(first).not.toHaveBeenCalled()
  })
})

describe('lookup', () => {
  it('resolves per transport and lists channels sorted', () => {
    registry.register(reg({ channel: 'b:one' }))
    registry.register(reg({ channel: 'a:two', transport: 'desktop' }))

    expect(registry.get('b:one', 'remote')?.capability).toBe('chat')
    expect(registry.get('b:one', 'desktop')).toBeUndefined()
    expect(registry.channels('remote')).toEqual(['b:one'])
    expect(registry.channels('desktop')).toEqual(['a:two'])
    expect(registry.channels()).toEqual(['a:two', 'b:one'])
  })

  it('unregister drops only that transport', () => {
    registry.register(reg({ channel: 'c:one' }))
    registry.register(reg({ channel: 'c:one', transport: 'desktop' }))
    registry.unregister('c:one', 'remote')
    expect(registry.get('c:one', 'remote')).toBeUndefined()
    expect(registry.get('c:one', 'desktop')).toBeDefined()
  })
})

describe('capability gating', () => {
  it('dispatches when the capability is granted', async () => {
    const handler = vi.fn(async (a: number, b: number) => a + b)
    registry.register(reg({ capability: 'git', handler }))
    await expect(registry.dispatch('test:channel', 'remote', [2, 3], remoteConn)).resolves.toBe(5)
    expect(handler).toHaveBeenCalledWith(2, 3)
  })

  it('refuses with a permission error when it is not, without running the handler', async () => {
    const handler = vi.fn()
    registry.register(reg({ capability: 'admin', handler }))
    await expect(registry.dispatch('test:channel', 'remote', [], remoteConn)).rejects.toThrow(
      /Permission denied: "test:channel" requires the "admin" capability/
    )
    expect(handler).not.toHaveBeenCalled()
    expect(appendAuditLog).not.toHaveBeenCalled()
  })

  it('preserves the historical wording for an unregistered channel', async () => {
    await expect(registry.dispatch('ghost:channel', 'remote', [], remoteConn)).rejects.toThrow(
      'Channel not available: ghost:channel'
    )
  })

  it('the host connection holds every capability', async () => {
    for (const capability of ALL_GRANTS) {
      expect(hostConnection().grants.has(capability)).toBe(true)
    }
    registry.register(reg({ channel: 'host:thing', capability: 'host', transport: 'desktop' }))
    await expect(registry.dispatch('host:thing', 'desktop', [], hostConnection())).resolves.toBe(
      'ok'
    )
  })

  // ADR-052 cross-pin. The web client renders "the first passkey has to be set
  // up from the desktop" off `isEnrollNotPermittedError`, which string-matches
  // the refusal THIS registry composes. Nothing else connects the two: reword
  // the message and that guidance silently becomes an unreachable branch, with
  // the operator getting a raw permission error on the one screen that was
  // supposed to explain the situation. So the predicate is exercised against a
  // REAL dispatch refusal here, not against a hand-typed copy of the wording.
  it('composes an `enroll` refusal the web client can still classify (GUARD)', async () => {
    registry.register(reg({ channel: 'webauthn:register-options', capability: 'enroll' }))
    registry.register(reg({ channel: 'webauthn:mint-enroll-token', capability: 'admin' }))

    const refusal = async (channel: string): Promise<unknown> =>
      await registry.dispatch(channel, 'remote', [], remoteConn).then(
        () => {
          throw new Error(`${channel} was not refused`)
        },
        (err) => err
      )

    expect(isEnrollNotPermittedError(await refusal('webauthn:register-options'))).toBe(true)
    // And NOT the `admin` twin, whose channel name also contains "enroll" —
    // classifying it would tell an operator to go enroll from the desktop when
    // what they actually lack is admin.
    expect(isEnrollNotPermittedError(await refusal('webauthn:mint-enroll-token'))).toBe(false)
  })

  it('the auth-off remote grant set excludes shell/admin/host', () => {
    expect([...AUTH_OFF_GRANTS].sort()).toEqual([
      'chat',
      'config',
      'fs-read',
      'git',
      'session-config'
    ])
    for (const capability of Object.values(PINNED_CAPABILITIES)) {
      expect(AUTH_OFF_GRANTS.has(capability)).toBe(false)
    }
  })
})

describe('audit', () => {
  it('appends one row per command, carrying the connection identity', async () => {
    registry.register(reg({ channel: 'session:send', capability: 'chat', sessionIdArg: 0 }))
    await registry.dispatch('session:send', 'remote', ['routing-1', 'hi'], remoteConn)

    expect(appendAuditLog).toHaveBeenCalledTimes(1)
    expect(appendAuditLog.mock.calls[0][0]).toMatchObject({
      connectionId: remoteConn.connectionId,
      // ADR-056: `password` is the method, and the tailnet login survives as the
      // LABEL — the username hint is what is left of ambient identity.
      method: 'password',
      label: 'owner@example.com',
      capability: 'chat',
      kind: 'command',
      channel: 'session:send',
      sessionId: 'routing-1',
      outcome: 'ok'
    })
    expect(typeof appendAuditLog.mock.calls[0][0].ts).toBe('number')
  })

  it('labels a connection by its method when there is no login hint', async () => {
    const anon = makeRemoteConnection('password', null)
    expect(anon.identity.label).toBe('password')
    expect(anon.connectionId).not.toBe(remoteConn.connectionId)
  })

  it('does not audit queries', async () => {
    registry.register(reg({ channel: 'git:status', capability: 'git', kind: 'query' }))
    await registry.dispatch('git:status', 'remote', ['/repo'], remoteConn)
    expect(appendAuditLog).not.toHaveBeenCalled()
  })

  // The two axes that both used to be spelled `desktop` and are now deliberately
  // different words: the TRANSPORT (which wire served the invoke) stays
  // `'desktop'`, while the identity METHOD is `'host'` and the SURFACE moves to
  // the label. On a headless box the same dispatch would read
  // `label: 'server-console'`.
  it('audits desktop-transport dispatches with method "host" / label "desktop-renderer"', async () => {
    registry.register(
      reg({ channel: 'claude:save-permissions', capability: 'config', transport: 'desktop' })
    )
    await registry.dispatch('claude:save-permissions', 'desktop', [], hostConnection())
    expect(appendAuditLog.mock.calls[0][0]).toMatchObject({
      method: 'host',
      label: 'desktop-renderer',
      outcome: 'ok'
    })
  })

  it('labels the console host surface without changing the method', () => {
    // Same METHOD (both are the host's own surface, so both are fully trusted
    // and hold every grant); different LABEL, which is the only thing a reader
    // needs to tell a renderer row from a console row.
    expect(hostConnection('server-console').identity).toMatchObject({
      method: 'host',
      label: 'server-console'
    })
    expect(hostConnection('server-console').grants).toBe(hostConnection().grants)
    // Distinct surfaces are distinct actors: sharing one connectionId would make
    // the trail claim the renderer and the console were one.
    expect(hostConnection('server-console').connectionId).not.toBe(hostConnection().connectionId)
    // …and each is memoized, so rows from one run group together.
    expect(hostConnection('server-console')).toBe(hostConnection('server-console'))
  })

  it('records sessionId only where the registration declares one', async () => {
    registry.register(reg({ channel: 'config:save-settings', capability: 'config' }))
    await registry.dispatch('config:save-settings', 'remote', ['not-a-routing-id'], remoteConn)
    expect(appendAuditLog.mock.calls[0][0].sessionId).toBeNull()
  })

  it('records outcome "error" when the handler throws, and rethrows', async () => {
    registry.register(
      reg({
        handler: async () => {
          throw new Error('boom')
        }
      })
    )
    await expect(registry.dispatch('test:channel', 'remote', [], remoteConn)).rejects.toThrow(
      'boom'
    )
    expect(appendAuditLog.mock.calls[0][0].outcome).toBe('error')
  })

  it('records outcome "error" for a safeHandler {ok:false} envelope', async () => {
    registry.register(reg({ handler: async () => ({ ok: false, error: 'nope' }) }))
    await registry.dispatch('test:channel', 'remote', [], remoteConn)
    expect(appendAuditLog.mock.calls[0][0].outcome).toBe('error')
  })

  it('a failing audit sink never fails the command', async () => {
    appendAuditLog.mockImplementationOnce(() => {
      throw new Error('db locked')
    })
    registry.register(reg())
    await expect(registry.dispatch('test:channel', 'remote', [], remoteConn)).resolves.toBe('ok')
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'command-registry',
      expect.stringContaining('audit append failed')
    )
  })
})
