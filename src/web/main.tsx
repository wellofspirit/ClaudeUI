import './main.css'

import { StrictMode, useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConnection, type ConnectionState } from './connection'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { createWebSocketApi } from './api-adapter'
import { setSyncClient } from '../core/shared/sync/client-registry'
import { ConnectionOverlay } from './components/ConnectionOverlay'
import { PasswordLogin } from './components/PasswordLogin'
import { PasskeyLogin } from './components/PasskeyLogin'
import { EnrollDevice } from './components/EnrollDevice'
import { EnrollPrompt, dismissEnrollPrompt, enrollPromptDismissed } from './components/EnrollPrompt'
import { NoAuthBanner } from './components/NoAuthBanner'
import { MissingCredential } from './components/MissingCredential'
import { SessionExpiredNotice } from './components/SessionExpiredNotice'
import { StepUpOverlay } from './components/StepUpOverlay'
import { createStepUpGate } from './step-up-gate'
import { readCachedProof, writeCachedProof, clearCachedProof } from './password-proof'
import { decideAuthEntry, type PasswordParams } from './auth-entry'
import type { FullStateSnapshot, RemoteAuthInfo, RemoteAuthMethod } from '../shared/remote-protocol'

// The CHANNEL key and a one-time enrollment token ride the URL fragment.
// Browsers never send the fragment to the server, so neither ever appears in the
// HTTP request line — keeping them out of tunnel/CDN access logs (H2). They
// reach the client only by scanning the QR code / opening the copied link.
//
// `#t=` is GONE (ADR-056). A link is a channel now: `#k=` opens the encrypted
// pipe on a tunnel or LAN address and buys nothing else, and the identity inside
// it is a password or a passkey.
const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const e2eKeyHex = fragment.get('k') || undefined
/** `#enroll=<token>` — a minted "add this device" link (ADR-052). */
const enrollToken = fragment.get('enroll') || ''

// ONE connection instance for the page lifetime. `window.api` is bound to it
// before React mounts, so the password re-prompt path must revive this instance
// (setCredential + connect) rather than construct a replacement the adapter
// would never see.
const connection = new RemoteConnection(
  window.location.href,
  enrollToken ? { enrollToken } : {},
  e2eKeyHex
)
// ADR-054's generic step-up gate. Installed on the CONNECTION (not on the
// api-adapter) so every invoke in the app is covered by one rule: a
// `needs-step-up` refusal opens one ceremony for however many calls are waiting
// and retries each once. Created before `window.api` exists, like everything
// else the transport owns, because a demand can arrive on the very first invoke.
const stepUpGate = createStepUpGate()
connection.setInvokeGate(stepUpGate.intercept)

const api = createWebSocketApi(connection)
;(window as unknown as { api: typeof api }).api = api
// The keystroke path needs the gate without a refusal to react to: the server
// drops a stale `term-input` frame SILENTLY (an error would be an oracle for
// which terminals exist), so the read-only terminal has to prompt on the first
// key itself. Handed to the renderer through the same `window` surface the
// tokens use — the terminal components are shared with the desktop build, which
// has no gate and must not import one.
;(window as unknown as { __STEP_UP_REQUEST__?: (channel: string) => Promise<boolean> }).__STEP_UP_REQUEST__ =
  (channel) => stepUpGate.request(channel)
// SyncCore phase 4c: install the transport's SyncClient in the shared registry
// BEFORE React mounts, so every replicated-channel listener in the renderer
// subscribes to it. The desktop entry does the same with its MessagePort client —
// one subscription surface, two transports.
setSyncClient(connection.getSyncClient())

/** Discovery endpoint. Absolute path — the server matches `/remote/auth-info`
 *  exactly, and `/remote` (no trailing slash) would resolve a relative
 *  `auth-info` to `/auth-info`. */
const AUTH_INFO_URL = new URL('/remote/auth-info', window.location.origin).toString()

/**
 * Could this browser even attempt a WebAuthn ceremony?
 *
 * Both halves matter and `@simplewebauthn/browser`'s `browserSupportsWebAuthn()`
 * only covers one: it tests for the API, not for the SECURE CONTEXT, and the
 * plain-LAN IP case (`http://192.168.x.x`) is exactly an ordinary browser with
 * the API present and `navigator.credentials` unusable.
 *
 * A NECESSARY condition for offering enrollment, never a sufficient one, and no
 * longer the origin test: whether a credential could be BOUND here is the
 * server's classification (`auth-response.webauthnCapableOrigin`), because an
 * HTTPS tunnel page passes everything below and can still bind nothing.
 */
function browserCanAttemptWebauthn(): boolean {
  return window.isSecureContext === true && typeof window.PublicKeyCredential === 'function'
}

/**
 * Drop `#enroll=` from the address bar, keeping any other fragment keys.
 *
 * An enrollment token is single-use and the server burns it on the handshake,
 * so the moment it has been used the URL in the bar is a dead secret that a
 * reload, a bookmark or a shared screenshot would keep presenting. Stripping it
 * lands a reload on ordinary sign-in instead of on an enrollment screen that
 * can only fail. `replaceState` rather than a navigation: nothing should
 * reload, and the visit should not become a back-button entry.
 */
function stripEnrollFragment(): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  if (!params.has('enroll')) return
  params.delete('enroll')
  const rest = params.toString()
  const { pathname, search } = window.location
  window.history.replaceState(null, '', `${pathname}${search}${rest ? `#${rest}` : ''}`)
}

/** What the pre-connection auth flow is currently doing. */
type AuthPhase =
  /** Fetching /remote/auth-info (no fragment token to go on). */
  | { kind: 'probing' }
  /** A credential is in hand; the connection drives the UI from here. */
  | { kind: 'connecting' }
  /** Waiting on the user's password. */
  | { kind: 'password'; params: PasswordParams; error?: string }
  /**
   * Waiting on a passkey tap (ADR-052). LATCHED once entered: the server's
   * pre-auth grace is short, so the socket underneath is expected to close and
   * reconnect while the screen sits there — re-rendering the connecting overlay
   * on every cycle would strobe a screen whose only job is to hold still until
   * a finger lands.
   */
  | { kind: 'passkey'; error?: string }
  /** Landed on a one-time `#enroll=` link — register, then assert. */
  | { kind: 'enroll'; error?: string }
  /** No usable way in from this browser. */
  | { kind: 'unavailable'; detail?: string }

let appLoad: Promise<React.ComponentType> | null = null

/**
 * Memoized dynamic import of the renderer's App (~1.18 MB min). Fired the
 * moment a connection attempt starts so the download overlaps the WS handshake
 * + sync-full instead of being serialized behind it; AppContent's later call is
 * a memo hit (and StrictMode's double-effect a no-op). A failed fetch resets
 * the memo so the next attempt retries instead of caching the rejection.
 */
function loadApp(): Promise<React.ComponentType> {
  appLoad ??= import('@renderer/App').then(
    (m) => m.default,
    (err) => {
      appLoad = null
      throw err
    }
  )
  return appLoad
}

// Root app component that manages the auth flow + connection lifecycle
function RemoteApp(): React.JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>(
    enrollToken ? { kind: 'enroll' } : { kind: 'probing' }
  )
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  /**
   * How the server says THIS connection authenticated. Drives the `off`-mode
   * banner (`'none'`) and the post-password enrollment offer (`'password'`).
   * Read from the connection rather than threaded through the state callback,
   * because it is the connection's fact, not the state machine's.
   */
  const [authMethod, setAuthMethod] = useState<RemoteAuthMethod>()
  /**
   * The server reported that authentication is OFF for this connection. Kept
   * separate from {@link authMethod} because it is true for EVERY method under
   * `off` — most importantly `tailnet-identity`, which is what the owner's own
   * phone is admitted as (see `RemoteConnection.isAuthDisabled`).
   */
  const [authDisabled, setAuthDisabled] = useState(false)
  /**
   * The SERVER says a passkey could be bound on this connection's origin
   * (`auth-response.webauthnCapableOrigin`). The origin gate for the enrollment
   * offer — see the gate below for why the browser's own answer is not enough.
   */
  const [webauthnCapableOrigin, setWebauthnCapableOrigin] = useState(false)
  /**
   * The last disconnect was a strong-tier session cut (close 4010), and the user
   * has not been back to `connected` since. Not an error state — the reconnect
   * is already running — just the one sentence that explains the sign-in screen
   * they are about to meet.
   */
  const [sessionExpired, setSessionExpired] = useState(false)
  /** The device already said "not now" to the enrollment offer. */
  const [enrollOffered, setEnrollOffered] = useState(!enrollPromptDismissed())
  /** Latest advertised password params, so a rejection can re-show the form
   *  (and know which cache entry to drop) without re-fetching auth-info. */
  const pwParams = useRef<PasswordParams | null>(null)
  /** `/remote/auth-info` advertised a passkey for this origin. */
  const passkeyAdvertised = useRef(false)
  /** Flips true after the first `sync-full` is applied. A later `sync-full`
   *  (background/foreground reconnect) is a RE-sync, not a first hydration —
   *  hydrateReplica must not clobber local navigation (e.g. a
   *  mobile-hydrated historical session) with the desktop's snapshot. */
  const hasHydratedRef = useRef(false)

  const handleStateChange = useCallback((state: ConnectionState, err?: string) => {
    setConnState(state)
    setError(err)
    setAuthMethod(connection.getAuthMethod())
    setAuthDisabled(connection.isAuthDisabled())
    setWebauthnCapableOrigin(connection.isWebauthnCapableOrigin())
    // Every connect path — fragment token, tailnet identity, password proof —
    // goes through connection.connect(), which emits 'connecting' before it
    // opens the socket, and nothing else emits it. So this starts the App
    // download exactly when a credential is in play and never for a visitor
    // idling on the login form. Rejection is swallowed here because AppContent's
    // own loadApp() is the one that reports it.
    if (state === 'connecting') void loadApp().catch(() => {})
    // The server wants a ceremony on this socket. Switch to the one-tap screen
    // and STAY there — including across the reconnects the short pre-auth grace
    // causes — until a passkey actually lands us somewhere else.
    if (state === 'passkey-required') {
      setPhase((prev) => (prev.kind === 'enroll' ? prev : { kind: 'passkey', error: err }))
    }
    // Reaching `connected` RETIRES a ceremony phase. Without this the screen
    // would latch for the page's lifetime and a later transient reconnect —
    // a phone waking up — would throw the operator back onto a sign-in button
    // for a session they never lost. A ceremony that becomes owed again (4009
    // under a tightened policy) re-enters the phase through the branch above,
    // which is the only thing that should put it back.
    if (state === 'connected') {
      // The session-expired notice describes a gap that has now closed. Cleared
      // here rather than on a timer so it lasts exactly as long as the thing it
      // explains — a slow re-authentication keeps its explanation on screen.
      setSessionExpired(false)
      // Unconditional and idempotent (a no-op on every visit that has no
      // `#enroll=`), so it can stay out of the state updater — an enrollment
      // that got this far has spent its link, and the dead token should not
      // outlive it in the address bar.
      stripEnrollFragment()
      setPhase((prev) =>
        prev.kind === 'passkey' || prev.kind === 'enroll' ? { kind: 'connecting' } : prev
      )
    }
    // A dead end reached WHILE offering a passkey usually means this server
    // never wanted one (an operator who pinned `legacy` with credentials still
    // enrolled). The password form is the recovery, not a "Connection Failed"
    // overlay on a screen whose button will keep failing the same way.
    if (state === 'failed' && pwParams.current) {
      const params = pwParams.current
      setPhase((prev) => (prev.kind === 'passkey' ? { kind: 'password', params, error: err } : prev))
    }
    if (state === 'auth-rejected') {
      setPhase((prev) => {
        // An enrollment link is single-purpose: keep the user on that screen
        // with the reason, rather than dropping them onto a password form for
        // a credential they were never given.
        if (prev.kind === 'enroll') return { kind: 'enroll', error: err }
        const params = pwParams.current
        // Re-prompt rather than showing the dead-end "Connection Failed"
        // overlay. The cache is only dropped when the PASSWORD is what was
        // rejected (wrong proof, rotated credential, throttled key) — this state
        // is now also reached by a refused passkey and a dead enrollment link,
        // and discarding a working cached proof for those would turn one
        // re-prompt into two.
        if (params) {
          if (connection.hasPasswordCredential()) clearCachedProof(params.saltHex)
          return { kind: 'password', params, error: err }
        }
        // No password to fall back to. If a passkey is on offer here, that IS
        // the recovery — otherwise leave the overlay to report the dead end.
        if (passkeyAdvertised.current) return { kind: 'passkey', error: err }
        return prev
      })
    }
  }, [])

  /** Run the assertion ceremony; the connection drives the UI from there. */
  const handlePasskeySignIn = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'passkey' })
    await connection.authenticateWithPasskey()
  }, [])

  /** Register on the `#enroll=` socket, then re-authenticate with the new key. */
  const handleEnrollDevice = useCallback(async (nickname: string | null): Promise<void> => {
    await connection.enrollThisDevice(nickname)
  }, [])

  /**
   * Leave a dead enrollment link behind and sign in normally.
   *
   * The one thing a "this link is invalid or expired" screen must not be is
   * terminal — the operator is on the right device at the right address, they
   * just followed a token somebody already used. Dropping the fragment and the
   * credential turns this tab back into an ordinary visitor.
   */
  const handleLeaveEnrollment = useCallback((): void => {
    stripEnrollFragment()
    connection.setCredential({})
    setPhase({ kind: 'connecting' })
    connection.connect()
  }, [])

  const handleFullState = useCallback((snapshot: FullStateSnapshot) => {
    // The mockup-scoped token arrives with the full snapshot over the
    // authenticated WS (it is no longer injected into the served HTML — R3).
    // The api-adapter reads it lazily via window.__MOCKUP_TOKEN__ when building
    // iframe URLs, and AppContent only renders after `ready`, so it's set in
    // time for the first mockup open.
    const mockupToken = connection.getMockupToken()
    if (mockupToken) {
      ;(window as unknown as { __MOCKUP_TOKEN__?: string }).__MOCKUP_TOKEN__ = mockupToken
    }
    // Same deal for the file-scoped token: SentFilesWidget reads it to build
    // `/sent-file` download/preview URLs (ADR-043 §5).
    const fileToken = connection.getFileToken()
    if (fileToken) {
      ;(window as unknown as { __FILE_TOKEN__?: string }).__FILE_TOKEN__ = fileToken
    }
    // Apply the full snapshot through the REPLICA (SyncCore phase 4c): it restores
    // canonical state with the shared `fromSnapshot`, resumes the reducer's aux,
    // and projects the sealed slices into the store — the same code the desktop
    // runs, so the two clients cannot interpret a snapshot differently.
    // isResync=true from the second sync-full onward — see hasHydratedRef.
    const isResync = hasHydratedRef.current
    hasHydratedRef.current = true
    import('@renderer/stores/replica').then(({ startReplica, hydrateReplica }) => {
      // The store module is imported lazily here (the App chunk is what pulls it
      // in), so the tap cannot be installed at page load like the desktop's is —
      // it goes in now, before the first snapshot is folded. Events that arrived
      // in the meantime are still buffered behind the readiness gate, which
      // `AppContent` opens only once App has mounted.
      startReplica()
      hydrateReplica(snapshot, isResync)
      setReady(true)
    })
  }, [])

  // Catchup events are replayed through the connection's live onEvent handler
  // (see connection.ts sync-catchup), so main.tsx needs no event knowledge.

  const connectWithProof = useCallback((proofHex: string) => {
    connection.setCredential({ pwProof: proofHex })
    setConnState('connecting')
    setError(undefined)
    setPhase({ kind: 'connecting' })
    connection.connect()
  }, [])

  /** Derivation finished in PasswordLogin — cache the proof and connect. */
  const handleProof = useCallback(
    (proofHex: string) => {
      const params = pwParams.current
      if (params) writeCachedProof(params.saltHex, proofHex)
      connectWithProof(proofHex)
    },
    [connectWithProof]
  )

  useEffect(() => {
    connection.setStateHandler(handleStateChange)
    connection.setFullStateHandler(handleFullState)
    connection.setSessionExpiredHandler(() => setSessionExpired(true))
    return () => {
      connection.setSessionExpiredHandler(null)
      connection.destroy()
    }
  }, [handleStateChange, handleFullState])

  // Bootstrap: a fragment credential → connect straight away (unchanged path).
  // Otherwise ask the server which methods it offers.
  useEffect(() => {
    let cancelled = false

    /**
     * Remember whether this origin advertises a passkey. Two consumers: the
     * login screen's lead affordance, and the terminal step-up's choice of
     * factor — which is why it is recorded even on the fragment-credential path
     * that needs no discovery to connect.
     */
    const noteAdvertisement = (advertised: boolean): void => {
      passkeyAdvertised.current = advertised
      connection.setWebauthnAdvertised(advertised)
    }

    const fetchAuthInfo = async (): Promise<RemoteAuthInfo> => {
      const res = await fetch(AUTH_INFO_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`auth-info returned HTTP ${res.status}`)
      return (await res.json()) as RemoteAuthInfo
    }

    if (enrollToken) {
      connection.connect()
      // Alongside, never instead: discovery must not delay a connect that has
      // a credential in hand, and a failed probe must not break one either.
      void fetchAuthInfo().then(
        (info) => {
          if (!cancelled) noteAdvertisement(decideAuthEntry(info).passkeyAdvertised)
        },
        () => {}
      )
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        const info = await fetchAuthInfo()
        if (cancelled) return
        const decision = decideAuthEntry(info)
        // Remembered on EVERY route, not just the one that shows a form: it is
        // what the passkey screen's break-glass link falls back to and what an
        // `auth-rejected` recovers onto, and on the tailnet origin — the phone —
        // those are the only ways a lost authenticator is recoverable at all.
        pwParams.current = decision.passwordParams
        // From the DECISION, not the raw payload: it zeroes both fields for an
        // unsupported protocol version, so nothing is believed from a bundle we
        // have already declared we cannot read.
        noteAdvertisement(decision.passkeyAdvertised)
        switch (decision.route) {
          case 'unsupported':
            setPhase({
              kind: 'unavailable',
              detail: 'This server speaks a newer remote protocol — update the desktop app.'
            })
            return
          case 'passkey':
            setPhase({ kind: 'passkey' })
            return
          case 'unavailable':
            setPhase({ kind: 'unavailable' })
            return
          case 'password': {
            const params = decision.passwordParams
            if (!params) {
              setPhase({ kind: 'unavailable' })
              return
            }
            // Same tab, already signed in this session: skip the form entirely.
            const cached = readCachedProof(params.saltHex)
            if (cached) {
              connectWithProof(cached)
              return
            }
            setPhase({ kind: 'password', params })
            return
          }
        }
      } catch (err) {
        if (cancelled) return
        setPhase({
          kind: 'unavailable',
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connectWithProof])

  /**
   * The session-expired notice rides EVERY screen below, sign-in screens
   * included — it exists precisely to explain why the operator is looking at one
   * of those. Rendered as a sibling ahead of each branch rather than inside
   * them, because the branch that shows is a fact about the connection and the
   * notice is a fact about the connection it just lost.
   */
  const expiredNotice = sessionExpired ? <SessionExpiredNotice /> : null

  if (phase.kind === 'password') {
    return (
      <>
        {expiredNotice}
        <PasswordLogin
          saltHex={phase.params.saltHex}
          kdf={phase.params.kdf}
          error={phase.error}
          onProof={handleProof}
        />
      </>
    )
  }
  // The enrollment screen owns the whole `#enroll=` visit, including the
  // connect that precedes it: an `enroll`-only socket never syncs, so there is
  // no app to reveal until the upgrade assertion lands and the phase moves on.
  if (phase.kind === 'enroll' && connState !== 'connected') {
    return (
      <EnrollDevice
        onEnroll={handleEnrollDevice}
        error={phase.error}
        ready={connState === 'enrolling'}
        // Only offered once the link itself is DEFINITIVELY dead
        // (`auth-rejected`), not for a retryable ceremony failure — walking away
        // mid-enrollment would abandon a credential this socket can still use.
        onLeave={connState === 'auth-rejected' ? handleLeaveEnrollment : undefined}
      />
    )
  }
  if (phase.kind === 'passkey' && connState !== 'connected') {
    return (
      <>
        {expiredNotice}
        <PasskeyLogin
          onSignIn={handlePasskeySignIn}
          error={phase.error ?? error}
          onUsePassword={
            pwParams.current
              ? () => {
                  const params = pwParams.current
                  if (params) setPhase({ kind: 'password', params })
                }
              : undefined
          }
        />
      </>
    )
  }
  if (phase.kind === 'unavailable') {
    return <MissingCredential detail={phase.detail} />
  }
  if (phase.kind === 'probing') {
    return <ConnectionOverlay state="connecting" />
  }

  // The offer only makes sense for a PASSWORD connection: a passkey connection
  // already has one, and an enrollment-link one is on its way to having one.
  //
  // THE ORIGIN GATE IS THE SERVER'S, not the browser's. Enrollment binds a
  // credential to the RP ID derived from the serving `Host`, and only two Hosts
  // can carry one: the tailnet DNS name and `localhost` in development
  // (`resolveWebauthnOrigin`). `browserCanAttemptWebauthn()` cannot see that —
  // the Cloudflare tunnel is HTTPS, so it answers TRUE there while every
  // credential minted on that origin dies with the ephemeral hostname it was
  // bound to. So the offer follows `webauthnCapableOrigin`, which the accept
  // carries from the server's own classification: tailnet ⇒ offered, tunnel and
  // LAN ⇒ never, localhost dev ⇒ offered.
  //
  // `browserCanAttemptWebauthn()` STAYS, as a second condition rather than the
  // origin one: a capable origin reached in a browser with no WebAuthn (or no
  // secure context — the plain-http tailnet DNS address classifies as a capable
  // Host while the page is insecure) still cannot run a ceremony.
  //
  // Deliberately NOT gated on the passkey advertisement. That flag needs ≥1
  // credential to be present, which would hide the offer in precisely the case
  // where the operator most needs to be told something — their first web login,
  // nothing enrolled yet, wondering where passkeys live. On a CAPABLE origin
  // that first offer is honest work: it either enrolls (a password connection
  // holds `enroll` under every non-`off` policy since ADR-056) or the server
  // refuses and the refusal itself teaches where the first passkey comes from
  // (see EnrollPrompt's `needsDesktop` branch).
  const offerEnroll =
    enrollOffered &&
    authMethod === 'password' &&
    webauthnCapableOrigin &&
    browserCanAttemptWebauthn() &&
    connState === 'connected'

  return (
    <>
      {expiredNotice}
      {authDisabled && <NoAuthBanner />}
      {offerEnroll && (
        <EnrollPrompt
          onEnroll={() => connection.enrollThisDevice(null)}
          onDismiss={() => {
            dismissEnrollPrompt()
            setEnrollOffered(false)
          }}
        />
      )}
      <ConnectionOverlay state={connState} error={error} />
      {/* Above the app, below the connection overlay: a ceremony is owed on a
          LIVE connection, so it must never cover the screen that says the
          connection is gone. */}
      <StepUpOverlay gate={stepUpGate} connection={connection} />
      {ready && <AppContent />}
    </>
  )
}

// Lazy-load the actual app content (same components as Electron renderer).
// Normally a memo hit: the chunk was prefetched at 'connecting' (see loadApp).
function AppContent(): React.JSX.Element {
  const [App, setApp] = useState<React.ComponentType | null>(null)

  useEffect(() => {
    loadApp().then(
      (Loaded) => setApp(() => Loaded),
      // Stays on "Loading..."; the memo is already reset, so a page reload —
      // or a re-auth's fresh connect() — retries the fetch.
      (err) => api.logError('web-main', `App chunk failed to load: ${err}`)
    )
  }, [])

  // Mount-complete: React flushes effects child-first, so App's subtree — which
  // is where useClaudeEvents registers every window.api.onX listener — has run
  // by the time this parent effect does. Everything the server pushed during
  // the snapshot apply → store import → App chunk → mount window has been
  // buffering; markReady flushes it in seq order and goes live. Before this,
  // those events were acked and dropped, which is every phone foreground
  // (remote.md defect 4). Latched, so a reconnect never re-arms the gate.
  useEffect(() => {
    if (App) connection.markReady()
  }, [App])

  if (!App) {
    return (
      <div className="flex items-center justify-center h-screen text-text-secondary">
        Loading...
      </div>
    )
  }

  return <App />
}

// Render immediately — config hydration happens via the full state snapshot
// when the WebSocket connection completes (see handleFullState above)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Same shield as the desktop entry (M-RN2) — now that App subtrees lazy-load
        chunks (xterm, mermaid), a failed fetch after a connection drop throws at a
        Suspense boundary; without this it would unmount the app to a blank page. */}
    <ErrorBoundary>
      <RemoteApp />
    </ErrorBoundary>
  </StrictMode>
)
