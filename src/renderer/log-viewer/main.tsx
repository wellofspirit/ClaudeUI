import './log-viewer.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LogViewer } from './LogViewer'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LogViewer />
  </StrictMode>
)
