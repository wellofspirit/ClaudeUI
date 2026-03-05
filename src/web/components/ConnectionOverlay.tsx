import { useState, useEffect } from 'react'
import type { ConnectionState } from '../connection'

interface ConnectionOverlayProps {
  state: ConnectionState
  error?: string
}

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting...',
  authenticating: 'Authenticating...',
  'e2e-activating': 'Securing connection...',
  syncing: 'Syncing state...',
  connected: 'Connected',
  reconnecting: 'Reconnecting...',
  failed: 'Connection Failed'
}

export function ConnectionOverlay({ state, error }: ConnectionOverlayProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (state === 'connected') {
      // Fade out after a short delay
      const timer = setTimeout(() => setVisible(false), 800)
      return () => clearTimeout(timer)
    }
    setVisible(true)
  }, [state])

  if (!visible) return null

  const isFailed = state === 'failed'
  const isConnected = state === 'connected'

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-300 ${
        isConnected ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{ background: isFailed ? 'rgba(13,17,23,0.95)' : 'rgba(13,17,23,0.85)' }}
    >
      <div className="flex flex-col items-center gap-4 text-center px-6">
        {/* Spinner or status icon */}
        {isFailed ? (
          <div className="w-12 h-12 rounded-full bg-danger/20 flex items-center justify-center">
            <svg className="w-6 h-6 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        ) : isConnected ? (
          <div className="w-12 h-12 rounded-full bg-success/20 flex items-center justify-center">
            <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        ) : (
          <div className="w-12 h-12 relative">
            <div className="absolute inset-0 rounded-full border-2 border-border" />
            <div className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
          </div>
        )}

        {/* State label */}
        <div className="text-text-primary text-lg font-medium">
          {STATE_LABELS[state]}
        </div>

        {/* Error message */}
        {error && (
          <div className="text-danger text-sm max-w-sm">
            {error}
          </div>
        )}

        {/* Reconnecting hint */}
        {state === 'reconnecting' && (
          <div className="text-text-muted text-xs">
            Connection lost. Attempting to reconnect...
          </div>
        )}

        {/* Failed actions */}
        {isFailed && (
          <div className="flex gap-3 mt-2">
            <button
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
