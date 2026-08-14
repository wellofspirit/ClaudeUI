# Remote-access layer — as built

Part of [architecture/](README.md). **Status:** this documents the system as it exists today. Its replacement design is [sync-core.md](sync-core.md) (ADR-051); until those phases land, this file is the accurate record. Findings below come from the 2026-08-13 sync-drift review.

## Components

| Piece | File | Role |
| ----- | ---- | ---- |
| Remote server | `src/main/services/remote-server.ts` | HTTP + WS listener; auth (ADR-039/042), E2E (tunnel), mockup/sent-file routes (ADR-007/043) |
| Dispatcher | `src/main/services/remote-dispatcher.ts` | Routes WS `invoke` frames to the same handler functions as desktop IPC; **denylist** (`BLOCKED`) removes desktop-only channels |
| Bridge | `src/main/services/remote-bridge.ts` | A fake `BrowserWindow` registered as an extra sink; the funnel hands it `(seq, channel, args)` via `deliverSequenced` and it broadcasts THAT seq — it no longer appends (one emission ⇒ one ring entry). Its legacy `webContents.send` shim is wired to a loud no-op |
| Event log | `src/main/sync/event-ring.ts` | In-memory ring buffer (5000 entries) with monotonic `seq` + per-process `epoch`; serves `sync-catchup`. Owned by `SyncCore` (`src/main/sync/sync-core.ts`), whose `emit()` is its ONLY writer — phase 4a. `services/event-log.ts` is now just the renderer-snapshot pull, pending 4b |
| Web client | `src/web/` (`connection.ts`, `api-adapter.ts`, `main.tsx`) | Dynamically imports the renderer's own `App`/stores; `api-adapter` is a hand-maintained `ClaudeAPI` mirror (typechecked per ADR-008) |

## Wire protocol (`src/shared/remote-protocol.ts`)

- `invoke` / `invoke-response` — client actions, **RPC mirroring `ipcRenderer.invoke`**.
- `event {seq, channel, args}` — server pushes, **mirroring `webContents.send`**.
- `sync {lastSeq, epoch}` → `sync-catchup {events}` or `sync-full {state}` — reconnect protocol. The snapshot is pulled from the **desktop renderer's Zustand store** via `executeJavaScript('window.__getRemoteState()')`.

## The architecture in one paragraph

Remote clients are RPC callers plus consumers of a *mirror of main→desktop-renderer IPC traffic*. Client actions never enter the event stream themselves; only whatever `webContents.send` side effects a handler happens to emit become events, and only for channels wired into the fan-out (`BaseSession.send` or explicit `getExtraWindows()` loops). The desktop renderer is not a subscriber of the event stream — it *is* the state of record: full-state snapshots are its Zustand store, so state it does not know about is erased from remote clients at their next sync-full. This is an IPC mirror with a privileged desktop client, not the event-sourced hub the layer was originally designed to be.

## Known structural defects (2026-08-13 review)

> **Status update (2026-08-14):** defects 3 and 4 are fixed by SyncCore phase 0
> (`bf6aa1b` — snapshot watermark under-claims; events buffer until the app
> mounts, `lastSeq` advances only after dispatch). Defect 6 is fixed by phase 3
> (`1349ec9` — itemized queue of record per ADR-053).
>
> **Phase 4a** closes **defect 5**: every emission now goes through ONE funnel
> (`emitEvent` → ring → `applyEvent` → delivery, `src/main/services/sync-host.ts`),
> the hand-rolled `getExtraWindows()` loops are gone, and every channel is
> classified with its ring/canonical/delivery consequences in
> [sync-channels.md](sync-channels.md) — fail-closed, so an unclassified channel is
> refused rather than silently desktop-only. `pushNonSessionEvent` is a funnel
> delegation. 4a also closes the per-session-config half of **defect 1** (a new
> replicated `session:config-changed`) and the metering resync hole.
>
> **Defect 2 still stands as-built:** canonical state runs in SHADOW in 4a, so
> `sync-full` is still `window.__getRemoteState()`. Its two halves die separately —
> the state-of-record half in 4b, the delivery-privilege half in 4c (see
> sync-core.md's stage table). What 4a does add is a comparator that proves the two
> interpretations agree before the switch.

1. **Interactions are RPCs, not events.** Whether other clients learn of a mutation depends on the handler: `sendPrompt` fans out; `dequeueMessage` broadcasts nothing (`handlers-core.ts`); `set-model`/`set-effort`/`set-thinking-mode` emit nothing any client maps back into picker state; `setPermissionMode` is the only per-session config with a full bidirectional path.
2. **Privileged desktop renderer.** Snapshot = `window.__getRemoteState()`; a busy/hung/missing renderer silently yields an **empty** snapshot; a remote client's own state (model pick, queued display) is clobbered by the desktop's ignorance on resync (ADR-041 merge: snapshot wins per known session).
3. **Snapshot seq race** (review.md, confirmed): `getFullState()` stamps `seq` after the async renderer round-trip, so an event appended mid-round-trip is inside the watermark but absent from the state — permanently skipped by the client.
4. **Fire-and-forget event apply:** `api-adapter` drops events with no registered listener while `connection.ts` still advances `lastSeq` — events arriving before React mounts (every phone foreground) are acked but never applied.
5. **Opt-in fan-out:** ~20 channels are main-window-only (`voice:*`, `auth:state`, `account:changed`, `remote:status`, `log-viewer:*`, …), some with dead listeners registered on the web side; `pushNonSessionEvent` has no production callers. No invariant enforces "state change ⇒ event"; the parity test checks channel names, not semantics.
6. **Queue ghosts:** the queued-message display is a `\n`-joined string per session; dequeue matches by full text against cli.js's per-item queue (no item ids), so with 2+ queued items removal always misses (`removed: 0`) — and the UI clears anyway, leaving invisible messages that execute later. Dequeue is never broadcast; queue state is absent from the snapshot. See ADR-053 for the replacement design.

## What stays through the migration

The transport/auth hardening is unaffected by the SyncCore rebuild and carries forward: token/password/tailnet-identity modes, Host allowlist, throttling, funnel reject (ADR-039), pinned tailscale HTTPS port (ADR-042), tunnel E2E, and the scoped mockup/sent-file tokens (ADR-007/043). The auth *policy* layer on top changes per [security.md](security.md) / ADR-052.
