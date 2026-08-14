import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { hydrateConfigFromDisk, getRemoteStateSnapshot, useSessionStore } from './stores/session-store'
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

// Expose state snapshot for the dev shadow comparator (main pulls it via
// executeJavaScript when CLAUDEUI_SYNC_SHADOW=1). No longer a sync path: since
// phase 4b the `sync-full` snapshot comes from canonical state.
;(window as unknown as Record<string, unknown>).__getRemoteState = getRemoteStateSnapshot

// SyncCore phase 4c: become client #1. Started BEFORE hydration so the port
// hand-off is in flight while the disk reads happen, and so the `message`
// listener exists well before main posts the port.
//
// Ordering against `hydrateConfigFromDisk`: both write app-level config, and both
// read the SAME source — canonical's copy was seeded from these very files at boot
// (`services/sync-seed.ts`) — so whichever lands second writes equal values.
// `applyRemoteSnapshot`'s `?? state.x` fallbacks are what keep a snapshot with no
// sessions (a cold desktop boot) from blanking the catalogs hydration filled in.
startDesktopSync((snapshot, isResync) => {
  useSessionStore.getState().applyRemoteSnapshot(snapshot, isResync)
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
