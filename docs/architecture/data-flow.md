# IPC & data flow

Part of [architecture/](README.md).

## IPC & data flow

- Main ↔ renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`; typed `ClaudeAPI` in `shared/types.ts`, exposed as `window.api`.
- `safeHandler()` wraps handlers in `{ ok, data, error }` envelopes; `unwrap()` in preload throws on failure.
- The same handlers serve WebSocket clients through `remote-dispatcher` (desktop-only channels blocklisted); shared handler bodies live in `ipc/handlers-core.ts`. The remote layer's full shape (and its known defects): [remote.md](remote.md).
- `session:send` is fire-and-forget; results stream back as events:

```
User prompt → InputBox → addUserMessage() (Zustand) → window.api.sendPrompt (IPC)
  → session.run(prompt) → engine backend
    → stream_event   → session:stream          → appendStreamingText()
    → assistant      → session:message         → addMessage() (upsert by ID)
    → user (tool_result) → session:tool-result → appendToolResult()
    → can_use_tool   → session:approval-request → setPendingApproval()
    → result         → session:result           (cost tracking)
```

## Key patterns

- **Message upsert by ID** — partial messages share one `betaMessage.id`; updates replace in place.
- **Approval Promise** — `canUseTool` stores a Promise in a `pendingApprovals` Map, resolved on Allow/Deny. Return `{ behavior: 'allow', updatedInput: input }` or `{ behavior: 'deny', message }`; observe `context.signal` to dismiss the UI on cancellation.
- **Tool results arrive as synthetic `type: 'user'` messages**, extracted by `extractToolResults()`.
- **Multi-session routing** — every session has a `routingId`; events are routed by it. On engine init the temporary routingId is **rekeyed** to the engine's session UUID.
- **cli.js message order** (with partial messages on): `assistant` (partials) → `user` (tool_result) → `assistant` → `result`; `result` cost fields are **cumulative per process** and reset on `--resume`.
- **Git status polling** — `useGitWatcher` states this client's interest (`git:watch {cwds}`, a replace set) for the active session cwd; the union of every connection's set drives the shared `gitWatchRegistry`'s one poller per cwd.
- **Terminal grouping** — terminals group by normalized cwd, survive session switches, cleaned up after 10 min cold (ADR-003).
- **projectKey** — a derived one-way render/identity token from `shared/project-key.ts`; both engines' sessions for one cwd group under one sidebar project (ADR-025).

## cli.js integration

Everything about the wire — message shapes, control subtypes, MCP hosting, cancellation, the build pipeline, patches — is in **[`docs/protocol/`](../protocol/README.md)**. Consult it before theorizing, and before touching `src/core/sdk/`, `scripts/extract-cli.mjs`, or `patch/`. cli.js itself is ~13 MB minified: use the `/bundle-analyzer` skill to navigate it (find by string literals, never by minified names).
