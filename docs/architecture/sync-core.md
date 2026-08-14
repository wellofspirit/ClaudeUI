# SyncCore — target sync architecture

Part of [architecture/](README.md). **Status:** design accepted 2026-08-13 (ADR-051, ADR-053; security companion [security.md](security.md) / ADR-052). Phases 0-3 landed 2026-08-14; **phases 4a-4b landed, and 4c's transport half landed** (SyncCore + emission funnel + shared reducer; canonical state is the `sync-full` state of record; the desktop renderer is a MessagePort subscriber and the delivery privilege is deleted) — phase status at the bottom. Until the remaining phases land, [remote.md](remote.md) describes the running system, and [sync-channels.md](sync-channels.md) is the per-channel classification.

**Design intent (owner):** every interaction's effect is an event broadcast to all clients equally; the backend (non-UI) maintains the event store and the state; a reconnecting client replays from its last seq or receives a full state sync; no client is privileged. SyncCore realizes that design and extends it to headless operation and remote terminals. **Single-operator is a standing assumption** — one human, many devices; multi-user is a non-goal.

## Goals / non-goals

**Goals:** one authoritative state in the main process; desktop renderer demoted to client #1; identical protocol and client library for every client; reliable cross-client queue with Claude-Code-parity take-back UX; remote terminal; headless Linux server as a first-class deployment; attributable, auditable remote actions.

**Non-goals:** multi-user access control; a persistent (disk) event log; CRDT/offline-first merging; optimistic UI everywhere (opt-in per command only).

## Topology

```
src/core        — SyncCore + engine adapters + PTY manager + HTTP/WS server + web bundle.
                  NO Electron imports (lint/dep-rule enforced, not convention).
desktop shell   — Electron app: boots core in-process, hosts the renderer, provides
                  host-local surfaces (window controls, native pickers, voice, OAuth browser).
                  The renderer connects to core as client #1 over a MessagePort transport.
claudeui-server — headless entrypoint (bun) booting core alone: systemd unit, config by
                  files/env, `tailscale serve` in front for TLS + identity (ADR-039/042 stack).
```

**Headless rescope (4a).** The physical `src/core` extraction and the `claudeui-server`
entrypoint are a **named follow-on phase**, not part of phase 4. Phase 4's exit is a
**windowless-Electron smoke test** — the app boots, syncs and serves with no
`BrowserWindow` — which is what actually proves "a hung or absent renderer never
degrades sync"; moving files proves nothing on its own and would collide with 4b/4c's
edits to the very modules involved. The Electron-free constraint is enforced NOW,
by lint, on `src/main/sync/**` and `src/shared/sync/**` (the future `src/core`), so
the extraction stays a move rather than a rewrite. The vendor-OAuth-on-a-browserless-
server design session moves with that follow-on phase, since it only becomes
answerable once there is a server to provision.

A hung or absent renderer must never degrade sync (before 4b it silently yielded an empty snapshot). **As of 4b no snapshot path touches a window** — `handleSync` and the `/sent-file` allowlist both read canonical state in-process. What 4d still owes is the other direction: proving the app BOOTS and serves with no `BrowserWindow` at all, so "no window exists" is a tested mode rather than an inference.

## The four wire contracts (closed set)

Every feature must express each interaction as exactly one of these. There is no fifth path; direct `webContents.send` for replicated state is forbidden once phase 4 lands.

1. **Commands** (client → core): `{cmdId, type, payload}`. Schema-validated, capability-checked ([security.md](security.md)), identity-attached, audited. Executed against engines/services; acked with `{ok, seqs?, error}`. Commands never mutate client state — not even the originator's.
2. **Domain events** (core → all clients): `{seq, type, sessionId?, payload, causedBy?}`. The **only** way replicated state changes. Order: append to log → apply to canonical state → broadcast — so any snapshot taken at seq N provably contains every event through N (kills the as-built watermark race).

   **Wire encoding (as realized in 4a).** Contract 2 is transported as `{seq, channel, args}` — the as-built frame shape, kept byte-identical so no client needed a change. The mapping: `channel ≡ type`, and session scoping is **positional** (`args[0]` is the routing id for every session-scoped channel, which is what `BaseSession.send` has always sent) rather than a named `sessionId` field. `causedBy` is **not** added yet: it exists for optimistic-apply reconciliation, and nothing opts into optimistic apply until that lands, so adding the field now would be an unused wire change. `src/shared/sync/channels.ts` is the closed, fail-closed set of legal `channel` values.
3. **Volatile streams** (core → subscribers): streaming text/thinking deltas, PTY bytes, background bash output, log batches. Subscription-scoped, **never logged** — a delta stream is fully summarized by its accumulation, which lives in canonical state, so replay is pointless and buffer-poisoning (as-built, stream deltas flush the ring and force sync-fulls). Frames carry `{streamId, turnId, offset, chunk}`; a client whose local length ≠ offset refetches the coalesced value and continues — the snapshot↔stream seam is self-healing by construction.
4. **Queries** (client ↔ core, RPC): reads — history loads, git reads, catalogs, directory listings. No state effects.

## Replication model

- **Shared reducer:** a pure `applyEvent(state, event)` in `src/shared/sync/`, used by core (canonical) and by every client replica. One interpretation of every event; snapshot/event divergence becomes unrepresentable.
- **Canonical state in core:** per-session domain state + app-level registry. Per-session eviction mirrors today's renderer eviction; evicted sessions rehydrate from transcripts via queries.
- **Client stores split:** a *replica store* (reducer output only — no local writes) and a *view store* (selection, drafts, layout, scroll — per-client by design; ADR-041's lesson, now type-enforced).
- **Cursor discipline:** `lastSeq` advances only after an event is **applied**; pre-mount events buffer; a detected gap requests resync. `sync`/`sync-catchup`/`sync-full` + per-process `epoch` semantics carry over unchanged from the as-built protocol.
- **Ring sizing:** domain events only (streams excluded) — 5000 entries ≈ hours of catchup instead of minutes. Memory-only (see Persistence).
- **Optimistic apply:** opt-in per command via `causedBy` reconcile; the default is round-trip (in-process for desktop, tailnet-RTT for phones — both fine).

## State classification

| Class | Contents | Mechanism |
| ----- | -------- | --------- |
| **Replicated** | messages, coalesced streaming text/thinking, status, approvals, todos, **queue items**, tasks, sentFiles, per-session config (`selectedModel`, `effort`, `thinkingMode`, `reasoningVariant`, `permissionMode`, engine), session registry, pins/titles/hidden, settings, sessionEngines, worktree map, git status summaries | Domain events + snapshot |
| **Per-client** | active session selection, draft text/attachments, panel layout, scroll, gallery state | View store; never synced (deliberate — ADR-041) |
| **Host-local** | window controls, native folder picker, voice capture, OAuth browser flows | `host`-capability commands, desktop shell only |

Per-channel classification of every event, with its ring/canonical/delivery
consequences: [sync-channels.md](sync-channels.md).

### Clients never compute state

Any computation whose **output is state** runs in the shared reducer or in core.
Client-side computation is legitimate in exactly two places:

1. **Per-client view state** (ADR-041) — selection, drafts, layout, scroll. The
   ADR-053 take-back's `\n` join belongs here: its output is the draft.
2. **Render-time presentation** recomputed from the replica and never stored — e.g.
   `deriveWorktreeName` turning a path into a label.

**Litmus:** *if this client crashed and resynced from a snapshot, would anything it
computed be lost?* Yes ⇒ core/reducer. No ⇒ presentation. Derive-and-render is fine;
derive-and-**store** is banned outside the reducer, which is what 4c's type-brand +
lint enforce. Derived per-session state (`todos`, `sentFiles`) moved inside
`applyEvent` in 4a for exactly this reason; the surviving violation —
`useClaudeEvents` parsing a tool result into `worktreeInfoMap` — is recorded in
[sync-channels.md](sync-channels.md) §"Client-written state".

## Queue subsystem — Claude Code parity (owner-ratified 2026-08-13)

**Behavioral spec: identical to Claude Code CLI.** Messages sent while the agent runs are *queued*; they inject at the agent's **next sub-turn boundary** (after the in-flight tool call), steering the remainder of the current turn; **ArrowUp takes back all not-yet-consumed items** into the input for editing, joined with `\n`. Queueing is live feedback on the agent's output — **hold-until-idle was explicitly rejected** (it breaks the primary workflow), as was a separate "hold for next turn" affordance (v1 YAGNI).

**Storage: itemized, never a blob.** Canonical state holds `queue: {itemId, text, attachments, state: queued|consumed|recalled}[]` per session. The `\n` join happens **at take-back time in the client** — same gesture and convenience as the as-built blob, without its failure mode (the blob could never text-match a single engine queue item, so dequeue always missed with 2+ items queued). `queued`/`consumed`/`recalled` are domain events; every client converges, including the honest race outcome ("2 of 3 taken back; 1 already consumed"). The as-built running→idle fallback consume is deleted — transitions are event-driven only (ADR-038 discipline applied to the queue).

**Per-engine mechanics** (uniform events, per-engine transports — ADR-030 honesty):

- **claude** — push into cli.js's native queue immediately (native sub-turn timing, zero added latency). Core correlates per-item by text via the existing `dequeue_message` / `queued_command_consumed` patch surface — **no patch growth**; duplicate-text items are interchangeable, so text ambiguity is harmless.
- **opencode / pi** — these engines commit-on-post (coalesce/steer; unrecallable instantly), so core **holds the item and forwards at the next observed tool/step boundary** in the engine's event stream. The commitment point moves from keypress to boundary — up to one tool-call of extra latency versus today's instant post, ratified as the price of a real take-back window and cross-engine consistency.

Details and supersessions: ADR-053.

## Terminal subsystem

- **PTY manager lives in core** (it already owns node-pty); terminals named per cwd; **multi-attach** — desktop and remote clients can view the same live PTY, tmux-style — with a server-side scrollback ring (~200KB) so late attach renders history.
- PTY bytes ride the volatile-stream lane with backpressure (pause the PTY on a slow consumer, or drop + resnapshot from the scrollback ring).
- Terminal **lifecycle** (spawned/attached/detached/exited, with client identity) goes in the event log and the audit log; PTY content and keystrokes are never logged.
- Gating — `shell` capability, desktop-side opt-in, step-up ceremony, idle grant decay: [security.md](security.md). Supersedes the audit-era `terminal:*` denylist and ADR-048's terminal-on-mobile decline (via ADR-052).

## Client library

One `sync-client` library, two transports: MessagePort/IPC (desktop renderer) and WebSocket+E2E (web). **Landed in 4c** — `src/shared/sync/client-registry.ts` is the single subscription surface, typed by `src/shared/sync/events.ts` (`SyncEventMap`), and both entry points install their transport's `SyncClient` in it before React mounts.

What that replaced: ~45 `ClaudeAPI.onFoo(cb)` members implemented TWICE — by the preload with `ipcRenderer.on` and by `api-adapter` with `connection.on`. ADR-008's typecheck could compare only the signatures, so "parity" meant two implementations that agreed about types. The signatures moved into `SyncEventMap`; the `api-adapter` mirror survives for the **invoke** surface only (untouched by 4c), and the preload's per-channel surface shrank to host-local channels plus `acquireSyncPort`.

**Port hand-off mechanics.** A `MessagePort` is not a type `contextBridge` can marshal, so the preload takes delivery from `ipcRenderer.on('sync-port')` and forwards it into the main world with `window.postMessage(tag, '*', [port])` — the transfer path Electron's own message-ports guide prescribes. The renderer installs its `message` listener first and then calls `acquireSyncPort()`, so the preload holds the port until asked: main posts it on `did-finish-load`, which can precede the renderer bundle finishing evaluation.

## Persistence

- **No durable event log** — deliberate. The epoch is per-process, so a restart forces sync-full regardless; making a persisted log useful would require atomically persisting canonical state with it (a durability tax with ~no user value, since conversations are already durable in engine transcripts and config in the DB/files). Canonical state rebuilds on boot from transcripts + config, exactly as the renderer does today.
- **Durable additions:** the append-only **audit log** ([security.md](security.md)) and the WebAuthn credential table.

## Headless specifics

- `src/core` must not import Electron (lint-enforced); desktop-only behavior hangs off a host-adapter interface.
- **Admin:** server config primarily by files (systemd-friendly); an optional `admin` capability grant for a web client behind step-up; first-boot enrollment via a console-printed one-time URL. The as-built "desktop-only channels" concept is replaced by the `admin`/`host` capabilities — a headless deployment has no desktop.
- **Open item (deferred by owner until implementation):** vendor OAuth provisioning on a browserless server — direction is vault sync from a desktop enrollment (ADR-036) and/or device-code flows where vendors support them. Gets its own design session before phase-4 completion.

## Migration phases

| # | Content | Size | Exit criteria | Status |
| - | ------- | ---- | ------------- | ------ |
| 0 | Unified `sync-client` (two transports); ack-based `lastSeq`; pre-mount buffering | S | No event dropped while acked, provable by test | **landed** (`bf6aa1b`, 2026-08-14) |
| 1 | Command registry: schemas, capabilities, per-connection identity, audit log | M | Every mutating channel registered with a declared capability; fail-closed test | **landed** (`48b4f72`, 2026-08-14) — plugin channels ride `config` pending plugin-declared capabilities; `automation:*`/`log-viewer:*` not yet ported |
| 2 | **Terminal** (PTY manager, multi-attach, step-up, audit) | M | Shell usable from web behind opt-in + step-up | **landed** (`0e60c7e`, 2026-08-14) — step-up = password proof (passkeys follow), available over the cloudflared tunnel too: the ceremony gates on credential existence, not transport (the proof rides the mandatory E2E channel; its salt/KDF come from `terminal:availability`, since auth-info advertises no password there); mobile terminal layout is a follow-up |
| 3 | Queue-of-record: itemized queue, CC-parity take-back, boundary-held forwarding for opencode/pi | M | Ghost-message repros from the 2026-08-13 review pass | **landed** (`1349ec9`, 2026-08-14) — claude turn-end race closed by treating cli.js's `result` as a queue-flush boundary (everything still queued is marked consumed in one broadcast; accepted micro-race: a recall in flight at that exact instant) |
| 4 | Canonical state in core + shared reducer + in-process snapshots; desktop renderer becomes client #1; no `BrowserWindow`-required sync paths | **L** | Snapshot invariant test (seq N ⊇ events ≤ N); app runs with no window (windowless-Electron smoke) | **4a + 4b landed** — invariant test green; see below |
| 5 | Volatile-stream separation + per-client subscriptions | M | Reconnect after 10-min background catches up without sync-full | not started |

Phase 4 lands as a strangler in four stages:

| Stage | Content | Status |
| - | ------- | ------ |
| 4a | SyncCore module (ring + canonical state + one emission funnel), shared reducer, channel classification, `session:config-changed`, metering in the snapshot, rekey ownership in core, shadow harness, no-Electron lint fence | **landed** — canonical state runs in SHADOW; the renderer snapshot is still the state of record |
| 4b | Snapshot cutover: `SyncCore.getSnapshot()` is the `sync-full` source; `EventLog` deleted; event-carried user identity + emitter-timed thinking spans; canonical directories/boot seeds; snapshot-invariant test | **landed** — `__getRemoteState` itself survives as the SHADOW comparator's input only (4c deletes it with the store rewiring) |
| 4c | Renderer rewiring: MessagePort transport, store split (replica vs view), delivery privilege deleted, `extraWindows` + the `notifyMainWindow` asymmetry deleted | **transport + delivery landed**; reducer adoption (store split) NOT started — see below |
| 4d | Windowless smoke, sent-file inversion | not started |

**Exit-criteria precision.** Defect 2 (privileged desktop renderer) has two halves and
they died in different stages: **4b** killed the *state-of-record* half (a hung or absent
renderer can no longer yield an empty snapshot — the sync answer reads canonical state
synchronously and touches no window), and **4c** killed the *delivery privilege* half.
4a intentionally changed neither: it preserved today's delivery targets verbatim so the
funnel could be reviewed as a pure refactor. **Defect 2 is now fully dead.**

### 4c as landed: the transport half, not the reducer half

4c was specified as one stage with two independent halves. The **transport + delivery**
half landed; the **reducer adoption** half did not, and the split is deliberate — the
second half rewrites ~3,700 lines of store, ~630 lines of `useClaudeEvents` and ~14,000
lines of tests that assert on store actions, and a half-applied version of it is worse
than none.

**Landed:**

- **The desktop renderer is client #1.** `services/sync-port.ts` gives it a
  `MessagePortMain` on every load and answers its `sync` frames; the renderer
  (`renderer/src/sync/desktop-transport.ts`) feeds the phase-0 `SyncClient` verbatim, so
  it inherits the cursor, the epoch, gap detection and the pre-mount buffer that phases 0
  and 4b built for phones. It hydrates from `sync-full` at boot — which means a RELOAD now
  recovers live session state instead of rebuilding from disk.
- **Delivery follows the channel's CLASS, and nothing else.** `host-local` → the owning
  window by targeted send; everything else → every subscriber. `Delivery.target`, the
  per-channel `delivery` column, `extraWindows` / `addExtraSink`, `BaseSession`'s static
  extras accessors, the fake-`BrowserWindow` `RemoteBridge` and `notifyMainWindow` are all
  deleted. `BaseSession.send` no longer names a window at all.
- **One subscription surface for both clients** — see §"Client library".
- **The emitters stopped needing windows.** `AutomationManager`, `UsageFetcher`,
  `BlockUsageService`, `session-watcher`, `ui-config`'s watcher and the projects watcher
  all held a `BrowserWindow` purely to pass to `emitEvent`; those fields and the
  `setWindow` methods are gone. That is the concrete prerequisite 4d's windowless smoke
  test needs.

**NOT landed (the reducer half):**

- `useClaudeEvents` still interprets each replicated channel with its own handler, and the
  store still owns ~40 direct writers of replicated slices. `applyEvent` and the renderer
  remain two interpretations of one stream, so the **shadow comparator survives** (it was
  slated to retire here) along with `__getRemoteState` / `getRemoteStateSnapshot` and the
  parity e2e that consumes them.
- The §3 round-trip items that only make sense once the reducer owns the field:
  `sendPrompt`'s local user-message mint, the permission-mode optimistic write + revert,
  the renderer's own thinking-span clock, the `worktreeInfoMap` tool-result parser (the
  one surviving client-computation violation), and the client-side `session:rekey` invoke.
- The type-brand + lint rule sealing replicated slices, and deleting the store actions
  the reducer subsumes.

**One thing 4c's delivery change fixed that was not on anyone's list.** `VoiceClient` was
raising the REPLICATED `voice:error` through a targeted `webContents.send` on a computed
channel, which the funnel guard's channel-literal scan could not see. Under uniform
delivery the desktop subscribes to that channel, so the targeted send would have landed
nowhere and voice errors would have gone silent. Routed through `emitEvent`, and the guard
grew a check for computed-channel sends whose allowlist has to prove itself host-local.

**What 4b had to fix before it could flip (canonical freshness).** A snapshot built from
the event stream is only as complete as the stream. Four snapshot fields had no event
behind them, and the renderer had been covering for that by reading them itself during
hydration:

- **`directories`** — a query result (`session:directories-changed` is a payload-less
  "refetch now"). Core now holds it: refreshed at boot and on that same watcher trigger
  via `SyncCore.setDirectories`. It is no longer client-written.
- **`settings`, the session registry (`recentSessionIds`/`pinnedSessionIds`/
  `customTitles`/`worktreeInfoMap`/`hiddenSessions`/`hiddenProjects`/`sessionEngines`),
  `autoModeDisabledBySettings`, `slashCommands`** — files every client used to read for
  itself. `services/sync-seed.ts` seeds them from the same readers the renderer store
  uses, at the same point in boot. Without it, a phone connecting to a freshly-booted
  desktop got an empty sidebar, default theme and no recents until the first config save
  of the session happened to fire a watcher.
- **User-message `id`/`timestamp`** — minted by `sendPrompt` into the event payload, so
  every replica agrees on the transcript's ids instead of inventing its own.
- **Thinking-span `durationMs`** — timed by the emitter (`BaseSession.send` stamps
  `ChatMessage.thinkingDurationMs` on the sealing message; the reducer moves it onto the
  block). The reducer stays clock-free, which is what makes replay-equals-live true.

Seeds are **not** events: they are refreshes of query-shaped state
(`SyncCore.setAppState`), so nothing enters the ring and nothing is broadcast — no
client's state changes, because every client either read the file itself or will receive
it in its next snapshot.

**The invariant that certifies the cutover.** `restore(snapshot@N) + fold(events N+1 …
head) === canonical@head`, over seeded random interleavings drawn from the committed
golden fixtures (`src/main/sync/__tests__/snapshot-invariant.unit.test.ts`). It replaces
the deleted `event-log.test.ts`, which pinned a workaround rather than a property: the old
snapshot came from an async renderer round-trip, so the server deliberately UNDER-claimed
the watermark; `getSnapshot()` reads the seq and serializes in one synchronous tick, so
the claim is exact and the race is unrepresentable. `shared/sync/state.ts` gained
`fromSnapshot` (the restore half, and 4c's client-replica hydration path) and
`reducer.ts` gained `auxFromCanonical` — the open-thinking-span flag is not on the wire
but IS derivable from `streamingThinking`, so a client restored mid-span still recognises
the next text delta as a seal.

Interim relief (no longer optional — landed in 4a): `session:config-changed` + a
pre-spawn echo for model/effort/thinking/reasoning-variant, mirroring the
permission-mode pattern.

## Relations

Supersedes in part: ADR-041 (desktop-renderer snapshot + resync merge → replaced by main-canonical replication), ADR-043 ("renderer store is the single source of truth; main stays a pure relay" → inverted; the sent-file mechanism itself remains until phase 4). Implements the remedies for review.md's remote findings (snapshot watermark race, drop-before-mount, structural-not-semantic parity). Companions: [security.md](security.md), [remote.md](remote.md) (as-built record), ADR-051/052/053.
