# SyncCore — sync architecture

Part of [architecture/](README.md). **Status:** design accepted 2026-08-13 (ADR-051, ADR-053; security companion [security.md](security.md) / ADR-052). **Phases 0-4 are landed** (2026-08-14); phase 5 (volatile-stream separation) and the named follow-on phase are not started — phase status at the bottom, ledger in [§Follow-ons](#follow-ons). [sync-channels.md](sync-channels.md) is the per-channel classification; [remote.md](remote.md) is now the transport + auth as-built record (the sync architecture is this file).

**Phase 4 complete (4a → 4d).** Canonical state in the main process is the state of
record: one emission funnel appends every domain event to the ring and applies it
through the shared reducer before any client sees it, `sync-full` is
`SyncCore.getSnapshot()` read in one synchronous tick, and the desktop renderer is
client #1 on a MessagePort — folding the same `applyEvent`, holding no delivery
privilege, with no `BrowserWindow` anywhere on a snapshot or delivery path. 4d
finished it from the other end: core boots before any window decision
(`src/main/boot-core.ts`), a session's `win` is a nullable HOST handle rather than a
requirement, and `CLAUDEUI_NO_WINDOW=1` runs the app with no window at all — seeding
canonical state, serving `sync-full`, spawning sessions and streaming events to
WebSocket clients, proven end to end by
`src/e2e/flows/windowless-boot.e2e.test.ts`. Defect 2 (the privileged desktop
renderer) is dead in both halves, and "no window exists" is a tested mode.

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

**Headless rescope (4a), as realized in 4d.** The physical `src/core` extraction and
the `claudeui-server` entrypoint are a **named follow-on phase**, not part of phase 4.
Phase 4's exit was a **windowless-Electron smoke test** — the app boots, syncs and
serves with no `BrowserWindow` — which is what actually proves "a hung or absent
renderer never degrades sync"; moving files proves nothing on its own and would have
collided with 4b/4c's edits to the very modules involved. The Electron-free constraint
is enforced by lint on `src/main/sync/**` and `src/shared/sync/**` (the future
`src/core`), so the extraction stays a move rather than a rewrite. The
vendor-OAuth-on-a-browserless-server design session moves with that follow-on phase,
since it only becomes answerable once there is a server to provision.

**The boot order is what 4d actually changed.** `bootCore()` (`src/main/boot-core.ts`)
runs from `app.whenReady()` BEFORE any window decision and owns everything
window-independent: `registerSessionIpc()` (sessions, config, git, usage, the canonical
seeds, the file watchers), `registerTerminalIpc()`, the automation manager, and the
remote HTTP+WS server with its autostart. `createWindow()` is now purely ADDITIVE —
the `MessagePort` hand-off, the host-local delivery target, window chrome, plugins, the
log viewer — and `CLAUDEUI_NO_WINDOW=1` skips it entirely. The rule that keeps this
true: **nothing on the boot path may CAPTURE a window.** Whatever genuinely needs one
reads it from `services/host-window.ts` at USE time and copes with `null` — the
`host-local` delivery lane, `session:pick-folder`'s dialog parent, and the spawn handle
a session keeps for voice capture. Two signatures lost their window parameter for this
(`registerSessionIpc`, `registerRemoteHandlers`); `BaseSession.win` became
`BrowserWindow | null`.

A hung or absent renderer must never degrade sync (before 4b it silently yielded an
empty snapshot). **As of 4b no snapshot path touches a window** — `handleSync` and the
`/sent-file` allowlist both read canonical state in-process. **As of 4d no BOOT path
needs one either**, and the smoke test asserts it the only way that means anything: it
counts `BrowserWindow` constructions across a whole flow (boot → `sync-full` →
`session:create` → prompt → streamed deltas → mid-turn queue → take-back, all driven by
a WebSocket client) and requires zero.

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
derive-and-**store** is banned outside the reducer. Derived per-session state
(`todos`, `sentFiles`) moved inside `applyEvent` in 4a for exactly this reason, and
the last surviving violation — `useClaudeEvents` parsing an `EnterWorktree` tool
result into `worktreeInfoMap` — moved to the main process in 4c
(`services/worktree-detect.ts`, observed at the funnel).

**Enforced, as of 4c, rather than documented.** `renderer/src/stores/sealed-fields.ts`
names the SEALED set — exactly the snapshot-carried fields, so it is derived rather
than chosen — and an ESLint `no-restricted-syntax` rule rejects a `set(...)` writing
one of them anywhere but `renderer/src/stores/replica.ts`. `sealed-fields.unit.test.ts`
pins the lint pattern against both the list and `FullStateSnapshot`, so adding a
snapshot field without sealing it fails a test rather than quietly opening a hole.
The complement is deliberate and equally named: channels classified
`canonical: false` have no snapshot field to fold into, so they keep their
per-channel listeners and their store writers.

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
| 4 | Canonical state in core + shared reducer + in-process snapshots; desktop renderer becomes client #1; no `BrowserWindow`-required sync paths | **L** | Snapshot invariant test (seq N ⊇ events ≤ N); app runs with no window (windowless-Electron smoke) | **landed** — all four stages; invariant test green, windowless smoke green (`windowless-boot.e2e.test.ts`) |
| 5 | Volatile-stream separation + per-client subscriptions | M | Reconnect after 10-min background catches up without sync-full | not started |

Phase 4 lands as a strangler in four stages:

| Stage | Content | Status |
| - | ------- | ------ |
| 4a | SyncCore module (ring + canonical state + one emission funnel), shared reducer, channel classification, `session:config-changed`, metering in the snapshot, rekey ownership in core, shadow harness, no-Electron lint fence | **landed** — canonical state runs in SHADOW; the renderer snapshot is still the state of record |
| 4b | Snapshot cutover: `SyncCore.getSnapshot()` is the `sync-full` source; `EventLog` deleted; event-carried user identity + emitter-timed thinking spans; canonical directories/boot seeds; snapshot-invariant test | **landed** — `__getRemoteState` survived as the SHADOW comparator's input until 4c's store rewiring deleted both |
| 4c | Renderer rewiring: MessagePort transport, store split (replica vs view), delivery privilege deleted, `extraWindows` + the `notifyMainWindow` asymmetry deleted | **landed in full** — transport + delivery first, then reducer adoption; see below |
| 4d | Window-independent boot (`bootCore`), nullable session host handle, `CLAUDEUI_NO_WINDOW`, windowless smoke, sent-file inversion confirmed, docs closeout | **landed** — see the boot-order note above; the sent-file inversion was landed by 4b and 4d only confirmed it (ADR-043's note is accurate: the `/sent-file` allowlist reads `SyncCore.getSnapshot()` in-process, asserted by the funnel guard) |

**Exit-criteria precision.** Defect 2 (privileged desktop renderer) has two halves and
they died in different stages: **4b** killed the *state-of-record* half (a hung or absent
renderer can no longer yield an empty snapshot — the sync answer reads canonical state
synchronously and touches no window), and **4c** killed the *delivery privilege* half.
4a intentionally changed neither: it preserved today's delivery targets verbatim so the
funnel could be reviewed as a pure refactor. **Defect 2 is now fully dead.**

### 4c as landed, in two parts

4c was specified as one stage with two independent halves, and they landed
separately on purpose: the second rewrites ~3,700 lines of store, ~630 lines of
`useClaudeEvents` and the test suites that assert on store actions, and a
half-applied version of it is worse than none.

**Part 1 — transport + delivery:**

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

**Part 2 — the store folds the shared reducer.** `renderer/src/stores/replica.ts`
holds a real `CanonicalState` plus the reducer's aux, folds `applyEvent` over a new
channel-agnostic tap on the client (`SyncClient.onAnyEvent`, dispatched after the
per-channel emit with the cursor already advanced), and projects the result into
Zustand in one `set()`. Consequences:

- **~40 store actions are deleted**, and with them `useClaudeEvents`'s per-channel
  interpretation of every replicated channel. What survives in the hook is the
  three things a reducer cannot own: the `canonical: false` transient channels, the
  host-local ones, and the SIDE-EFFECT halves of the old handlers (notifications,
  attention marks, the disk load a resumed `session:created` triggers, the
  custom-command re-scan) re-attached as **post-apply observers**.
- **The projection is identity-diffed.** `applyEvent` is persistent, so a
  `session:stream` delta rebuilds one session entry and writes nothing app-level.
  Without the diff every event would re-write `settings`, the registry config and
  every session, so any in-flight local write would be reverted by the next
  unrelated delta and every subscriber would re-render on every token.
- **Sealed vs view is one function, not two stores.** `projectSession` writes only
  the sealed fields; drafts, panels, git-panel state, toasts, `isHistorical`,
  `evicted` and `needsAttention` are per-client and untouched. That IS the store
  split ADR-051 asks for — kept in one merged `PerSessionState` so the ~200
  components reading `useActiveSession(...)` did not all have to change.
- **Three ways in, and only three:** the fold; hydration (`fromSnapshot` +
  `auxFromCanonical` + the ADR-041 selection resolution, replacing
  `applyRemoteSnapshot`); and a small named set of **sanctioned local writes** for
  state that is genuinely client-originated — a session created before it spawns
  (its engine/model/mode exist nowhere else), cold history read from disk, the
  desktop's own boot read of the config files, and the renderer's heap-bounding
  eviction. Each writes CANONICAL and re-projects, which is what keeps
  "store ≡ projection of canonical" true after every one of them.
- **The rekey is the reducer's.** `rekeySession`, the bounded `rekeyMap` and
  `resolveRoutingId` are deleted, along with the client's `session:rekey` invoke:
  core re-keys its own registry in the same tick it emits the `session:status` that
  implies one, so every later event already carries the new id. The replica computes
  the same target with the shared `rekeyTargetFor` so it can carry the session's
  VIEW state to the new key and retire the old one — the split-brain the deleted
  action existed to avoid. The main-side `session:rekey` shim stays for cached phone
  bundles.
- **Round-trip, not optimism, where an event exists.** The permission-mode
  optimistic write and its `.catch` revert are gone (every path emits
  `session:permission-mode`, including the reverted mode an engine chose); the
  renderer's parallel thinking clock is gone (`thinkingDurationMs` /
  `pendingThinkingDurationMs` deleted — durations arrive on the block, and
  `thinkingStartedAt` survives as a projection-derived presentation ticker); the
  local user-message mint is gone.
- **The shadow comparator is retired**, with `main/sync/shadow.ts`,
  `CLIENT_WRITTEN_FIELDS`, `startShadowWatch`, the `CLAUDEUI_SYNC_SHADOW` flag,
  `getRemoteStateSnapshot` and `window.__getRemoteState`. It measured the gap
  between two implementations of one contract; there is one implementation now, so
  it has nothing to measure. Its value moved into
  `e2e/flows/sync-hydration-parity.e2e.test.ts`, which asserts the property that
  actually matters after the cutover: a client that re-hydrates from
  `core.getSnapshot()` holds exactly what a client that watched the whole stream
  holds — the client-side half of the phase-4 snapshot invariant.
- **The last client-computation violation moved to main.** `worktreeInfoMap` is no
  longer parsed out of a tool result in the renderer: `services/worktree-detect.ts`
  does it once, observed at the funnel's delivery point (where canonical already
  carries the tool_result attached to its tool_use, so the `EnterWorktree` gate
  checks real state), and persists through the ordinary `config:sessions-changed`
  save.

**One thing 4c's delivery change fixed that was not on anyone's list.** `VoiceClient` was
raising the REPLICATED `voice:error` through a targeted `webContents.send` on a computed
channel, which the funnel guard's channel-literal scan could not see. Under uniform
delivery the desktop subscribes to that channel, so the targeted send would have landed
nowhere and voice errors would have gone silent. Routed through `emitEvent`, and the guard
grew a check for computed-channel sends whose allowlist has to prove itself host-local.

**A defect the seal exposed on the way in.** `BaseSession.trackThinkingSpan` cleared
only the OPEN clock at a turn boundary, never an already-parked `sealedThinkingMs`;
a span sealed by a text delta whose message never arrived (interrupt, refusal
retraction, engine death) leaked its elapsed time onto the NEXT turn's first thinking
block. 4b left it deliberately — the renderer's `pendingThinkingDurationMs` leaked the
same value the same way, so the two sides agreed and the comparator stayed quiet. With
the renderer's clock deleted there is no mirror to preserve, and the leak is fixed.

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

**One deviation from the 4c plan, recorded rather than hidden.** The plan said the
registry-config mutations (pins / titles / hidden / recents / `sessionEngines` /
settings) should become invoke-only, updating the replica solely from the `config:*`
echo. They ARE replica-owned — the seal holds, nothing else writes them — but they
apply locally first and then persist, because `saveSessionConfig` merges from current
state: with no local apply, two rapid mutations would both merge from a stale base and
the second would revert the first until its echo arrived. The echo is a whole-config
replace, so re-applying it is a no-op for the writer and authoritative for everyone
else. Making these true commands with `causedBy` reconciliation is the follow-up, and
it belongs with the generic `command()` migration rather than with the store split.
`causedBy` itself is still unbuilt — the designed escape hatch if the honest
round-trip ever feels slow from a phone, and an owner call after living with it.

## Follow-ons

Everything phase 4 deliberately left, recorded at the point it stopped being a
plan and became a decision. Nothing here is a defect in the landed design; each
line is a named next step with the reason it is not phase-4 work.

**The named follow-on phase** (was "headless", rescoped in 4a):

- **Physical `src/core` extraction** — move `src/main/sync/**` + `src/shared/sync/**`
  (and the engine adapters, PTY manager and HTTP/WS server) to `src/core`. A MOVE, not
  a rewrite: the Electron-free lint fence already holds on both trees, and 4d made the
  boot order expressible (`bootCore()` is what a second entrypoint would call).
- **`claudeui-server` (bun) entrypoint** — systemd unit, config by files/env,
  `tailscale serve` in front. `bootCore()` still imports Electron (`ipcMain`, `app`);
  the seam to break is the desktop IPC transport adapter, not the services behind it.
- **Vendor OAuth on a browserless server** — direction is vault sync from a desktop
  enrollment (ADR-036) and/or device-code flows. Only answerable once there is a server
  to provision, which is why it moves with this phase.

**Phase 5** — volatile-stream separation and per-client subscriptions: stream/PTY/log
frames leave the ring entirely (`{streamId, turnId, offset, chunk}` with self-healing
refetch), so a 10-minute background reconnect catches up without a `sync-full`.

**Command-registry completeness** (the `command()` migration, ADR-051 contract 1):

- **Registry-config mutations are invoke-only and apply locally first** (pins, titles,
  recents, `sessionEngines`, settings). They ARE replica-owned, but `saveSessionConfig`
  merges from current state, so a pure round-trip would let two rapid mutations revert
  each other. Making them real commands with `causedBy` reconciliation is the fix; see
  the 4c deviation note above. **`causedBy` itself is still unbuilt** — the designed
  escape hatch if the honest round-trip ever feels slow from a phone, and an owner call
  after living with it.
- **`automation:*` and `log-viewer:*` are not ported** to the registry: they register
  through bare `ipcMain.handle` (`ipc/automation.ipc.ts`, `services/log-viewer.ts`), so
  they get no capability check and no audit row, and they are unreachable remotely.
- **`app:version-info` never reaches the remote dispatcher.**
  `registerRemoteVersionInfo()` no-ops unless `registerRemoteHandlers()` has already
  run, and the bootstrap computes the build versions BEFORE core boots — so the web
  client's Settings dialog cannot read the server's versions. Pre-existing (4d's
  reordering neither fixed nor worsened it); the desktop half is also a bare
  `ipcMain.handle`, outside the registry. A three-line ordering fix, deliberately not
  taken inside 4d's scope.
- **Plugin channels ride the `config` capability** pending plugin-declared capabilities
  (phase 1 note).

**Replication gaps recorded rather than closed:**

- **The desktop's effort / thinking-mode / reasoning-variant picks are client-local.**
  `session-store`'s `setEffort` / `setThinkingMode` / `setReasoningVariant` call
  `patchLocalSession` with no IPC: the desktop picker RESTARTS the session and the
  respawn carries the value, so between the pick and the respawn that value's only home
  is the client that made it — canonical (and therefore every remote client) does not
  see it. Main-side setters exist (`session:set-effort`, `session:set-thinking-mode`)
  and the pre-spawn `session:config-changed` echo exists; wiring the desktop picker to
  them is the remaining half.
- **A zero-session `sync-full` cannot carry `slashCommands` / `sdkSkillNames`.**
  `SyncCore.setAppState` seeds them app-level at boot, but `FullStateSnapshot` has no
  app-level field — `toSnapshot` fans the one list into every PER-SESSION entry — so a
  client that connects before any session exists receives neither. Surfaced concretely
  by 4d's windowless smoke (which asserts the seed against canonical instead). Closing
  it is a wire change, which phase 4 excluded by its non-goals.
- **`session:rekey` survives as a main-side no-op shim** for phone bundles cached before
  4c stopped clients from invoking it. Removable once those are no longer a concern.

**Test-infrastructure debt:**

- **`mirrorStoreIntoReplica`** (`src/test/helpers/replica-seed.ts`) exists so pre-4c
  fixtures that `setState` the store directly stay consistent with the replica's
  canonical mirror. Every such fixture should seed canonical and let the projection run;
  the helper can then go.

## Relations

Supersedes in part: ADR-041 (desktop-renderer snapshot + resync merge → replaced by main-canonical replication), ADR-043 ("renderer store is the single source of truth; main stays a pure relay" → inverted; the sent-file mechanism itself remains until phase 4). Implements the remedies for review.md's remote findings (snapshot watermark race, drop-before-mount, structural-not-semantic parity). Companions: [security.md](security.md), [remote.md](remote.md) (as-built record), ADR-051/052/053.
