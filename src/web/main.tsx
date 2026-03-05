import './main.css'

import { StrictMode, useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConnection, type ConnectionState } from './connection'
import { createWebSocketApi } from './api-adapter'
import { ConnectionOverlay } from './components/ConnectionOverlay'
import type { FullStateSnapshot } from '../shared/remote-protocol'

// Parse connection params from URL
const params = new URLSearchParams(window.location.search)
const token = params.get('t') || ''

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
  const connection = new RemoteConnection(window.location.href, token)
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
      // Apply the full snapshot to the Zustand store (settings, sessions, config)
      import('@renderer/stores/session-store').then(({ useSessionStore }) => {
        useSessionStore.getState().applyRemoteSnapshot(snapshot)
        setReady(true)
      })
    }, [])

    const handleCatchup = useCallback((events: Array<{ seq: number; channel: string; args: unknown[] }>) => {
      // Replay catchup events through the event system
      for (const event of events) {
        // The api-adapter's event handler is already wired up
        // Events will flow through the normal onMessage/onStreamEvent/etc. paths
      }
      void events // consumed by the event handler in api-adapter
    }, [])

    useEffect(() => {
      connection.setStateHandler(handleStateChange)
      connection.setFullStateHandler(handleFullState)
      connection.setCatchupHandler(handleCatchup)
      connection.connect()

      return () => {
        connection.destroy()
      }
    }, [handleStateChange, handleFullState, handleCatchup])

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
