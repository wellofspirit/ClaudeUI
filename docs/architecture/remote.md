# Remote-access layer — as built

Part of [architecture/](README.md). **Status:** this documents the system as it exists today. Its replacement design is [sync-core.md](sync-core.md) (ADR-051); until those phases land, this file is the accurate record. Findings below come from the 2026-08-13 sync-drift review.

## Components

| Piece | File | Role |
| ----- | ---- | ---- |
| Remote server | `src/main/services/remote-server.ts` | HTTP + WS listener; auth (ADR-039/042), E2E (tunnel), mockup/sent-file routes (ADR-007/043) |
| Dispatcher | `src/main/services/remote-dispatcher.ts` | Routes WS `invoke` frames to the same handler functions as desktop IPC; **denylist** (`BLOCKED`) removes desktop-only channels |
| WS broadcaster | inside `remote-server.ts` | A plain funnel SUBSCRIBER since phase 4c: `addSyncSubscriber((seq, channel, args) => broadcast(...))`, registered on `start()` and dropped on `stop()`. It broadcasts the ring's own seq and never re-numbers. `remote-bridge.ts` — the fake `BrowserWindow` this used to be, complete with a `deliverSequenced` method the delivery adapter sniffed for structurally — is **deleted** |
| Event log | `src/main/sync/event-ring.ts` | In-memory ring buffer (5000 entries) with monotonic `seq` + per-process `epoch`; serves `sync-catchup`. Owned by `SyncCore` (`src/main/sync/sync-core.ts`), whose `emit()` is its ONLY writer — phase 4a. (`services/event-log.ts`, the renderer-snapshot pull, was deleted by 4b) |
| Canonical state | `src/main/sync/sync-core.ts` + `src/shared/sync/{reducer,state}.ts` | The `sync-full` state of record since phase 4b: `emit()` applies every replicated event through the shared reducer, and `getSnapshot()` serializes it with an exact watermark. File/query-sourced fields are seeded by `services/sync-seed.ts` |
| Web client | `src/web/` (`connection.ts`, `api-adapter.ts`, `main.tsx`) | Dynamically imports the renderer's own `App`/stores. `api-adapter` is a hand-maintained `ClaudeAPI` mirror (typechecked per ADR-008) for the **invoke** surface only — its ~45 replicated-event subscriptions were deleted in 4c; both clients now subscribe through `shared/sync/client-registry` |
| Desktop transport | `src/main/services/sync-port.ts` + `src/renderer/src/sync/desktop-transport.ts` | Phase 4c: the desktop renderer is client #1 over a `MessagePortMain` pair, speaking the same four frames as a WS client. One channel per renderer LOAD; the subscriber is registered only once the first `sync` has been answered, in the same tick |

## Wire protocol (`src/shared/remote-protocol.ts`)

- `invoke` / `invoke-response` — client actions, **RPC mirroring `ipcRenderer.invoke`**.
- `event {seq, channel, args}` — server pushes, **mirroring `webContents.send`**.
- `sync {lastSeq, epoch}` → `sync-catchup {events}` or `sync-full {state}` — reconnect protocol. The snapshot is **canonical state in the main process** (`SyncCore.getSnapshot()`), serialized in the same synchronous tick its `seq` is read; phase 4b replaced the `executeJavaScript('window.__getRemoteState()')` pull of the desktop renderer's Zustand store. The frame shape did not change, so no client needed an edit.
- **The same four frames now carry the DESKTOP renderer** (phase 4c), over a MessagePort instead of a WebSocket and with no auth frames — the port is the trust. The full/catchup branching lives in `shared/sync/sync-decision.ts` so the two transports cannot answer one `sync` differently; the WS-only additions (`mockupToken`, `fileToken`) stay in `remote-server`, because they exist to build URLs a browser will fetch.

## The architecture in one paragraph

Remote clients are RPC callers plus consumers of a *mirror of main→desktop-renderer IPC traffic*. Client actions never enter the event stream themselves; only whatever side effects a handler emits become events — though as of phase 4a they all go through ONE funnel (`emitEvent`) against a closed, fail-closed channel table, so "wired into the fan-out" is no longer a per-call-site accident.

**Phase 4b changed the sentence that used to matter most here, and 4c changed the framing.** The desktop renderer is no longer the state of record (4b: snapshots are canonical state in the main process), and as of 4c it is no longer a privileged delivery target either: it subscribes over a MessagePort with a cursor, an epoch and gap detection, exactly like a phone. "Mirror of main→desktop-renderer IPC traffic" is therefore no longer the right description of what a remote client consumes — there is one fan-out, and the desktop is one of its subscribers.

What 4c did NOT do: the renderer's Zustand store is still its own hand-written replica of the event stream rather than a consumer of the shared reducer, so `useClaudeEvents` and `applyEvent` remain two interpretations of the same events, and the shadow comparator still earns its keep. The registry-config mutations (pins, titles, recents, `sessionEngines`, settings) also still write the store optimistically before saving — though the save's echo now reaches the writer, so it is corrected rather than merely unopposed. Both belong to the reducer-adoption half of 4c.

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
> **Phase 4c closes defect 5 the rest of the way.** 4a funneled the emissions but
> preserved their TARGETS, so ~20 channels were still main-window-only and a few
> deliberately skipped the desktop. Delivery is now a function of the channel's
> CLASS: `host-local` reaches the owning window by targeted send, everything else
> reaches every subscriber, and no call site can choose. The `delivery` column, the
> `extras-only` literal and the `notifyMainWindow` flag are all gone, along with the
> two "catchup leak" sites (`session:auth-source`, `mockup:file-changed`) that rang
> but could not be received live.
>
> **Phase 4b** closes the *state-of-record* half of **defect 2**: `sync-full` is
> `SyncCore.getSnapshot()`, `services/event-log.ts` is deleted, and no snapshot path
> touches a `BrowserWindow` — so a busy, hung or absent renderer can no longer answer
> a reconnecting client with an empty state. It also closes defect 3 structurally
> (the watermark is exact, not under-claimed, because seq capture and serialization
> share one synchronous tick) and moves the two reducer-purity gaps into the
> emitter: user-message identity and thinking-span durations now ride the event.
> The comparator survives with its roles inverted — it validates the RENDERER's
> replica against authoritative canonical until 4c retires that replica.
>
> **Phase 4c closes the delivery-privilege half of defect 2.** The desktop renderer
> is a `MessagePort` subscriber with a cursor and an epoch; the extra-window registry,
> the fake-`BrowserWindow` remote bridge, `BaseSession`'s static extras accessors and
> the `notifyMainWindow` asymmetry are deleted. **Defect 2 is now fully dead.** One
> consequence is a real improvement nobody asked for: a desktop RELOAD (F5, a dev
> hot-reload) now rehydrates from `sync-full` instead of rebuilding from disk, because
> a reload is just a client reconnecting.
>
> The other 4c half — the renderer adopting the shared reducer — is NOT done; see the
> paragraph above and sync-core.md's stage table.

1. **Interactions are RPCs, not events.** Whether other clients learn of a mutation depends on the handler: `sendPrompt` fans out; `dequeueMessage` broadcasts nothing (`handlers-core.ts`); `set-model`/`set-effort`/`set-thinking-mode` emit nothing any client maps back into picker state; `setPermissionMode` is the only per-session config with a full bidirectional path.
2. **Privileged desktop renderer.** Snapshot = `window.__getRemoteState()`; a busy/hung/missing renderer silently yields an **empty** snapshot; a remote client's own state (model pick, queued display) is clobbered by the desktop's ignorance on resync (ADR-041 merge: snapshot wins per known session). — *FULLY FIXED: state-of-record half in 4b (canonical snapshots), delivery-privilege half in 4c (the desktop is a subscriber, not a target). `__getRemoteState` survives only as the dev shadow comparator's input.*
3. **Snapshot seq race** (review.md, confirmed): `getFullState()` stamps `seq` after the async renderer round-trip, so an event appended mid-round-trip is inside the watermark but absent from the state — permanently skipped by the client. — *FIXED: phase 0 under-claimed it, 4b made it exact by construction.*
4. **Fire-and-forget event apply:** `api-adapter` drops events with no registered listener while `connection.ts` still advances `lastSeq` — events arriving before React mounts (every phone foreground) are acked but never applied.
5. **Opt-in fan-out:** ~20 channels are main-window-only (`voice:*`, `auth:state`, `account:changed`, `remote:status`, `log-viewer:*`, …), some with dead listeners registered on the web side; `pushNonSessionEvent` has no production callers. No invariant enforces "state change ⇒ event"; the parity test checks channel names, not semantics. — *FIXED in 4a (one fail-closed funnel) and 4c (delivery follows class, so "main-window-only" is now exactly the host-local set and nothing else can be). The remaining true statement is the last one: nothing enforces "state change ⇒ event" — `canonical: false` rows in [sync-channels.md](sync-channels.md) record where a channel reaches clients live but vanishes on resync.*
6. **Queue ghosts:** the queued-message display is a `\n`-joined string per session; dequeue matches by full text against cli.js's per-item queue (no item ids), so with 2+ queued items removal always misses (`removed: 0`) — and the UI clears anyway, leaving invisible messages that execute later. Dequeue is never broadcast; queue state is absent from the snapshot. See ADR-053 for the replacement design.

## What stays through the migration

The transport/auth hardening is unaffected by the SyncCore rebuild and carries forward: token/password/tailnet-identity modes, Host allowlist, throttling, funnel reject (ADR-039), pinned tailscale HTTPS port (ADR-042), tunnel E2E, and the scoped mockup/sent-file tokens (ADR-007/043). The auth *policy* layer on top changes per [security.md](security.md) / ADR-052.
