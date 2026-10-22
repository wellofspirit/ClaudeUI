/**
 * @vitest-environment jsdom
 *
 * A passkey sign-in must show the full-sync overlay (and its progress bar), not
 * the passkey button.
 *
 * `main.tsx` renders `PasskeyLogin` for the whole `phase.kind === 'passkey'`
 * time, and that phase used to be retired only at `connected`. The sync that
 * follows an accepted ceremony is the LONG part of a phone sign-in, so the
 * owner's main path (tailnet + passkey) sat on a sign-in button for the whole
 * transfer with no bar at all. The fix is in `handleStateChange`: `syncing`
 * retires the ceremony phase, and this test drives the real entry through it.
 *
 * Harness borrowed from `sync-timing-relay.component.test.tsx` (the real
 * phase machine + `RemoteConnection` over a scripted socket); the App chunk and
 * the replica are stubbed because neither participates in the decision.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, fireEvent, screen } from '@testing-library/react'
import { act } from 'react'
import { PASSKEY_REQUIRED_ERROR } from '../../shared/remote-protocol'

vi.mock('@renderer/App', () => ({ default: () => <div data-testid="FakeApp">app</div> }))
vi.mock('@renderer/stores/replica', () => ({
  startReplica: () => {},
  hydrateReplica: () => ({ reloadActive: null, fillResumed: [] }),
  onReplicaApplied: () => () => {},
  getReplicaState: () => ({ sessions: {} }),
  resolveRekeyed: (id: string) => id
}))
vi.mock('@renderer/utils/projection-audit', () => ({ startProjectionAudit: () => {} }))
vi.mock('@renderer/lib/session-history-load', () => ({ finishHydrate: () => {} }))
vi.mock('@renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ refreshProviderAuth: async () => {} }) }
}))

class FakeSocket {
  // `connection.ts` compares `readyState` to `WebSocket.OPEN`, which is this class here.
  static OPEN = 1
  static last: FakeSocket | null = null
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readyState = 1
  sent: string[] = []
  constructor(public url: string) {
    FakeSocket.last = this
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const KDF = { algo: 'scrypt', N: 16, r: 1, p: 1, dkLen: 32 } as const

/**
 * The server advertises a passkey, so the entry leads with the one-tap screen —
 * the path the owner's phone takes.
 */
async function openPasskeyScreen(): Promise<FakeSocket> {
  await act(async () => {
    await import('../main')
  })
  await waitFor(() => expect(screen.getByTestId('PasskeyLogin')).toBeTruthy())

  // The tap is what connects (and, on a live socket, fires the ceremony).
  await act(async () => {
    fireEvent.click(screen.getByTestId('PasskeyLogin.submit'))
  })
  await waitFor(() => expect(FakeSocket.last).not.toBeNull())
  const ws = FakeSocket.last!
  await act(async () => {
    ws.onopen?.()
  })
  // This fresh socket has no identity: the host asks for the ceremony.
  await act(async () => {
    ws.deliver({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
  })
  expect(await screen.findByTestId('PasskeyLogin')).toBeInTheDocument()
  return ws
}

describe('web client — the sync after a passkey sign-in', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    FakeSocket.last = null
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 1,
          methods: ['webauthn'],
          webauthn: { rpId: 'localhost' },
          password: { saltHex: 'aa', kdf: KDF }
        })
      }))
    )
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows the sync overlay with its progress bar, not the passkey button', async () => {
    const ws = await openPasskeyScreen()

    // The ceremony is accepted. `syncing` follows immediately (auth-response
    // before `sendSync`), and it lasts until the snapshot has been applied.
    await act(async () => {
      ws.deliver({ type: 'auth-response', ok: true, method: 'webauthn' })
    })

    await waitFor(() => expect(screen.getByTestId('ConnectionOverlay')).toBeTruthy())
    expect(screen.getByTestId('ConnectionOverlay')).toHaveTextContent('Syncing state...')
    // Indeterminate until the first chunk announces the total — but PRESENT,
    // which is the whole point: the sign-in screen is gone.
    expect(screen.getByTestId('ConnectionOverlay.syncProgress')).toBeInTheDocument()
    expect(screen.queryByTestId('PasskeyLogin')).toBeNull()
  }, 30_000)
})
