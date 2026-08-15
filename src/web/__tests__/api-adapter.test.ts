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
  /** Push a server event to the api's listeners. */
  push: (channel: string, ...args: unknown[]) => void
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
  return {
    invoke: vi.fn(async () => undefined),
    on: (channel) => sync.on(channel),
    passkeyAvailable: vi.fn(() => false),
    stepUpWithPasskey: vi.fn(async () => ({ type: 'step-up-response', ok: true })),
    push: (channel, ...args) => sync.receiveEvent({ seq: ++seq, channel, args })
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
