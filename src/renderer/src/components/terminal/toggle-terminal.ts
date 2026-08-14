import { useSessionStore, normalizeCwd } from '../../stores/session-store'

/**
 * Does this keydown mean "toggle the terminal panel"?
 *
 * Two bindings, both live on every platform:
 *
 *  - Ctrl/Cmd+` — the original. Unreachable in a browser (macOS owns Cmd+`,
 *    Edge swallows Ctrl+`), which is why the TopBar button exists at all.
 *  - Alt+` — the escape hatch for exactly those hosts.
 *
 * The alt arm matches on `e.code`, NOT `e.key`: in most macOS layouts Option+`
 * is a DEAD KEY (it starts a grave-accent composition), so the keydown arrives
 * with `e.key === 'Dead'` while `e.code` still names the physical key. Matching
 * on `key` would make the new binding a no-op on precisely the platform whose
 * Cmd+` was stolen in the first place.
 */
export function isTerminalToggleShortcut(e: KeyboardEvent): boolean {
  const ctrlOrCmdBackquote = e.key === '`' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
  const altBackquote = e.code === 'Backquote' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
  return ctrlOrCmdBackquote || altBackquote
}

/**
 * Flip the bottom terminal panel open/closed, auto-creating the first tab for
 * the active session's cwd when opening into an empty group.
 *
 * Single source of truth for the affordance: SessionView's keydown handler (via
 * {@link isTerminalToggleShortcut}) and the TopBar button both call this, so the
 * two can never drift. The keybinding alone was unreachable on web (macOS eats
 * Cmd+`, Edge swallows Ctrl+`), which is why the button exists at all.
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
