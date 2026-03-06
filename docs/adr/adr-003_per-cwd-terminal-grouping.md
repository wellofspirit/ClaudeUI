# ADR-003: Group terminal tabs by session cwd with 10-minute cold cleanup

**Status:** Accepted
**Date:** 2026-03-03
**Related:** [ADR-002](adr-002_always-mount-terminal-panel.md) (always-mount pattern reused across groups)

## Context

Terminal tabs were stored as a flat global array (`terminalTabs: TerminalTab[]`) with a single `activeTerminalId`. When switching between sessions with different working directories, all terminals from every project were visible in the tab bar. This made it hard to manage terminals across projects.

Terminals were already created with the active session's `cwd`, and the `TerminalTab` type already stored a `cwd` field — the grouping information was there, just unused.

## Decision

### Per-cwd terminal groups

Replace the flat terminal state with a cwd-keyed map:

```
terminalGroups: Record<string, { tabs: TerminalTab[], activeTabId: string | null }>
```

Each cwd (normalized — trailing slash stripped) gets its own group with its own tabs and its own active tab. When the user switches sessions, the terminal panel shows the tabs for the new session's cwd. Each group remembers which tab was last active.

### All xterm instances stay mounted

Following ADR-002, ALL terminal instances across ALL groups remain mounted in the DOM with `display: none` for hidden ones. Only the active cwd's active tab gets `display: block`. This preserves scrollback buffers and IPC listeners for every terminal regardless of which project is currently visible.

### Cold cleanup for orphaned groups

When a cwd has terminal tabs but no active session, a 10-minute timer starts. If no session with that cwd reappears within 10 minutes, the PTYs are killed and the group is removed from the store. If a session reappears, the timer is cancelled and the terminals are restored seamlessly.

The timer lives in a `useTerminalColdCleanup` hook mounted in `SessionView`, using a module-scope `Map` for the timeout handles.

### Backend batch kill

A new `killByCwd(cwd)` method on `PtyManager` kills all PTYs spawned with a given cwd in a single call, exposed via `terminal:kill-by-cwd` IPC channel.

## Consequences

- Switching sessions swaps the visible terminal tabs to match the new project
- Multiple sessions sharing the same cwd share the same terminal group
- Orphaned terminals (no session with that cwd) stay alive for 10 minutes, then get cleaned up
- The `closeTerminalTab` and `removeTerminalTab` actions search all groups by terminal ID (O(groups × tabs), negligible at expected scale)
- `setActiveTerminal` now takes `(id, cwd)` instead of just `(id)`
- No migration needed — terminal state is ephemeral (in-memory only, not persisted to disk)
