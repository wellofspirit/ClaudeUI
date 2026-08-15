import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  selectVisibleTerminalTabs,
  selectActiveTerminalId,
  selectAllTerminalTabs
} from '../../../stores/session-store'
import { isNeedsStepUpError } from '../../../../../shared/remote-protocol'
import type { TerminalAvailability } from '../../../../../shared/types'
import { TerminalStepUpPrompt } from '../TerminalStepUpPrompt'
import { DESKTOP_AVAILABILITY } from '../terminal-availability'
import { nextFreeSlot } from '../pool-slot'
import { TerminalPanelView } from './View'

interface Props {
  style: React.CSSProperties
}

export function TerminalPanel({ style }: Props): React.JSX.Element {
  const visibleTabs = useSessionStore(useShallow(selectVisibleTerminalTabs))
  const activeId = useSessionStore(selectActiveTerminalId)
  const allTabs = useSessionStore(useShallow(selectAllTerminalTabs))
  const addTerminalTab = useSessionStore((s) => s.addTerminalTab)
  const closeTerminalTab = useSessionStore((s) => s.closeTerminalTab)
  const removeTerminalTab = useSessionStore((s) => s.removeTerminalTab)
  const setActiveTerminal = useSessionStore((s) => s.setActiveTerminal)
  const setTerminalPanelOpen = useSessionStore((s) => s.setTerminalPanelOpen)

  // Optional chaining, like every other platform probe in the renderer: a
  // re-render can be flushed after a test harness (or a teardown path) has
  // dropped `window.api`, and "no api" is never "web".
  const isWeb = window.api?.platform === 'web'
  const [availability, setAvailability] = useState<TerminalAvailability | null>(
    isWeb ? null : DESKTOP_AVAILABILITY
  )

  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId
    return id ? (s.sessions[id]?.cwd ?? '') : ''
  })

  /** Capability honesty: the affordance is driven by the server's answer only. */
  const refreshAvailability = useCallback(async (): Promise<void> => {
    if (!isWeb) return
    try {
      setAvailability(await window.api.terminalAvailability())
    } catch {
      // An older host (or a dropped connection) means "no terminal here" —
      // never optimistically render a shell we cannot actually drive.
      setAvailability({ allowed: false, granted: false, needsStepUp: false, stepUp: null })
    }
  }, [isWeb])

  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])

  // The server can revoke under us: the owner flips the toggle off, or the
  // grant decays while the panel sits open. Re-ask rather than leaving a dead
  // terminal that silently stops echoing.
  useEffect(() => {
    if (!isWeb) return
    return window.api.onTerminalDetached(() => {
      void refreshAvailability()
    })
  }, [isWeb, refreshAvailability])

  const handleNewTab = async (): Promise<void> => {
    const target = cwd || '.'
    // Terminals are an ordered per-cwd POOL shared by every surface: this asks
    // for the lowest slot this surface is not already showing. If another
    // surface (a phone, the desktop) already holds that slot, we ATTACH to its
    // pty and replay its scrollback instead of spawning a second shell.
    const index = nextFreeSlot(visibleTabs)
    try {
      const terminalId = await window.api.createTerminal(target, index)
      // Defensive: a slot we believed free resolving to a pty we already show
      // (possible if another surface reshuffled the pool between render and
      // click) must select that tab, never duplicate it.
      if (allTabs.some((t) => t.id === terminalId)) {
        setActiveTerminal(terminalId, target)
        return
      }
      addTerminalTab({ id: terminalId, title: 'Terminal', cwd: target, poolIndex: index })
    } catch (err) {
      // The grant decayed between the availability check and the click. Keep
      // whatever step-up params the last query returned — only the grant died.
      if (isWeb && isNeedsStepUpError(err)) {
        setAvailability((prev) => ({
          allowed: true,
          granted: false,
          needsStepUp: true,
          stepUp: prev?.stepUp ?? null
        }))
        return
      }
      throw err
    }
  }

  /**
   * Close a tab, and on Shift-click KILL the pty behind it.
   *
   * Closing became detach-only when terminals became a shared per-cwd pool, which
   * left no way at all to stop a runaway process (a dev server, a `tail -f`) from
   * the UI: the cold sweep only reaps cwds with no live session, i.e. never the
   * one you are working in. Shift is the modifier because the SAFE action must
   * stay the unmodified one — closing a viewer must not take a shell away from
   * another viewer by accident.
   */
  const handleCloseTab = useCallback(
    (id: string, kill?: boolean): void => {
      if (kill) {
        // Best-effort: a pty that is already gone (or a decayed grant) must
        // still close the tab, which is the part the user asked for.
        void window.api.killTerminal(id).catch(() => {})
      }
      closeTerminalTab(id)
    },
    [closeTerminalTab]
  )

  // Listen for PTY exit events
  useEffect(() => {
    const unsub = window.api.onTerminalExit(({ terminalId }) => {
      removeTerminalTab(terminalId)
    })
    return unsub
  }, [removeTerminalTab])

  if (isWeb && (!availability || !availability.allowed || availability.needsStepUp)) {
    return (
      <div
        data-testid="TerminalPanel"
        style={style}
        className="flex flex-col bg-bg-primary border-t border-border overflow-hidden"
      >
        <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-secondary border-b border-border shrink-0">
          <button
            data-testid="TerminalPanel.close"
            onClick={() => setTerminalPanelOpen(false)}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-[10px]"
            title="Close terminal panel"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {!availability ? (
            <div
              data-testid="TerminalPanel.checking"
              className="h-full flex items-center justify-center text-text-muted text-xs"
            >
              Checking terminal access…
            </div>
          ) : !availability.allowed ? (
            <div
              data-testid="TerminalPanel.unavailable"
              className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center text-text-muted text-xs"
            >
              <div>Remote terminal is turned off.</div>
              <div className="text-[10px] text-text-muted/70 max-w-[380px] leading-snug">
                Turn on “Allow remote terminal” in Settings › Remote on the desktop app to open a
                shell from here.
              </div>
            </div>
          ) : (
            <TerminalStepUpPrompt
              passkey={availability.passkey}
              onGranted={() => void refreshAvailability()}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <TerminalPanelView
      style={style}
      visibleTabs={visibleTabs}
      allTabs={allTabs}
      activeId={activeId}
      onSelectTab={setActiveTerminal}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      onClosePanel={() => setTerminalPanelOpen(false)}
    />
  )
}
