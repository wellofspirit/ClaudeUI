import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SettingsDialog, SettingsToggle } from '../SettingsDialog'
import { SECTION_SCOPE_MAP, type SettingsScope } from '../SettingsDialog/settings-sections'
import { UsageRing } from './UsagePanel'

// Lazy: the modal tree + qrcode must not ride the eager App chunk — the trigger
// below is desktop-only, so on the web client THIS modal is unreachable. Its
// `AccessLinks` card is not, as of series M4: Settings › Remote mounts that card
// on its own (`SettingsDialog/WebAccessLinks`, lazy for the same reason), so the
// shared bytes are now split into a chunk both entries pull. The specifier must
// stay '../RemoteAccessModal' for tests that mock that exact module id.
const RemoteAccessModal = lazy(() =>
  import('../RemoteAccessModal').then((m) => ({ default: m.RemoteAccessModal }))
)

export function SettingsPanel(): React.JSX.Element {
  /**
   * On mobile this panel lives inside the sidebar DRAWER, which SessionView
   * unmounts the moment it closes — so a dialog hosted here could never survive
   * "open Settings, dismiss the drawer". There, `open-settings` is handled by
   * SessionView instead (which owns the drawer) and this panel only fires the
   * event. Desktop keeps hosting the dialog itself, unchanged.
   */
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [settingsTarget, setSettingsTarget] = useState<{
    scope?: SettingsScope
    section?: string
  }>({})
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
  //
  // Narrowing past the breakpoint hands this dialog to SessionView, so a dialog
  // opened while wide must CLOSE here rather than linger: left open it would
  // render the mobile takeover from inside the drawer, and any `open-settings`
  // fired from within it (settings-sections' "Open Providers & models",
  // PiVendors) would mount a SECOND takeover from SessionView on top.
  useEffect(() => {
    if (isMobile) {
      setDialogOpen(false)
      setSettingsTarget({})
      return
    }
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ scope?: SettingsScope; section?: string }>).detail
      setSettingsTarget({
        scope:
          detail?.scope ?? (detail?.section ? SECTION_SCOPE_MAP.get(detail.section) : undefined),
        section: detail?.section
      })
      setDialogOpen(true)
    }
    window.addEventListener('open-settings', handler)
    return () => window.removeEventListener('open-settings', handler)
  }, [isMobile])

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
              if (isMobile) {
                // SessionView answers this, opens the fullscreen mobile view and
                // dismisses the drawer this button sits in.
                window.dispatchEvent(new CustomEvent('open-settings', { detail: {} }))
                return
              }
              setSettingsTarget({})
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
      {dialogOpen && (
        <SettingsDialog
          onClose={() => setDialogOpen(false)}
          initialScope={settingsTarget.scope}
          initialSection={settingsTarget.section}
        />
      )}
      {remoteModalOpen && (
        <Suspense fallback={null}>
          <RemoteAccessModal onClose={() => setRemoteModalOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
