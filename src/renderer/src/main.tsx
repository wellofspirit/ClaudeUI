import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { hydrateConfigFromDisk } from './stores/session-store'

// Hydrate persisted config from ~/.claude/ui/config.json, then render
hydrateConfigFromDisk().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
