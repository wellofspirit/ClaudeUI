/**
 * Unit tests for `RemoteConnection`'s WebAuthn state machine (ADR-052 series 2).
 *
 * These drive the PROTOCOL, not the crypto: `@simplewebauthn/browser` is mocked
 * at the module boundary because jsdom has no WebAuthn at all, and the thing
 * worth guarding here is the frame ordering and the branch each server answer
 * takes — a real assertion is verified server-side, and series 1's
 * `remote-passkeys.test.ts` already does that with genuine signatures.
 *
 * Everything is driven through the private message handler (via cast), exactly
 * like `connection.test.ts`, so no live WebSocket is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const startAuthentication = vi.fn()
const startRegistration = vi.fn()
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
  startRegistration: (...args: unknown[]) => startRegistration(...args)
}))

import { RemoteConnection, type ConnectionState } from '../connection'
import {
  PASSKEY_FAILED_ERROR,
  PASSKEY_REQUIRED_ERROR,
  PASSKEY_UNAVAILABLE_ERROR
} from '../../shared/remote-protocol'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  onopen: unknown = null
  onmessage: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(payload: string): void {
    this.sent.push(payload)
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closed = { code, reason }
    ;(this.onclose as ((ev: { code?: number }) => void) | null)?.({ code })
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

interface Internals {
  handleMessage(msg: unknown): void
  ws: FakeWebSocket | null
  state: ConnectionState
  destroyed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

const ASSERTION_OPTIONS = { challenge: 'Y2hhbA', rpId: 'box.tail.ts.net', allowCredentials: [] }
const REGISTRATION_OPTIONS = { challenge: 'cmVn', rp: { id: 'box.tail.ts.net', name: 'ClaudeUI' } }
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} }
const REGISTRATION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} }

/** Frames this socket has sent, parsed. */
function sentFrames(conn: RemoteConnection): { type: string; [k: string]: unknown }[] {
  const ws = (conn as unknown as Internals).ws
  return (ws?.sent ?? []).map((raw) => JSON.parse(raw))
}

function makeConn(credential: Record<string, string> = {}): {
  conn: RemoteConnection
  internals: Internals
  states: { state: ConnectionState; error?: string }[]
} {
  const conn = new RemoteConnection('http://box.tail.ts.net/remote', credential)
  const states: { state: ConnectionState; error?: string }[] = []
  conn.setStateHandler((state, error) => states.push({ state, error }))
  conn.connect()
  // `connect()` builds the socket; jsdom's fake is OPEN immediately, and the
  // real onopen would have fired the auth frame — replay it so the socket is in
  // the same place a live one would be.
  const internals = conn as unknown as Internals
  ;(internals.ws?.onopen as (() => void) | null)?.()
  return { conn, internals, states }
}

describe('RemoteConnection — passkey handshake', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    startAuthentication.mockReset()
    startRegistration.mockReset()
    startAuthentication.mockResolvedValue(ASSERTION)
    startRegistration.mockResolvedValue(REGISTRATION)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('`passkey-required` leaves the socket OPEN and surfaces the state (GUARD)', () => {
    // The socket the ceremony must run on is THIS one. Closing it would force a
    // reconnect between "you need a passkey" and "here is my passkey".
    const { conn, internals, states } = makeConn({ token: 'tok' })
    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_REQUIRED_ERROR,
      retryable: false
    })
    expect(internals.ws?.closed).toBeNull()
    expect(internals.destroyed).toBe(false)
    expect(states.at(-1)).toEqual({ state: 'passkey-required', error: undefined })
    conn.destroy()
  })

  it('a user-initiated sign-in runs start → sign → finish → accepted', async () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })

    const signIn = conn.authenticateWithPasskey()
    // The tap is what sends the start frame — nothing fires it automatically,
    // because Safari/iOS needs a transient user activation for the ceremony.
    expect(sentFrames(conn).at(-1)).toEqual({ type: 'auth-webauthn-start' })

    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: ASSERTION_OPTIONS })
    expect(sentFrames(conn).at(-1)).toEqual({ type: 'auth-webauthn-finish', assertion: ASSERTION })

    internals.handleMessage({
      type: 'auth-response',
      ok: true,
      method: 'webauthn',
      identity: { login: 'Pixel' }
    })
    await expect(signIn).resolves.toBeUndefined()
    expect(conn.getAuthMethod()).toBe('webauthn')
    expect(conn.passkeyAvailable()).toBe(true)
    conn.destroy()
  })

  it('a tap on a DEAD socket reconnects first, then fires on the fresh one', async () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
    // The server's pre-auth grace expires while the user reads the screen.
    internals.ws?.close(4000)
    expect(internals.state).toBe('reconnecting')

    const signIn = conn.authenticateWithPasskey()
    // No socket to send on yet: `connect()` was called instead, and the pending
    // flag is what re-arms the ceremony on the NEW socket's refusal.
    const fresh = internals.ws
    expect(fresh).not.toBe(FakeWebSocket.instances[0])
    ;(fresh?.onopen as (() => void) | null)?.()
    expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-start')).toBe(false)

    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
    expect(sentFrames(conn).at(-1)).toEqual({ type: 'auth-webauthn-start' })

    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'webauthn' })
    await expect(signIn).resolves.toBeUndefined()
    conn.destroy()
  })

  it('a FAILED attempt does not leave the next reconnect auto-firing a ceremony (GUARD)', async () => {
    // The tap arms an auto-start so the ceremony survives the reconnect it has
    // to do to get a live socket. That arming must die with the attempt: once
    // the waiter has rejected, the user is back on the one-tap screen, and a
    // later `passkey-required` firing `startAssertion()` on its own would pop an
    // unprompted biometric modal on Chrome — and on iOS Safari would throw
    // NotAllowedError with no user activation, idling the socket against the
    // server's 120 s ceremony budget for a prompt nobody asked for.
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
    // The pre-auth grace lapses while the user reads the screen.
    internals.ws?.close(4000)

    const signIn = conn.authenticateWithPasskey()
    const attempted = internals.ws
    ;(attempted?.onopen as (() => void) | null)?.()
    // ...and THAT socket dies too (flaky link / server-side drop).
    attempted?.close(1006)
    await expect(signIn).rejects.toThrow(/Connection lost/i)

    // Backoff reconnect, and the server asks again.
    await vi.advanceTimersByTimeAsync(1200)
    const revived = internals.ws
    expect(revived).not.toBe(attempted)
    ;(revived?.onopen as (() => void) | null)?.()
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })

    expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-start')).toBe(false)
    expect(internals.state).toBe('passkey-required')
    conn.destroy()
  })

  it('a rejected assertion rejects the caller and reconnects rather than failing hard', async () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
    const signIn = conn.authenticateWithPasskey()
    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))

    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_FAILED_ERROR,
      retryable: true
    })
    await expect(signIn).rejects.toThrow(/did not verify/i)
    // GUARD: `retryable` means the backoff owns recovery. Latching `destroyed`
    // here would strand the login screen on a socket that never comes back.
    expect(internals.destroyed).toBe(false)
    expect(internals.state).toBe('reconnecting')
    conn.destroy()
  })

  it('`passkey-unavailable` is definitive and stops the backoff', async () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    const signIn = conn.authenticateWithPasskey()
    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_UNAVAILABLE_ERROR,
      retryable: false
    })
    await expect(signIn).rejects.toThrow(/No passkey is available/i)
    expect(internals.state).toBe('auth-rejected')
    // Nothing about retrying changes the answer, so no reconnect is scheduled.
    expect(internals.reconnectTimer).toBeUndefined()
    conn.destroy()
  })

  it('a cancelled browser prompt settles locally and sends no finish frame', async () => {
    const cancelled = new Error('user cancelled')
    cancelled.name = 'NotAllowedError'
    startAuthentication.mockRejectedValueOnce(cancelled)

    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: false, error: PASSKEY_REQUIRED_ERROR })
    const signIn = conn.authenticateWithPasskey()
    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })

    await expect(signIn).rejects.toThrow(/cancelled or timed out/i)
    expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-finish')).toBe(false)
    conn.destroy()
  })

  it('the off-mode banner keys on authDisabled, for EVERY method (GUARD)', () => {
    // Under `off` the owner's phone on the tailnet is admitted as
    // `tailnet-identity`, so `method:'none'` never reaches the most common
    // client and keying the banner on the method alone left it unwarned.
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({
      type: 'auth-response',
      ok: true,
      method: 'tailnet-identity',
      identity: { login: 'owner@example.com' },
      authDisabled: true
    })
    expect(conn.isAuthDisabled()).toBe(true)
    conn.destroy()
  })

  it('still keys on method:none, for a server built before the field', () => {
    // `none` is the only method such a server could report under `off`, which
    // makes it exactly the right compatibility fallback.
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'none' })
    expect(conn.isAuthDisabled()).toBe(true)
    conn.destroy()
  })

  it('no banner while authentication is on, and none for a dead socket', () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({
      type: 'auth-response',
      ok: true,
      method: 'tailnet-identity',
      identity: { login: 'owner@example.com' }
    })
    expect(conn.isAuthDisabled()).toBe(false)

    // A flip mid-session arrives as 4009; the banner must not survive the
    // socket that reported it, or it would describe a connection that is gone.
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'none' })
    expect(conn.isAuthDisabled()).toBe(true)
    internals.ws?.close(4009)
    expect(conn.isAuthDisabled()).toBe(false)
    conn.destroy()
  })

  it('close 4009 reconnects immediately and forgets the old auth method', () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'webauthn' })
    expect(conn.getAuthMethod()).toBe('webauthn')

    internals.ws?.close(4009)
    // Not a rejection: the RULES moved, so a fresh handshake decides what this
    // client now owes. The method must not survive the socket that earned it —
    // an `off`-mode banner rendered off a dead connection would be a lie.
    expect(conn.getAuthMethod()).toBeUndefined()
    expect(internals.destroyed).toBe(false)
    expect(internals.state).toBe('reconnecting')
    expect(internals.reconnectTimer).toBeDefined()
    conn.destroy()
  })
})

describe('RemoteConnection — resumption token (ADR-063)', () => {
  const TOKEN = 'ab'.repeat(32)

  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    startAuthentication.mockReset()
    startAuthentication.mockResolvedValue(ASSERTION)
  })

  it('presents a seeded token, and only after the other two credentials', () => {
    const { conn } = makeConn({ resumeToken: TOKEN })
    expect(sentFrames(conn)[0]).toEqual({ type: 'auth', resumeToken: TOKEN })
    conn.destroy()

    // The server branches pwProof → enrollToken → resumeToken and never falls
    // through between methods, so a client that sent two would just be sending
    // one the server ignores.
    const { conn: withPw } = makeConn({ pwProof: 'cafe', resumeToken: TOKEN })
    expect(sentFrames(withPw)[0]).toEqual({ type: 'auth', pwProof: 'cafe' })
    withPw.destroy()

    const { conn: withEnroll } = makeConn({ enrollToken: 'etok', resumeToken: TOKEN })
    expect(sentFrames(withEnroll)[0]).toEqual({ type: 'auth', enrollToken: 'etok' })
    withEnroll.destroy()
  })

  it('an accept carrying a token reports it AND keeps it for this instance', () => {
    const seen: (string | null)[] = []
    const { conn, internals } = makeConn()
    conn.setResumeTokenHandler((t) => seen.push(t))
    expect(sentFrames(conn)[0]).toEqual({ type: 'auth' })

    internals.handleMessage({
      type: 'auth-response',
      ok: true,
      method: 'webauthn',
      resumeToken: TOKEN
    })
    expect(seen).toEqual([TOKEN])
    // Held on the CREDENTIAL, so this instance's own next handshake presents it
    // without waiting for the page to hand it back through `setCredential` —
    // which is what makes a socket that dies mid-session recover silently.
    const before = FakeWebSocket.instances.length
    conn.connect()
    const reconnected = FakeWebSocket.instances.at(-1)!
    expect(FakeWebSocket.instances.length).toBe(before + 1)
    ;(reconnected.onopen as (() => void) | null)?.()
    expect(JSON.parse(reconnected.sent[0])).toEqual({ type: 'auth', resumeToken: TOKEN })
    conn.destroy()
  })

  it('a refused resume drops the cached token and lands on the tap screen', () => {
    const seen: (string | null)[] = []
    const { conn, internals, states } = makeConn({ resumeToken: TOKEN })
    conn.setResumeTokenHandler((t) => seen.push(t))

    // The server treated the frame as bare auth, so this is the ORDINARY
    // ceremony prompt — nothing about it says "resume", which is why the client
    // has to remember it presented one.
    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_REQUIRED_ERROR,
      retryable: false
    })
    expect(seen).toEqual([null])
    expect(states.at(-1)?.state).toBe('passkey-required')
    // …and the socket stays open, because that IS the ceremony prompt.
    expect(internals.ws?.closed).toBeNull()
    expect(internals.destroyed).toBe(false)
    conn.destroy()
  })

  it('does NOT clear the token for a refusal this client did not present one for', () => {
    const seen: (string | null)[] = []
    const { conn, internals } = makeConn()
    conn.setResumeTokenHandler((t) => seen.push(t))
    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_REQUIRED_ERROR,
      retryable: false
    })
    // A credential-less client meeting the ordinary prompt must not wipe a
    // perfectly good cached token — that would turn one tap into one per socket.
    expect(seen).toEqual([])
    conn.destroy()
  })

  it('a resumed session counts as a passkey identity for the step-up offer', () => {
    const { conn, internals } = makeConn({ resumeToken: TOKEN })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'webauthn-resumed' })
    // It is the connection that most NEEDS the offer: a resume arms nothing, so
    // it meets the step-up on its first act.
    expect(conn.passkeyAvailable()).toBe(true)
    conn.destroy()
  })
})

describe('RemoteConnection — enrollment token', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    startAuthentication.mockReset()
    startRegistration.mockReset()
    startAuthentication.mockResolvedValue(ASSERTION)
    startRegistration.mockResolvedValue(REGISTRATION)
  })

  it('sends the enroll token and enters `enrolling` WITHOUT syncing (GUARD)', () => {
    const { conn, internals } = makeConn({ enrollToken: 'etok' })
    expect(sentFrames(conn)[0]).toEqual({ type: 'auth', enrollToken: 'etok' })

    internals.handleMessage({ type: 'auth-response', ok: true, method: 'enroll-token' })
    expect(internals.state).toBe('enrolling')
    // An `enroll`-only socket has no app behind it. Asking for a snapshot it
    // cannot use would be noise the server would have to refuse.
    expect(sentFrames(conn).some((f) => f.type === 'sync')).toBe(false)
    conn.destroy()
  })

  it('register → verify → upgrade assertion, on the same socket', async () => {
    const { conn, internals } = makeConn({ enrollToken: 'etok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'enroll-token' })

    const enrolled = conn.enrollThisDevice('Pixel')

    // register-options
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.channel === 'webauthn:register-options')).toBe(true)
    )
    const optionsReq = sentFrames(conn).find((f) => f.channel === 'webauthn:register-options')!
    internals.handleMessage({
      type: 'invoke-response',
      id: optionsReq.id,
      ok: true,
      data: REGISTRATION_OPTIONS
    })

    await vi.waitFor(() => expect(startRegistration).toHaveBeenCalledTimes(1))
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: REGISTRATION_OPTIONS })

    // register-verify carries the response verbatim plus the nickname
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.channel === 'webauthn:register-verify')).toBe(true)
    )
    const verifyReq = sentFrames(conn).find((f) => f.channel === 'webauthn:register-verify')!
    expect(verifyReq.args).toEqual([{ response: REGISTRATION, nickname: 'Pixel' }])
    internals.handleMessage({
      type: 'invoke-response',
      id: verifyReq.id,
      ok: true,
      data: { ok: true, credId: 'cred-1', backedUp: true }
    })

    // GUARD: the enroll connection does NOT silently widen — it re-asserts.
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-start')).toBe(true)
    )
    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'webauthn' })

    await expect(enrolled).resolves.toBeUndefined()
    expect(conn.getAuthMethod()).toBe('webauthn')
    // Now it is a real connection, so it syncs.
    expect(sentFrames(conn).some((f) => f.type === 'sync')).toBe(true)
    conn.destroy()
  })

  it('a failed UPGRADE keeps the socket, and the retry re-asserts without re-registering', async () => {
    // The token was consumed to authenticate this socket, so reconnecting would
    // arrive with a burned credential — a dead end reached WITH a perfectly good
    // passkey already registered. The server pointedly does not close here
    // (`handleEnrollUpgrade`), and neither may we.
    const { conn, internals } = makeConn({ enrollToken: 'etok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'enroll-token' })

    const first = conn.enrollThisDevice('Pixel')
    const optionsReq = await vi.waitFor(() => {
      const frame = sentFrames(conn).find((f) => f.channel === 'webauthn:register-options')
      expect(frame).toBeDefined()
      return frame!
    })
    internals.handleMessage({
      type: 'invoke-response',
      id: optionsReq.id,
      ok: true,
      data: REGISTRATION_OPTIONS
    })
    const verifyReq = await vi.waitFor(() => {
      const frame = sentFrames(conn).find((f) => f.channel === 'webauthn:register-verify')
      expect(frame).toBeDefined()
      return frame!
    })
    internals.handleMessage({
      type: 'invoke-response',
      id: verifyReq.id,
      ok: true,
      data: { ok: true, credId: 'cred-1', backedUp: true }
    })
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-start')).toBe(true)
    )
    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))

    // The upgrade assertion is refused.
    internals.handleMessage({
      type: 'auth-response',
      ok: false,
      error: PASSKEY_FAILED_ERROR,
      retryable: true
    })
    await expect(first).rejects.toThrow(/passkey you just created/i)
    expect(internals.ws?.closed).toBeNull()
    expect(internals.state).toBe('enrolling')

    // Retry: assertion ONLY. Asking for registration options again would carry
    // an `excludeCredentials` list containing the key that just registered, so
    // the authenticator would answer InvalidStateError and the retry could
    // never succeed.
    const registerCallsBefore = sentFrames(conn).filter((f) =>
      String(f.channel ?? '').startsWith('webauthn:register')
    ).length
    const second = conn.enrollThisDevice('Pixel')
    await vi.waitFor(() =>
      expect(sentFrames(conn).filter((f) => f.type === 'auth-webauthn-start')).toHaveLength(2)
    )
    expect(
      sentFrames(conn).filter((f) => String(f.channel ?? '').startsWith('webauthn:register'))
    ).toHaveLength(registerCallsBefore)
    expect(startRegistration).toHaveBeenCalledTimes(1)

    internals.handleMessage({ type: 'auth-webauthn-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(2))
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'webauthn' })
    await expect(second).resolves.toBeUndefined()
    conn.destroy()
  })

  it('flags the UPGRADE URL with intent=enroll, and only while the credential is one', () => {
    // Without the flag the server's unsolicited tailnet accept beats the
    // `{auth, enrollToken}` frame at the only origin enrollment can happen on,
    // and a first device can never enrol. The token must NOT ride the query
    // string — only the non-secret intent does.
    const { conn, internals } = makeConn({ enrollToken: 'etok' })
    expect(internals.ws?.url).toBe('ws://box.tail.ts.net/?intent=enroll')
    expect(internals.ws?.url).not.toContain('etok')

    // The escape hatch drops the credential; the very next socket must go back
    // to ordinary ambient auth or the operator can never sign in from here.
    conn.setCredential({})
    conn.connect()
    expect(internals.ws?.url).toBe('ws://box.tail.ts.net')
    conn.destroy()
  })

  it('a plain token connection never carries the flag', () => {
    const { conn, internals } = makeConn({ token: 'tok' })
    expect(internals.ws?.url).toBe('ws://box.tail.ts.net')
    conn.destroy()
  })

  it('burns the enroll token the moment the server accepts it (GUARD)', () => {
    // Single-use: the server consumed it to answer this frame. Keeping it would
    // have a reconnect present a dead secret and be refused, instead of falling
    // through to the ordinary sign-in the operator can actually complete.
    const { conn, internals } = makeConn({ enrollToken: 'etok' })
    expect(sentFrames(conn)[0]).toEqual({ type: 'auth', enrollToken: 'etok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'enroll-token' })

    // Whatever brings the next socket up — backoff or an explicit reconnect —
    // takes the same path through `onopen`.
    conn.connect()
    ;(internals.ws?.onopen as (() => void) | null)?.()
    // `undefined` fields are dropped by JSON.stringify, so a credential-less
    // handshake is the bare frame.
    expect(sentFrames(conn).at(-1)).toEqual({ type: 'auth' })
    conn.destroy()
  })

  it('an already-authenticated connection enrolls WITHOUT a second assertion', async () => {
    // Inline self-enroll after a password sign-in: the socket already holds a
    // grant set, so there is nothing to upgrade to.
    const { conn, internals } = makeConn({ pwProof: 'deadbeef' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'password' })
    internals.handleMessage({
      type: 'sync-full',
      epoch: 'e1',
      state: { seq: 0, sessions: {}, directories: [], activeSessionId: null, settings: {} }
    })

    const enrolled = conn.enrollThisDevice(null)
    const optionsReq = await vi.waitFor(() => {
      const frame = sentFrames(conn).find((f) => f.channel === 'webauthn:register-options')
      expect(frame).toBeDefined()
      return frame!
    })
    internals.handleMessage({
      type: 'invoke-response',
      id: optionsReq.id,
      ok: true,
      data: REGISTRATION_OPTIONS
    })
    const verifyReq = await vi.waitFor(() => {
      const frame = sentFrames(conn).find((f) => f.channel === 'webauthn:register-verify')
      expect(frame).toBeDefined()
      return frame!
    })
    internals.handleMessage({
      type: 'invoke-response',
      id: verifyReq.id,
      ok: true,
      data: { ok: true, credId: 'c', backedUp: false }
    })

    await expect(enrolled).resolves.toBeUndefined()
    expect(sentFrames(conn).some((f) => f.type === 'auth-webauthn-start')).toBe(false)
    conn.destroy()
  })

  it('surfaces the registry refusal so the UI can offer desktop guidance', async () => {
    const { conn, internals } = makeConn({ pwProof: 'deadbeef' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'password' })
    internals.handleMessage({
      type: 'sync-full',
      epoch: 'e1',
      state: { seq: 0, sessions: {}, directories: [], activeSessionId: null, settings: {} }
    })

    const enrolled = conn.enrollThisDevice(null)
    const optionsReq = await vi.waitFor(() => {
      const frame = sentFrames(conn).find((f) => f.channel === 'webauthn:register-options')
      expect(frame).toBeDefined()
      return frame!
    })
    internals.handleMessage({
      type: 'invoke-response',
      id: optionsReq.id,
      ok: false,
      error: 'Permission denied: "webauthn:register-options" requires the "enroll" capability'
    })
    // Verbatim, so `isEnrollNotPermittedError` can classify it upstream.
    await expect(enrolled).rejects.toThrow(/requires the "enroll" capability/)
    conn.destroy()
  })
})

describe('RemoteConnection — passkey step-up', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    startAuthentication.mockReset()
    startAuthentication.mockResolvedValue(ASSERTION)
  })

  /** A connection sitting in `connected`, the only state step-up is legal in. */
  function connected(): { conn: RemoteConnection; internals: Internals } {
    const { conn, internals } = makeConn({ token: 'tok' })
    internals.handleMessage({ type: 'auth-response', ok: true, method: 'token' })
    internals.handleMessage({
      type: 'sync-full',
      epoch: 'e1',
      state: { seq: 0, sessions: {}, directories: [], activeSessionId: null, settings: {} }
    })
    return { conn, internals }
  }

  it('challenge-request → sign → step-up{assertion} → granted', async () => {
    const { conn, internals } = connected()
    const stepUp = conn.stepUpWithPasskey()

    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.type === 'step-up-challenge-request')).toBe(true)
    )
    internals.handleMessage({ type: 'step-up-challenge', options: ASSERTION_OPTIONS })
    await vi.waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1))

    const frame = sentFrames(conn).find((f) => f.type === 'step-up')!
    // GUARD: exactly one factor per frame — the server branches on `assertion`
    // first and never falls through, so a `pwProof` here would be dead weight
    // that also looks like credential probing.
    expect(frame).toEqual({ type: 'step-up', assertion: ASSERTION })

    internals.handleMessage({ type: 'step-up-response', ok: true, expiresAt: 123 })
    await expect(stepUp).resolves.toMatchObject({ ok: true, expiresAt: 123 })
    conn.destroy()
  })

  it('a refusal to ISSUE a challenge settles the request (GUARD)', async () => {
    // The refusal arrives as a `step-up-response` with nothing to correlate it
    // to. Without the challenge waiter claiming it first, it would be dropped
    // and the caller would hang until its timeout.
    const { conn, internals } = connected()
    const stepUp = conn.stepUpWithPasskey()
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.type === 'step-up-challenge-request')).toBe(true)
    )
    internals.handleMessage({
      type: 'step-up-response',
      ok: false,
      code: 'passkey-unavailable',
      error: 'No passkey is enrolled for this device.',
      retryable: false
    })
    await expect(stepUp).resolves.toMatchObject({ ok: false, code: 'passkey-unavailable' })
    expect(startAuthentication).not.toHaveBeenCalled()
    conn.destroy()
  })

  it('a cancelled prompt resolves as a retryable refusal, never a throw', async () => {
    const cancelled = new Error('nope')
    cancelled.name = 'NotAllowedError'
    startAuthentication.mockRejectedValueOnce(cancelled)

    const { conn, internals } = connected()
    const stepUp = conn.stepUpWithPasskey()
    await vi.waitFor(() =>
      expect(sentFrames(conn).some((f) => f.type === 'step-up-challenge-request')).toBe(true)
    )
    internals.handleMessage({ type: 'step-up-challenge', options: ASSERTION_OPTIONS })

    await expect(stepUp).resolves.toMatchObject({ ok: false, retryable: true })
    expect((await stepUp).error).toMatch(/cancelled or timed out/i)
    conn.destroy()
  })

  it('the password factor still sends pwProof and nothing else', async () => {
    const { conn, internals } = connected()
    const stepUp = conn.stepUp('abc123')
    expect(sentFrames(conn).at(-1)).toEqual({ type: 'step-up', pwProof: 'abc123' })
    internals.handleMessage({ type: 'step-up-response', ok: true, expiresAt: 5 })
    await expect(stepUp).resolves.toMatchObject({ ok: true })
    conn.destroy()
  })
})
