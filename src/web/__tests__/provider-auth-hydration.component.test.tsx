/**
 * @vitest-environment jsdom
 *
 * The web client's ONE read of the ChatGPT auth view (ADR-068 §3, Slice 7 review).
 *
 * ## The bug this pins
 *
 * Slice 6 gave the model picker and the composer hint a `providerAuth` slice,
 * filled by `refreshProviderAuth()` — which reads `provider-registry:list`,
 * because the answer is NOT in the sync snapshot. On the desktop that call hangs
 * off `hydrateConfigFromDisk()`, and `renderer/src/main.tsx` is the only entry
 * that runs it. The WEB client hydrates through the replica on `sync-full` and
 * never went near it, so `providerAuth.chatgpt` stayed `'unknown'` for the whole
 * session: on the headless server, a user with NO ChatGPT account saw Codex's
 * models undimmed, no "Sign in to ChatGPT" item, and no composer hint. A
 * hermetic-server drive is what caught it.
 *
 * ## Why the whole entry module
 *
 * The fix is one line in a `useCallback` inside `main.tsx`, conditioned on the
 * `isResync` flag that only that component owns. Testing anything smaller would
 * be testing the line, not the wiring — the same reasoning
 * `enroll-offer.component.test.tsx` gives for driving the real entry, and this
 * file borrows its scripted-socket harness wholesale.
 *
 * The App chunk, the replica and the session store are stubbed: none of them
 * participates in the decision, and the real ones would drag the whole renderer
 * into a jsdom process. The store stub is what the assertion reads.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, fireEvent, screen } from '@testing-library/react'
import { act } from 'react'

const storeMocks = vi.hoisted(() => ({ refreshProviderAuth: vi.fn(async () => {}) }))

vi.mock('@renderer/App', () => ({ default: () => <div data-testid="FakeApp">app</div> }))
vi.mock('@renderer/stores/replica', () => ({
  startReplica: () => {},
  hydrateReplica: () => {},
  // The render-loss detector starts beside the replica on this path and observes
  // it through the post-apply seam, so the mock has to offer one.
  onReplicaApplied: () => () => {},
  getReplicaState: () => ({ sessions: {} }),
  resolveRekeyed: (id: string) => id
}))
// The web entry lazy-imports the render-loss detector beside the replica, and
// the detector imports the REAL session store — the whole renderer graph. This
// test never waits on that import, so on a slow runner it was still resolving
// when the environment tore down: every test green, and vitest failing the run
// on an EnvironmentTeardownError. Nothing here is about the audit; stub it.
vi.mock('@renderer/utils/projection-audit', () => ({ startProjectionAudit: () => {} }))
vi.mock('@renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ refreshProviderAuth: storeMocks.refreshProviderAuth }) }
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

const SNAPSHOT = { seq: 0, sessions: {}, ui: {}, config: {} }

/** Sign in with a password and settle on the first `sync-full`. */
async function signIn(): Promise<FakeSocket> {
  await act(async () => {
    await import('../main')
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
    ws.deliver({ type: 'auth-response', ok: true, method: 'password' })
  })
  await syncFull(ws)
  return ws
}

/** Deliver one `sync-full` and let the dynamic imports inside the handler land. */
async function syncFull(ws: FakeSocket): Promise<void> {
  await act(async () => {
    ws.deliver({ type: 'sync-full', epoch: 1, state: SNAPSHOT })
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('web client — the ChatGPT auth view is read on first hydration', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    FakeSocket.last = null
    storeMocks.refreshProviderAuth.mockClear()
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 1,
          methods: ['password'],
          password: { saltHex: 'aa', kdf: KDF }
        })
      }))
    )
    // The scrypt proof is cached in SESSION storage (`password-proof.ts`), and a
    // cached proof connects straight through without ever showing the password
    // screen — which would make the second case here drive a different path
    // from the first.
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  /**
   * RED before the fix: the web entry hydrated the replica and stopped, so the
   * picker and the composer hint had nothing but `'unknown'` to render from.
   */
  it('the FIRST sync-full refreshes the provider auth view (GUARD)', async () => {
    await signIn()
    await waitFor(() => expect(storeMocks.refreshProviderAuth).toHaveBeenCalledTimes(1))
  }, 30_000)

  /**
   * A RE-sync must NOT repeat it. `provider-registry:list` composes three
   * optional stores and can start an opencode server, while a re-sync fires on
   * every background→foreground transition — constantly, on a phone. The answer
   * only moves when someone signs in or out, and both of those refresh it
   * themselves (`closeSignIn`, and every settings sheet that mutates the
   * registry).
   */
  it('a RE-sync does not repeat the read — it can start an opencode server (GUARD)', async () => {
    const ws = await signIn()
    await waitFor(() => expect(storeMocks.refreshProviderAuth).toHaveBeenCalledTimes(1))

    await syncFull(ws)
    await syncFull(ws)
    expect(storeMocks.refreshProviderAuth).toHaveBeenCalledTimes(1)
  }, 30_000)
})
