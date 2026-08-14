import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { hydrateConfigFromDisk } from './stores/session-store'
import { startReplica, hydrateReplica } from './stores/replica'
import { startDesktopSync } from './sync/desktop-transport'

// Global error handlers — forward uncaught renderer errors to the main process log file
window.onerror = (message, source, lineno, colno, error): void => {
  const detail = error?.stack ?? `${message} at ${source}:${lineno}:${colno}`
  window.api.logError('window', detail)
}

window.onunhandledrejection = (event: PromiseRejectionEvent): void => {
  const reason = event.reason
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  window.api.logError('unhandledRejection', detail)
}

// SyncCore phase 4c: become client #1, with the shared reducer owning every
// replicated slice of the store.
//
// The replica's tap is installed BEFORE the transport, so no event can arrive
// unfolded; the transport is started before hydration so the port hand-off is in
// flight while the disk reads happen, and so the `message` listener exists well
// before main posts the port.
//
// Ordering against `hydrateConfigFromDisk`: both write app-level config through the
// replica, and both read the SAME source — canonical's copy was seeded from these
// very files at boot (`services/sync-seed.ts`) — so whichever lands second writes
// equal values. `hydrateReplica`'s catalog fallbacks are what keep a snapshot with
// no sessions (a cold desktop boot) from blanking what hydration filled in.
startReplica()
startDesktopSync((snapshot, isResync) => {
  hydrateReplica(snapshot, isResync)
})

// Hydrate persisted config from ~/.claude/ui/config.json, then render
hydrateConfigFromDisk().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
})
