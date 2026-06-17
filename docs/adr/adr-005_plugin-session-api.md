# ADR-005: Plugin Session API — SessionId-Based Events and History

**Status:** Accepted
**Date:** 2026-04-11
**Supersedes:** Partial rethink of plugin-api-requests.md item #3

## Context

Plugins that manage Claude sessions (e.g., a WeChat messaging bridge with navigator + worker sessions) need to:

1. **Track session identity** — to resume sessions later and correlate events across restarts.
2. **Access full chat history** — to render session content in their own plugin views.
3. **View rich message data** — tool calls, thinking blocks, tool results — not just plain text.

The initial proposal (docs/plugin-api-requests.md #3) suggested an IPC channel to switch the main UI to a session's ChatPanel. This is the wrong abstraction — it hijacks the main UI, breaks plugin UX flow, and couples plugins to core routing.

A separate concern: `routingId` is a transient, internal identifier used by SessionManager to map sessions to BrowserWindows. It's not stable across restarts and is an implementation detail. Plugins should primarily work with `sessionId` (the SDK UUID), which is stable, resumable, and maps to disk-level chat history.

However, `sessionId` is `null` until the first SDK response (captured from `session_id` field on the first assistant message). Events emitted before that point have no sessionId.

## Decision

### 1. Event Shape: Object with Both IDs

All session events forwarded to plugins use a structured object instead of positional arguments. Both `routingId` and `sessionId` are included:

```typescript
ctx.on('session:message', (event: {
  routingId: string
  sessionId: string | null
  message: ChatMessage
}) => { ... })

ctx.on('session:result', (event: {
  routingId: string
  sessionId: string | null
  totalCostUsd: number
  durationMs: number
  result: string
}) => { ... })

// Same pattern for session:stream, session:status, etc.
```

**Why both IDs:**

- Early events (before first SDK response) arrive with `sessionId: null`. The plugin uses `routingId` as a temporary key.
- Once `sessionId` appears, the plugin knows the `routingId → sessionId` mapping and re-keys its internal state.
- From that point, the plugin uses `sessionId` for all durable operations (history queries, resume).
- The core doesn't need to buffer, replay, or hide the reality of async sessionId availability.

**Why an object, not positional args:**

- Self-documenting — no guessing what the 3rd parameter means.
- Extensible — adding fields (e.g., `teamName`, `isSubagent`) doesn't break existing handlers.

### 2. Session History Query

Plugins can fetch the full message history for a session:

```typescript
ctx.sessions.getMessages(sessionId: string): ChatMessage[]
```

This enables:

- Backfilling a plugin's chat view when opened after messages were already exchanged.
- Loading history from previous app sessions (sessionId maps to disk-level storage).

### 3. SessionId Getter

Expose the SDK session UUID through SessionManager:

```typescript
ctx.sessions.getSessionId(routingId: string): string | null
```

This is a bridge for plugins that create sessions via `ctx.sessions.create(routingId, ...)` and need to discover the sessionId after the first message exchange.

### 4. Plugin Renders Its Own View

Plugins render session content in their own webview — the core does not provide a "switch to session" mechanism. Since `session:message` already sends full `ChatMessage` objects with all `ContentBlock` types (text, tool_use, tool_result, thinking), plugins have everything they need to render rich chat views.

## Consequences

- Plugins get a stable, resumable session identifier without being exposed to internal routing mechanics.
- The event object pattern establishes a convention for all future plugin events — always structured, always extensible.
- No buffering complexity in the core — the null-to-available sessionId transition is the plugin's responsibility.
- Plugin views are fully decoupled from the core ChatPanel, enabling custom UX (filtered views, multi-session layouts, summary panels).
- `routingId` remains available for the narrow case where plugins need to correlate with SessionManager operations before sessionId is known.
