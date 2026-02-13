import { useState } from 'react'
import { useSessionStore } from '../stores/session-store'
import { v4 as uuid } from 'uuid'

export function WelcomeScreen(): React.JSX.Element {
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const [loading, setLoading] = useState(false)

  const handleOpen = async (): Promise<void> => {
    setLoading(true)
    try {
      const folder = await window.api.pickFolder()
      if (folder) {
        const routingId = uuid()
        createNewSession(routingId, folder)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-bg-primary">
      {/* Drag region */}
      <div className="h-12 shrink-0 [-webkit-app-region:drag]" />

      {/* Centered content */}
      <div className="flex-1 flex flex-col items-center justify-center animate-fade-in">
        <div className="w-20 h-20 rounded-[22px] bg-gradient-to-br from-bg-tertiary to-bg-secondary border border-border/60 flex items-center justify-center shadow-lg shadow-black/20 mb-7">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent">
            <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-[28px] font-bold text-text-primary tracking-tight mb-2">ClaudeUI</h1>
        <p className="text-text-secondary text-[15px] mb-14">Desktop interface for Claude Code</p>

        <button
          onClick={handleOpen}
          disabled={loading}
          className="flex items-center gap-2.5 text-[15px] text-text-primary hover:text-accent transition-colors disabled:opacity-50 cursor-pointer"
        >
          {loading ? (
            <svg width="18" height="18" viewBox="0 0 16 16" className="animate-spin-slow text-accent">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span className="font-medium">{loading ? 'Opening...' : 'Open a project folder'}</span>
        </button>

        <p className="mt-3 text-text-muted text-[13px]">Select a project directory to start a Claude session</p>
      </div>
    </div>
  )
}
