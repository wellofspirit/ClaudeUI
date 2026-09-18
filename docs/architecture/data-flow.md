# IPC & data flow

Part of [architecture/](README.md).

## IPC & data flow

- Main ↔ renderer via `contextBridge` + `ipcMain.handle`/`webContents.send`; typed `ClaudeAPI` in `shared/types.ts`, exposed as `window.api`.
- `safeHandler()` wraps handlers in `{ ok, data, error }` envelopes; `unwrap()` in preload throws on failure.
- The same handlers serve WebSocket clients through `remote-dispatcher` (desktop-only channels blocklisted); shared handler bodies live in `ipc/handlers-core.ts`. The remote layer's full shape (and its known defects): [remote.md](remote.md).
- `session:send` is fire-and-forget; results stream back as events:

```
User prompt → InputBox → window.api.sendPrompt (IPC)
  → session.run(prompt) → engine backend
    → stream_event   → session:item-open       → applyItemLifecycle()   (reliable: block scaffold)
                     → session:item-delta      → applyItemStreamFrame() (volatile: one chunk)
                     → session:item-seal       → applyItemLifecycle()   (reliable: final content)
    → assistant      → session:message         → applyEvent() (upsert by ID)
    → user (tool_result) → session:tool-result → applyEvent()
    → can_use_tool   → session:approval-request → applyEvent()
    → result         → session:result           (cost tracking)
```

The three item channels are the per-item volatile lane that replaced the session
text/thinking buffers on 2026-09-17 ([design](../per-item-streaming-design.md)).
`session:item-open` and `session:item-seal` are ordinary ringed events; only
`session:item-delta` leaves the event system, and it carries one chunk rather than
a growing body. All three folds live in `core/shared/sync/item-stream.ts` and run
in core and in every replica. The accumulated value stays in canonical
`itemStreams` and is combined with the transcript at render time by
`overlayItemStreams()` — no client stores a second transcript. Every other arrow
above lands in the shared reducer (`core/shared/sync/reducer.ts`); the per-channel
store actions this diagram used to name were deleted in SyncCore phase 4c.

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

Everything about the wire — message shapes, control subtypes, MCP hosting, cancellation, the build pipeline, patches — is in **[`docs/protocol-cc/`](../protocol/README.md)**. Consult it before theorizing, and before touching `src/core/sdk/`, `scripts/extract-cli.mjs`, or `patch/`. cli.js itself is ~13 MB minified: use the `/bundle-analyzer` skill to navigate it (find by string literals, never by minified names).
