# SyncCore — target sync architecture

Part of [architecture/](README.md). **Status:** design accepted 2026-08-13 (ADR-051, ADR-053; security companion [security.md](security.md) / ADR-052). Implementation not started — phase status at the bottom. Until phases land, [remote.md](remote.md) describes the running system.

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

A hung or absent renderer must never degrade sync (today it silently yields an empty snapshot): after phase 4 no snapshot path touches a window, and "no window exists" is a tested mode, not an edge case.

## The four wire contracts (closed set)

Every feature must express each interaction as exactly one of these. There is no fifth path; direct `webContents.send` for replicated state is forbidden once phase 4 lands.

1. **Commands** (client → core): `{cmdId, type, payload}`. Schema-validated, capability-checked ([security.md](security.md)), identity-attached, audited. Executed against engines/services; acked with `{ok, seqs?, error}`. Commands never mutate client state — not even the originator's.
2. **Domain events** (core → all clients): `{seq, type, sessionId?, payload, causedBy?}`. The **only** way replicated state changes. Order: append to log → apply to canonical state → broadcast — so any snapshot taken at seq N provably contains every event through N (kills the as-built watermark race).
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

One `sync-client` library, two transports: MessagePort/IPC (desktop renderer) and WebSocket+E2E (web). Parity is by construction — the hand-maintained `api-adapter` mirror is retired; ADR-008's typecheck remains as a belt. The preload surface shrinks to the transport plus host-local commands.

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
| 2 | **Terminal** (PTY manager, multi-attach, step-up, audit) | M | Shell usable from web behind opt-in + step-up | in progress — step-up via password proof; passkeys follow (security.md fallback path) |
| 3 | Queue-of-record: itemized queue, CC-parity take-back, boundary-held forwarding for opencode/pi | M | Ghost-message repros from the 2026-08-13 review pass | **landed** (`1349ec9`, 2026-08-14) — residual: claude turn-end race where a push lands after `result` (item stays on card while its text runs; close honestly by treating claude's `result` as queue-flush, needs a decision) |
| 4 | Canonical state in core + shared reducer + in-process snapshots; desktop renderer becomes client #1; no `BrowserWindow`-required sync paths | **L** | Snapshot invariant test (seq N ⊇ events ≤ N); app runs with no window (headless smoke) | not started |
| 5 | Volatile-stream separation + per-client subscriptions | M | Reconnect after 10-min background catches up without sync-full | not started |

Interim relief (optional, absorbed by phase 4): a `session:config-changed` event + pre-spawn echo for model/effort/thinking, mirroring the permission-mode pattern, if per-session-config drift needs fixing before phase 4 lands.

## Relations

Supersedes in part: ADR-041 (desktop-renderer snapshot + resync merge → replaced by main-canonical replication), ADR-043 ("renderer store is the single source of truth; main stays a pure relay" → inverted; the sent-file mechanism itself remains until phase 4). Implements the remedies for review.md's remote findings (snapshot watermark race, drop-before-mount, structural-not-semantic parity). Companions: [security.md](security.md), [remote.md](remote.md) (as-built record), ADR-051/052/053.
