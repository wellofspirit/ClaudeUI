import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { hydrateConfigFromDisk, getRemoteStateSnapshot } from './stores/session-store'

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

// Expose state snapshot for remote access (called from main process via executeJavaScript)
;(window as unknown as Record<string, unknown>).__getRemoteState = getRemoteStateSnapshot

// Hydrate persisted config from ~/.claude/ui/config.json, then render
hydrateConfigFromDisk().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
