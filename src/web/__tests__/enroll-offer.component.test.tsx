/**
 * @vitest-environment jsdom
 *
 * The post-password ENROLLMENT OFFER gate, driven through the real web-client
 * entry (`src/web/main.tsx`) rather than through `EnrollPrompt` in isolation.
 *
 * ## Why the whole entry module
 *
 * `EnrollPrompt`'s own tests (`passkey-screens.component.test.tsx`) cover what
 * the strip DOES once it is on screen. Nothing covered WHETHER it goes on
 * screen — the four-way conjunction in main.tsx — and that conjunction is
 * assembled from three different layers: a wire field on `auth-response`, a
 * per-socket value on the transport, and two browser facts. The only honest
 * place to pin it is the module that computes it, so this file imports
 * `main.tsx` (which mounts itself into `#root`) and drives the ACTUAL sign-in
 * the owner performs: discovery → the passkey screen → "use password instead" →
 * a real scrypt proof → `auth-response` → `sync-full`.
 *
 * The only fakes are the two ends: a scripted `WebSocket` and `fetch`. Between
 * them runs the real phase machine, the real `RemoteConnection`, and the real
 * gate.
 *
 * The App chunk and the replica store are stubbed because neither participates
 * in the decision and both would drag the entire renderer into a jsdom process.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'
import type { RemoteAuthMethod } from '../../shared/remote-protocol'

vi.mock('@renderer/App', () => ({ default: () => <div data-testid="FakeApp">app</div> }))
vi.mock('@renderer/stores/replica', () => ({
  startReplica: () => {},
  hydrateReplica: () => {}
}))

/** The scripted socket the client transport talks to. */
class FakeSocket {
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

/** Deliberately cheap KDF params — the derivation itself is not under test. */
const KDF = { algo: 'scrypt', N: 16, r: 1, p: 1, dkLen: 32 } as const

interface SignInOptions {
  /** What the server says it accepted. */
  method: RemoteAuthMethod
  /** Whether the accept carries `webauthnCapableOrigin` (absent when false). */
  capableOrigin: boolean
}

/**
 * Run the owner's exact sign-in through the mounted entry module and settle on
 * `connected`.
 */
async function signInWithPassword(opts: SignInOptions): Promise<void> {
  await act(async () => {
    await import('../main')
  })

  // Discovery advertises a passkey, so the client leads with the one-tap screen
  // — the screen the owner's break-glass login actually starts from.
  await waitFor(() => expect(screen.getByTestId('PasskeyLogin')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByTestId('PasskeyLogin.usePassword'))
  })
  await waitFor(() => expect(screen.getByTestId('PasswordLogin')).toBeTruthy())

  await act(async () => {
    fireEvent.change(screen.getByTestId('PasswordLogin.input'), { target: { value: 'hunter22' } })
    fireEvent.click(screen.getByTestId('PasswordLogin.submit'))
  })

  // scrypt runs before the socket is opened.
  await waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 8000 })
  const ws = FakeSocket.last!
  await act(async () => {
    ws.onopen?.()
  })
  await act(async () => {
    ws.deliver({
      type: 'auth-response',
      ok: true,
      method: opts.method,
      // ABSENT, not `false`, when the origin cannot bind — presence is the whole
      // test on the wire, and this fake has to say it the way the server does.
      ...(opts.capableOrigin ? { webauthnCapableOrigin: true } : {})
    })
  })
  await act(async () => {
    ws.deliver({
      type: 'sync-full',
      epoch: 1,
      state: { seq: 0, sessions: {}, ui: {}, config: {} }
    })
  })
  // `connected` is set from `sync-full`, so the gate has now been evaluated.
  await waitFor(() => expect(screen.queryByTestId('ConnectionOverlay')).toBeTruthy())
}

describe('the post-password enrollment offer (main.tsx gate)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    FakeSocket.last = null
    // A WebAuthn-capable BROWSER. Both halves are asserted separately below;
    // this is the baseline every case shares unless it overrides it.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    ;(window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {}
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 1,
          methods: ['password'],
          password: { saltHex: 'aa', kdf: KDF },
          webauthn: { rpId: 'localhost' }
        })
      }))
    )
    // Every case must start from a device that has NOT dismissed the offer, or
    // the latch would silently make the negative cases vacuous.
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('offers enrollment after a password sign-in on a server-declared CAPABLE origin', async () => {
    await signInWithPassword({ method: 'password', capableOrigin: true })
    expect(screen.queryByTestId('EnrollPrompt')).not.toBeNull()
  }, 30_000)

  /**
   * THE TUNNEL ROW, and the reason the origin gate moved to the server.
   *
   * A Cloudflare tunnel page is HTTPS: `window.isSecureContext` is true and
   * `PublicKeyCredential` exists, so every browser-side test the old gate ran
   * passes — and no credential minted there could ever verify, because the RP ID
   * would be an ephemeral `*.trycloudflare.com` name. RED before the fix, where
   * the browser's own answer was the origin gate.
   */
  it('does NOT offer on a non-capable origin, even in a fully capable browser (GUARD)', async () => {
    await signInWithPassword({ method: 'password', capableOrigin: false })
    expect(screen.queryByTestId('EnrollPrompt')).toBeNull()
  }, 30_000)

  /**
   * The browser condition SURVIVES as a second gate rather than being replaced.
   * It is load-bearing for one real origin: `http://<tailnet-dns>:<port>` — the
   * plain-HTTP LAN address of the same machine — is a capable HOST by
   * `resolveWebauthnOrigin` (which only sees the name) while the page is not a
   * secure context and cannot run a ceremony at all.
   */
  it('does NOT offer when the BROWSER cannot ceremony, on a capable origin (GUARD)', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    await signInWithPassword({ method: 'password', capableOrigin: true })
    expect(screen.queryByTestId('EnrollPrompt')).toBeNull()
  }, 30_000)

  it('does NOT offer to a connection that already signed in with a passkey', async () => {
    await signInWithPassword({ method: 'webauthn', capableOrigin: true })
    expect(screen.queryByTestId('EnrollPrompt')).toBeNull()
  }, 30_000)

  it('does NOT offer once this device has dismissed it', async () => {
    window.localStorage.setItem('claudeui.remote.enrollPromptDismissed', '1')
    await signInWithPassword({ method: 'password', capableOrigin: true })
    expect(screen.queryByTestId('EnrollPrompt')).toBeNull()
  }, 30_000)

  it('dismissing removes the strip and latches the refusal for this device', async () => {
    await signInWithPassword({ method: 'password', capableOrigin: true })
    await act(async () => {
      fireEvent.click(screen.getByTestId('EnrollPrompt.dismiss'))
    })
    expect(screen.queryByTestId('EnrollPrompt')).toBeNull()
    expect(window.localStorage.getItem('claudeui.remote.enrollPromptDismissed')).toBe('1')
  }, 30_000)
})
