/**
 * Layer 1 unit tests for the web ClaudeAPI adapter.
 *
 * Focus: the git live-watching methods. They used to be `async () => {}`
 * no-ops ("Git polling not supported in remote"), so `gitStatus` in the store
 * stayed null forever and GitChangesPill — which bails on a null status — never
 * rendered on the remote web client at any width. They now invoke the real
 * channels, which the remote server routes into the shared gitWatchRegistry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWebSocketApi } from '../api-adapter'
import { SyncClient } from '../../shared/sync/sync-client'
import type { RemoteConnection } from '../connection'

type FakeConnection = {
  invoke: ReturnType<typeof vi.fn>
  on: RemoteConnection['on']
  passkeyAvailable: ReturnType<typeof vi.fn>
  stepUpWithPasskey: ReturnType<typeof vi.fn>
  whenCredentialsChanged: ReturnType<typeof vi.fn>
  /** Push a server event to the api's listeners. */
  push: (channel: string, ...args: unknown[]) => void
  /** Fire the close-4008 waiter the password-rotation path races against. */
  closeWithCredentialsChanged: () => void
}

/**
 * Fake transport around the REAL protocol core — the adapter now registers its
 * listeners on the connection's SyncClient, so `push` delivers an event exactly
 * the way a server frame does (readiness gate opened: the app is "mounted").
 */
function makeConnection(): FakeConnection {
  const sync = new SyncClient({ requestResync: () => {} })
  sync.markReady()
  let seq = 0
  const credentialsChangedWaiters: (() => void)[] = []
  return {
    invoke: vi.fn(async () => undefined),
    on: (channel) => sync.on(channel),
    passkeyAvailable: vi.fn(() => false),
    stepUpWithPasskey: vi.fn(async () => ({ type: 'step-up-response', ok: true })),
    whenCredentialsChanged: vi.fn(
      () => new Promise<void>((resolve) => credentialsChangedWaiters.push(resolve))
    ),
    push: (channel, ...args) => sync.receiveEvent({ seq: ++seq, channel, args }),
    closeWithCredentialsChanged: () => {
      for (const resolve of credentialsChangedWaiters.splice(0)) resolve()
    }
  }
}

let connection: FakeConnection
let api: ReturnType<typeof createWebSocketApi>

beforeEach(() => {
  connection = makeConnection()
  api = createWebSocketApi(connection as unknown as RemoteConnection)
})

describe('web api-adapter — git live watching', () => {
  it('gitStartWatching invokes git:start-watching with the cwd (GUARD)', async () => {
    await api.gitStartWatching('/repo/app')
    expect(connection.invoke).toHaveBeenCalledWith('git:start-watching', '/repo/app')
  })

  it('gitStopWatching invokes git:stop-watching with the cwd (GUARD)', async () => {
    await api.gitStopWatching('/repo/app')
    expect(connection.invoke).toHaveBeenCalledWith('git:stop-watching', '/repo/app')
  })

  it('surfaces a safeHandler error envelope as a rejection', async () => {
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'not a repo' })
    await expect(api.gitStartWatching('/repo/app')).rejects.toThrow('not a repo')
  })

  // The `git:status-update` DELIVERY test moved out of this file with SyncCore
  // phase 4c: the adapter no longer subscribes to replicated channels at all
  // (`shared/sync/client-registry` does, for both clients), so asserting it here
  // would only be re-testing `SyncClient.on`. What remains in this file is the
  // INVOKE surface, which 4c did not touch.
})

describe('web api-adapter — passkeys (ADR-052)', () => {
  it('maps all SIX verbs to their channels (GUARD: this is the only surface with the two register verbs)', async () => {
    await api.webauthnCredentials()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:credentials')
    await api.webauthnRename('cred-1', 'Phone')
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:rename', 'cred-1', 'Phone')
    await api.webauthnRevoke('cred-1')
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:revoke', 'cred-1')
    await api.webauthnMintEnrollToken()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:mint-enroll-token')
    await api.webauthnRegisterOptions()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:register-options')
    const payload = { response: { id: 'c' }, nickname: null } as never
    await api.webauthnRegisterVerify(payload)
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:register-verify', payload)
  })

  it('never unwraps a webauthn result (they are not safeHandler envelopes)', async () => {
    // `webauthn:register-verify` legitimately answers `{ok:false, error}` as
    // DATA. Routing it through `unwrap()` would turn a "that key did not
    // verify" answer into a thrown transport error and lose the reason.
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'malformed' })
    await expect(api.webauthnRegisterVerify({ response: {} } as never)).resolves.toEqual({
      ok: false,
      error: 'malformed'
    })
  })

  it('merges the client-side passkey hint into terminal availability', async () => {
    connection.invoke.mockResolvedValueOnce({
      allowed: true,
      granted: false,
      needsStepUp: true,
      stepUp: null
    })
    connection.passkeyAvailable.mockReturnValue(true)
    // The host cannot answer this: whether a ceremony is possible depends on
    // this browser's origin and this socket's auth method, neither of which
    // `terminal:availability` knows about.
    await expect(api.terminalAvailability()).resolves.toMatchObject({
      needsStepUp: true,
      passkey: true
    })
  })

  it('passkey step-up goes through the connection, with no local pre-checks', async () => {
    connection.stepUpWithPasskey.mockResolvedValue({
      type: 'step-up-response',
      ok: false,
      code: 'throttled',
      error: 'Too many attempts',
      retryable: false
    })
    await expect(api.terminalStepUpPasskey()).resolves.toEqual({
      ok: false,
      code: 'throttled',
      error: 'Too many attempts',
      retryable: false,
      expiresAt: undefined
    })
    // Unlike the password path, nothing is probed first — the challenge request
    // IS the probe, and guessing client-side could only guess wrong.
    expect(connection.invoke).not.toHaveBeenCalled()
  })
})

describe('web api-adapter — remote-access settings (ADR-054 decision 6)', () => {
  it('READS the config over `authcfg:get`, not the host-anchor channel', async () => {
    // "Routine settings become web-reachable" is unimplementable without a read:
    // a pane cannot administer a surface it cannot render. `authcfg:get` is a
    // QUERY, so it costs no ceremony — the operator sees the tier before being
    // asked to prove presence in order to change it.
    connection.invoke.mockResolvedValueOnce({ stepUpTier: 'strong' })
    await expect(api.getRemoteConfig()).resolves.toMatchObject({ stepUpTier: 'strong' })
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:get')
  })

  it('REFUSES the host-anchor writer locally — it is never on the wire', async () => {
    // `remote:set-config` is the only writer that can reach the `off` master
    // switch and has no remote registration at all. Refusing here (rather than
    // invoking and letting the registry deny it) is what lets the settings pane
    // say WHY, and keeps the structural guarantee visible in this file.
    await expect(api.setRemoteConfig({ authPolicy: 'off' })).rejects.toThrow(/on the host/i)
    await expect(api.setRemotePassword('x')).rejects.toThrow(/Not available in remote mode/)
    await expect(api.clearRemotePassword()).rejects.toThrow(/Not available in remote mode/)
    expect(connection.invoke).not.toHaveBeenCalled()
  })

  it('maps the routine verbs to their channels', async () => {
    // ONE save verb, not one per field (ADR-054 §6 amendment): the editor is a
    // mode, so a Save is a batch.
    connection.invoke.mockResolvedValueOnce({ ok: true, config: { stepUpTier: 'strong' } })
    await api.authcfgApply({ stepUpTier: 'strong', auditRetentionDays: 90 })
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:apply', {
      stepUpTier: 'strong',
      auditRetentionDays: 90
    })
    await api.authcfgEnd()
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:end')
  })

  describe('password rotation — success and disconnection are the same event', () => {
    it('resolves on the normal response (a passkey actor is not disconnected)', async () => {
      connection.invoke.mockResolvedValueOnce({ ok: true })
      await expect(api.authcfgSetPassword('a-long-enough-password')).resolves.toEqual({ ok: true })
      expect(connection.invoke).toHaveBeenCalledWith(
        'authcfg:set-password',
        'a-long-enough-password'
      )
    })

    it('resolves on close-4008 when the ACTOR held the password it rotated', async () => {
      // The server drops every socket holding the old password — the caller
      // included — BEFORE the invoke response goes out. Without the race this
      // would sit out the 30-second invoke timeout on a rotation that worked
      // perfectly, and report a failure for it.
      connection.invoke.mockImplementationOnce(() => new Promise(() => {}))
      const rotating = api.authcfgSetPassword('a-long-enough-password')
      connection.closeWithCredentialsChanged()
      await expect(rotating).resolves.toEqual({ ok: true })
    })

    it('still REJECTS a refused rotation — the close is what never comes', async () => {
      // A dismissed step-up, or a password the server calls too weak: the invoke
      // settles with an error and no socket closes, so the race has one runner.
      connection.invoke.mockRejectedValueOnce(new Error('needs-step-up'))
      await expect(api.authcfgSetPassword('short')).rejects.toThrow('needs-step-up')
    })
  })
})
