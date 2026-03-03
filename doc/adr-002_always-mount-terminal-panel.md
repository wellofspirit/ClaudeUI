# ADR-002: Always mount TerminalPanel to preserve xterm scrollback buffers

**Status:** Accepted
**Date:** 2026-03-03

## Context

ClaudeUI has an integrated terminal panel (xterm.js in the renderer, node-pty in the main process). The panel can be toggled open/closed via `Ctrl+\`` or a close button.

### The problem

When the terminal panel was closed and reopened, all terminal content (scrollback history) was lost. The shell session was still running, but the terminal appeared blank.

### Root cause

`SessionView.tsx` used **conditional rendering** for the terminal panel:

```tsx
{terminalPanelOpen && (
  <>
    <HorizontalResizeHandle ... />
    <TerminalPanel ... />
  </>
)}
```

When `terminalPanelOpen` flipped to `false`, React **unmounted** the entire component tree. Each `XTermInstance`'s cleanup effect ran `term.dispose()`, destroying the xterm.js `Terminal` instance and its scrollback buffer. The `onTerminalData` IPC listener was also unsubscribed.

Meanwhile, the PTY processes in the main process (`PtyManager`) continued running. Any shell output emitted while the panel was closed was sent via IPC but had no listener — the data was silently lost.

On reopen, fresh xterm.js `Terminal` instances were created with empty buffers. Only new output appeared.

### Existing pattern

Inside `TerminalPanel` itself, individual terminal tabs already used `display: block/none` to stay mounted while hidden:

```tsx
<div style={{ display: tab.id === activeId ? 'block' : 'none' }}>
  <XTermInstance ... />
</div>
```

This worked correctly — switching tabs preserved scrollback. The panel-level toggle just wasn't following the same pattern.

## Decision

Always mount `TerminalPanel` in the DOM. Use `display: contents` (open) / `display: none` (closed) on a wrapper `<div>` to control visibility without unmounting.

```tsx
<div style={{ display: terminalPanelOpen ? 'contents' : 'none' }}>
  <HorizontalResizeHandle ... />
  <TerminalPanel ... />
</div>
```

`display: contents` makes the wrapper transparent to CSS layout — children participate in the parent's flexbox as if the wrapper doesn't exist.

## Consequences

- xterm.js `Terminal` instances and their scrollback buffers survive panel close/reopen
- `onTerminalData` IPC listeners stay subscribed, so no PTY output is lost while the panel is hidden
- The `onTerminalExit` listener in `TerminalPanel` is always active, so exited shells are cleaned up even when the panel is closed
- Marginal memory cost: hidden xterm.js instances retain their scrollback buffers (default 1000 lines per terminal) — negligible for typical usage
