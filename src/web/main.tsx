import './main.css'

import { StrictMode, useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConnection, type ConnectionState } from './connection'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { createWebSocketApi } from './api-adapter'
import { setSyncClient } from '../shared/sync/client-registry'
import { ConnectionOverlay } from './components/ConnectionOverlay'
import { PasswordLogin } from './components/PasswordLogin'
import { PasskeyLogin } from './components/PasskeyLogin'
import { EnrollDevice } from './components/EnrollDevice'
import { EnrollPrompt, dismissEnrollPrompt, enrollPromptDismissed } from './components/EnrollPrompt'
import { NoAuthBanner } from './components/NoAuthBanner'
import { MissingCredential } from './components/MissingCredential'
import { readCachedProof, writeCachedProof, clearCachedProof } from './password-proof'
import type {
  FullStateSnapshot,
  RemoteAuthInfo,
  RemoteAuthMethod,
  RemoteKdfParams
} from '../shared/remote-protocol'

// The access token, the optional E2E key AND a one-time enrollment token all
// ride the URL fragment. Browsers never send the fragment to the server, so
// none of them ever appears in the HTTP request line — keeping them out of
// tunnel/CDN access logs (H2). They reach the client only by scanning the QR
// code / opening the copied link.
const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const fragmentToken = fragment.get('t') || ''
const e2eKeyHex = fragment.get('k') || undefined
/** `#enroll=<token>` — a desktop-minted "add this device" link (ADR-052). */
const enrollToken = fragment.get('enroll') || ''

// ONE connection instance for the page lifetime. `window.api` is bound to it
// before React mounts, so the password re-prompt path must revive this instance
// (setCredential + connect) rather than construct a replacement the adapter
// would never see.
//
// Credential precedence mirrors the server's own branch order: an enrollment
// link is a deliberate, single-purpose visit and wins over a stale `t=` in the
// same fragment.
const connection = new RemoteConnection(
  window.location.href,
  enrollToken ? { enrollToken } : fragmentToken ? { token: fragmentToken } : {},
  e2eKeyHex
)
const api = createWebSocketApi(connection)
;(window as unknown as { api: typeof api }).api = api
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
 * the API present and `navigator.credentials` unusable. Used to decide whether
 * OFFERING enrollment makes sense — never to decide anything the server decides.
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

type PasswordParams = { saltHex: string; kdf: RemoteKdfParams }

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
    enrollToken ? { kind: 'enroll' } : fragmentToken ? { kind: 'connecting' } : { kind: 'probing' }
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
    return () => {
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
    const noteAdvertisement = (info: RemoteAuthInfo): void => {
      const advertised = Boolean(info.webauthn)
      passkeyAdvertised.current = advertised
      connection.setWebauthnAdvertised(advertised)
    }

    const fetchAuthInfo = async (): Promise<RemoteAuthInfo> => {
      const res = await fetch(AUTH_INFO_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`auth-info returned HTTP ${res.status}`)
      return (await res.json()) as RemoteAuthInfo
    }

    if (enrollToken || fragmentToken) {
      connection.connect()
      // Alongside, never instead: discovery must not delay a connect that has
      // a credential in hand, and a failed probe must not break one either.
      void fetchAuthInfo().then(
        (info) => {
          if (!cancelled) noteAdvertisement(info)
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
        if (info.version !== 1) {
          setPhase({
            kind: 'unavailable',
            detail: 'This server speaks a newer remote protocol — update the desktop app.'
          })
          return
        }
        noteAdvertisement(info)
        // Tailnet identity (Phase 3). A non-null `login` means the server already
        // recognises THIS browser as the node owner from the `tailscale serve`
        // identity headers, so there is no credential to collect: connect with an
        // empty credential and let the server's unsolicited auth-response drive
        // the rest. A null `login` (advertised but not us — tagged device, a
        // colleague, or a request that didn't come through serve) falls through to
        // the password flow, which is exactly what such a caller needs.
        if (info.methods?.includes('tailnet-identity') && info.identity?.login) {
          connection.setCredential({})
          setPhase({ kind: 'connecting' })
          connection.connect()
          return
        }
        const params: PasswordParams | null = info.password
          ? { saltHex: info.password.saltHex, kdf: info.password.kdf }
          : null
        // Recorded even when we lead with the passkey: it is what the
        // break-glass link falls back to, and what an `auth-rejected` recovers
        // onto without a second discovery round trip.
        if (params && info.methods?.includes('password')) pwParams.current = params
        // Passkey-first (ADR-052). An advertisement means ≥1 credential is
        // enrolled AND this Host can do WebAuthn, so a one-tap sign-in is the
        // right lead. The POLICY is deliberately not advertised, so this cannot
        // know whether the server will actually accept a ceremony — if it
        // refuses (`passkey-unavailable` under `legacy`), the rejection path
        // drops back to the password form, which is why the params above are
        // captured first.
        if (info.webauthn) {
          setPhase({ kind: 'passkey' })
          return
        }
        if (!pwParams.current || !params) {
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

  if (phase.kind === 'password') {
    return (
      <PasswordLogin
        saltHex={phase.params.saltHex}
        kdf={phase.params.kdf}
        error={phase.error}
        onProof={handleProof}
      />
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
    )
  }
  if (phase.kind === 'unavailable') {
    return <MissingCredential detail={phase.detail} />
  }
  if (phase.kind === 'probing') {
    return <ConnectionOverlay state="connecting" />
  }

  // The offer only makes sense for a PASSWORD connection in a browser that
  // could actually run a ceremony: a passkey connection already has one, and a
  // token / tailnet one holds no `enroll` to use.
  //
  // Deliberately NOT gated on the passkey advertisement. That flag needs ≥1
  // credential to be present, which would hide the offer in precisely the case
  // where the operator most needs to be told something — their first web login,
  // nothing enrolled yet, wondering where passkeys live. Offering there and
  // letting the server refuse is how they learn the first one comes from the
  // desktop (see EnrollPrompt's `needsDesktop` branch).
  const offerEnroll =
    enrollOffered &&
    authMethod === 'password' &&
    browserCanAttemptWebauthn() &&
    connState === 'connected'

  return (
    <>
      {authMethod === 'none' && <NoAuthBanner />}
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
