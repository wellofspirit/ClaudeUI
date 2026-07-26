import './main.css'

import { StrictMode, useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConnection, type ConnectionState } from './connection'
import { createWebSocketApi } from './api-adapter'
import { ConnectionOverlay } from './components/ConnectionOverlay'
import type { FullStateSnapshot } from '../shared/remote-protocol'

// The access token AND the optional E2E key both ride the URL fragment.
// Browsers never send the fragment to the server, so neither ever appears in
// the HTTP request line — keeping the token out of tunnel/CDN access logs (H2).
// They reach the client only by scanning the QR code / opening the copied link.
const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const token = fragment.get('t') || ''
const e2eKeyHex = fragment.get('k') || undefined

if (!token) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#d1d5db;font-family:system-ui">
      <div style="text-align:center">
        <h1 style="font-size:1.5rem;margin-bottom:0.5rem">Missing Token</h1>
        <p style="color:#8b929e">Scan the QR code from the desktop app to connect.</p>
      </div>
    </div>
  `
} else {
  // Initialize connection
  const connection = new RemoteConnection(window.location.href, token, e2eKeyHex)
  const api = createWebSocketApi(connection)

  // Install as window.api (same as Electron's contextBridge)
  ;(window as unknown as { api: typeof api }).api = api

  // Root app component that manages connection lifecycle
  function RemoteApp(): React.JSX.Element {
    const [connState, setConnState] = useState<ConnectionState>('connecting')
    const [error, setError] = useState<string>()
    const [ready, setReady] = useState(false)

    const handleStateChange = useCallback((state: ConnectionState, err?: string) => {
      setConnState(state)
      setError(err)
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
      // Apply the full snapshot to the Zustand store (settings, sessions, config)
      import('@renderer/stores/session-store').then(({ useSessionStore }) => {
        useSessionStore.getState().applyRemoteSnapshot(snapshot)
        setReady(true)
      })
    }, [])

    // Catchup events are replayed through the connection's live onEvent handler
    // (see connection.ts sync-catchup), so main.tsx needs no event knowledge.

    useEffect(() => {
      connection.setStateHandler(handleStateChange)
      connection.setFullStateHandler(handleFullState)
      connection.connect()

      return () => {
        connection.destroy()
      }
    }, [handleStateChange, handleFullState])

    return (
      <>
        <ConnectionOverlay state={connState} error={error} />
        {ready && <AppContent />}
      </>
    )
  }

  // Lazy-load the actual app content (same components as Electron renderer)
  function AppContent(): React.JSX.Element {
    const [App, setApp] = useState<React.ComponentType | null>(null)

    useEffect(() => {
      // Dynamic import of the renderer's App to reuse components
      // This works because vite.web.config.ts sets up the @renderer alias
      import('@renderer/App').then((mod) => {
        setApp(() => mod.default)
      })
    }, [])

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
      <RemoteApp />
    </StrictMode>
  )
}
