import { useSessionStore, normalizeCwd } from '../../stores/session-store'

/**
 * Flip the bottom terminal panel open/closed, auto-creating the first tab for
 * the active session's cwd when opening into an empty group.
 *
 * Single source of truth for the affordance: the Ctrl/Cmd+` keydown handler in
 * SessionView and the TopBar button both call this, so the two can never drift.
 * The keybinding alone was unreachable on web (macOS eats Cmd+`, Edge swallows
 * Ctrl+`), which is why the button exists at all.
 *
 * Deliberately dumb about availability — the panel itself renders the remote
 * gate / step-up prompt (TerminalPanel), so this never needs to know whether
 * the host will actually hand out a shell.
 */
export function toggleTerminalPanel(): void {
  const state = useSessionStore.getState()
  const willOpen = !state.terminalPanelOpen
  state.setTerminalPanelOpen(willOpen)

  // Auto-create first terminal if opening and no tabs for this cwd — but only
  // when there IS an active cwd. Without one (the welcome screen), the old '.'
  // fallback spawned a real PTY into group '.' that no view ever shows
  // (selectVisibleTerminalTabs bails on an empty cwd), i.e. an invisible orphan
  // shell. Opening the panel alone is right there: it renders its own
  // "Press + to open a terminal" empty state.
  if (willOpen) {
    const cwd = state.activeSessionId ? state.sessions[state.activeSessionId]?.cwd : undefined
    if (!cwd) return
    const key = normalizeCwd(cwd)
    const group = state.terminalGroups[key]
    if (!group || group.tabs.length === 0) {
      window.api.createTerminal(cwd).then((terminalId) => {
        state.addTerminalTab({ id: terminalId, title: 'Terminal', cwd })
      })
    }
  }
}
