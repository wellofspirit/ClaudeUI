import './main.css'

import { StrictMode, useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConnection, type ConnectionState } from './connection'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { createWebSocketApi } from './api-adapter'
import { ConnectionOverlay } from './components/ConnectionOverlay'
import { PasswordLogin } from './components/PasswordLogin'
import { MissingCredential } from './components/MissingCredential'
import { readCachedProof, writeCachedProof, clearCachedProof } from './password-proof'
import type { FullStateSnapshot, RemoteAuthInfo, RemoteKdfParams } from '../shared/remote-protocol'

// The access token AND the optional E2E key both ride the URL fragment.
// Browsers never send the fragment to the server, so neither ever appears in
// the HTTP request line — keeping the token out of tunnel/CDN access logs (H2).
// They reach the client only by scanning the QR code / opening the copied link.
const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const fragmentToken = fragment.get('t') || ''
const e2eKeyHex = fragment.get('k') || undefined

// ONE connection instance for the page lifetime. `window.api` is bound to it
// before React mounts, so the password re-prompt path must revive this instance
// (setCredential + connect) rather than construct a replacement the adapter
// would never see.
const connection = new RemoteConnection(
  window.location.href,
  fragmentToken ? { token: fragmentToken } : {},
  e2eKeyHex
)
const api = createWebSocketApi(connection)
;(window as unknown as { api: typeof api }).api = api

/** Discovery endpoint. Absolute path — the server matches `/remote/auth-info`
 *  exactly, and `/remote` (no trailing slash) would resolve a relative
 *  `auth-info` to `/auth-info`. */
const AUTH_INFO_URL = new URL('/remote/auth-info', window.location.origin).toString()

type PasswordParams = { saltHex: string; kdf: RemoteKdfParams }

/** What the pre-connection auth flow is currently doing. */
type AuthPhase =
  /** Fetching /remote/auth-info (no fragment token to go on). */
  | { kind: 'probing' }
  /** A credential is in hand; the connection drives the UI from here. */
  | { kind: 'connecting' }
  /** Waiting on the user's password. */
  | { kind: 'password'; params: PasswordParams; error?: string }
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
    fragmentToken ? { kind: 'connecting' } : { kind: 'probing' }
  )
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  /** Latest advertised password params, so a rejection can re-show the form
   *  (and know which cache entry to drop) without re-fetching auth-info. */
  const pwParams = useRef<PasswordParams | null>(null)
  /** Flips true after the first `sync-full` is applied. A later `sync-full`
   *  (background/foreground reconnect) is a RE-sync, not a first hydration —
   *  applyRemoteSnapshot must not clobber local navigation (e.g. a
   *  mobile-hydrated historical session) with the desktop's snapshot. */
  const hasHydratedRef = useRef(false)

  const handleStateChange = useCallback((state: ConnectionState, err?: string) => {
    setConnState(state)
    setError(err)
    // Every connect path — fragment token, tailnet identity, password proof —
    // goes through connection.connect(), which emits 'connecting' before it
    // opens the socket, and nothing else emits it. So this starts the App
    // download exactly when a credential is in play and never for a visitor
    // idling on the login form. Rejection is swallowed here because AppContent's
    // own loadApp() is the one that reports it.
    if (state === 'connecting') void loadApp().catch(() => {})
    if (state === 'auth-rejected') {
      const params = pwParams.current
      // The proof we hold is dead — wrong password, a rotated credential
      // (close 4008), or a throttled key. Drop the cache and re-prompt rather
      // than showing the dead-end "Connection Failed" overlay.
      if (params) {
        clearCachedProof(params.saltHex)
        setPhase({ kind: 'password', params, error: err })
      }
    }
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
    // Apply the full snapshot to the Zustand store (settings, sessions, config).
    // isResync=true from the second sync-full onward — see hasHydratedRef.
    const isResync = hasHydratedRef.current
    hasHydratedRef.current = true
    import('@renderer/stores/session-store').then(({ useSessionStore }) => {
      useSessionStore.getState().applyRemoteSnapshot(snapshot, isResync)
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

  // Bootstrap: fragment token → connect straight away (unchanged path).
  // Otherwise ask the server which methods it offers.
  useEffect(() => {
    if (fragmentToken) {
      connection.connect()
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(AUTH_INFO_URL, { cache: 'no-store' })
        if (!res.ok) throw new Error(`auth-info returned HTTP ${res.status}`)
        const info = (await res.json()) as RemoteAuthInfo
        if (cancelled) return
        if (info.version !== 1) {
          setPhase({
            kind: 'unavailable',
            detail: 'This server speaks a newer remote protocol — update the desktop app.'
          })
          return
        }
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
        if (!info.methods?.includes('password') || !info.password) {
          setPhase({ kind: 'unavailable' })
          return
        }
        const params: PasswordParams = {
          saltHex: info.password.saltHex,
          kdf: info.password.kdf
        }
        pwParams.current = params
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
  if (phase.kind === 'unavailable') {
    return <MissingCredential detail={phase.detail} />
  }
  if (phase.kind === 'probing') {
    return <ConnectionOverlay state="connecting" />
  }

  return (
    <>
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
