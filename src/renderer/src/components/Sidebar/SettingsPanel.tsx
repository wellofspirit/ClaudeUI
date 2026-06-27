import { useState, useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { SettingsDialog, SettingsToggle } from '../SettingsDialog'
import { RemoteAccessModal } from '../RemoteAccessModal'
import { UsageRing } from './UsagePanel'

export function SettingsPanel(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  const [remoteClients, setRemoteClients] = useState(0)
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const panelRef = useRef<HTMLDivElement>(null)

  // Track remote server status
  useEffect(() => {
    if (window.api.platform === 'web') return
    window.api.getRemoteStatus().then((s) => {
      if (s) {
        setRemoteRunning(s.running)
        setRemoteClients(s.connectedClients)
      }
    })
    const cleanup = window.api.onRemoteStatus((s) => {
      if (s) {
        setRemoteRunning(s.running)
        setRemoteClients(s.connectedClients)
      }
    })
    return cleanup
  }, [])

  // Listen for 'open-settings' custom events (e.g. from sandbox pill in InputBox)
  useEffect(() => {
    const handler = (): void => setDialogOpen(true)
    window.addEventListener('open-settings', handler)
    return () => window.removeEventListener('open-settings', handler)
  }, [])

  // Close popup on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div data-testid="SettingsPanel" ref={panelRef}>
      {open && (
        <div className="border-t border-border/50 px-2 py-1 bg-white/5 rounded-t-lg">
          {/* Theme selector */}
          <div className="px-3 pt-2 pb-1">
            <div className="text-[11px] text-text-muted uppercase tracking-wider mb-1">Theme</div>
            <div className="flex items-center gap-1 mb-1 bg-bg-primary/50 rounded-md p-0.5">
              {(['dark', 'light', 'monokai'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => updateSettings({ theme: t })}
                  className={`flex-1 text-[11px] py-1 rounded transition-colors capitalize ${settings.theme === t ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-secondary hover:bg-white/5'}`}
                >
                  {t === 'monokai' ? 'Monokai' : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {/* Tool output toggles */}
          <SettingsToggle
            label="Expand tool calls"
            checked={settings.expandToolCalls}
            onChange={(v) => updateSettings({ expandToolCalls: v })}
          />
          {settings.expandToolCalls && (
            <div className="pl-4">
              <SettingsToggle
                label="Include read results"
                checked={settings.expandReadResults}
                onChange={(v) => updateSettings({ expandReadResults: v })}
              />
            </div>
          )}
          <SettingsToggle
            label="Hide tool input"
            checked={settings.hideToolInput}
            onChange={(v) => updateSettings({ hideToolInput: v })}
          />
          <SettingsToggle
            label="Expand thinking"
            checked={settings.expandThinking}
            onChange={(v) => updateSettings({ expandThinking: v })}
          />
          {/* All Settings button */}
          <button
            data-testid="SettingsPanel.allSettings"
            onClick={() => {
              setOpen(false)
              setDialogOpen(true)
            }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-1 mb-0.5 text-[12px] text-text-muted hover:text-accent transition-colors cursor-default border-t border-border/30 pt-2"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            All Settings…
          </button>
        </div>
      )}
      <div
        style={{ padding: '8px 16px' }}
        className="border-t border-border/50 flex items-center gap-2.5 text-[11px] text-text-muted"
      >
        <UsageRing />
        {window.api.platform !== 'web' && (
          <button
            data-testid="SettingsPanel.remoteAccess"
            onClick={() => setRemoteModalOpen(true)}
            className="flex items-center gap-1 h-6 rounded-md hover:bg-bg-hover transition-colors cursor-default ml-auto px-1"
            title="Remote Access"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={remoteRunning ? 'text-accent' : 'text-text-muted'}
            >
              <path d="M5 12.55a11 11 0 0114.08 0" />
              <path d="M1.42 9a16 16 0 0121.16 0" />
              <path d="M8.53 16.11a6 6 0 016.95 0" />
              <circle cx="12" cy="20" r="1" />
            </svg>
            {remoteRunning && remoteClients > 0 && (
              <span className="text-accent text-[11px] font-medium leading-none">
                {remoteClients}
              </span>
            )}
          </button>
        )}
        <button
          data-testid="SettingsPanel.toggle"
          onClick={() => setOpen(!open)}
          className={`flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-colors cursor-default ${window.api.platform === 'web' ? 'ml-auto' : ''}`}
          title="Settings"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-text-muted"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
      {dialogOpen && <SettingsDialog onClose={() => setDialogOpen(false)} />}
      {remoteModalOpen && <RemoteAccessModal onClose={() => setRemoteModalOpen(false)} />}
    </div>
  )
}
